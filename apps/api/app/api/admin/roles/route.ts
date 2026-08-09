import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { getDb, teamRoles } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationExceptionResult,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  getDefaultPermissionsForRole,
  requirePermission,
} from "@/lib/permissions";
import { validateAssignableTeamPermissions } from "@/lib/team-permission-input";
import {
  isBuiltInTeamRoleSlug,
  isTeamRoleSlugUniqueViolation,
  isValidTeamRoleSlug,
  normalizeTeamRoleSlug,
} from "@/lib/team-role-input";
import { isAdminRequest } from "../../web/admin";

const ROLE_CREATE_MAXIMUM_BYTES = 16 * 1024;
const ROLE_CREATE_DEADLINE_MS = 5_000;
const ROLE_CREATE_KEYS = ["name", "permissions", "slug"] as const;

type RoleCreateInput = {
  name: string;
  slug: string;
  permissions: string[];
};

type CreatedRoleData = {
  role: {
    id: string;
    name: string;
    slug: string;
    permissions: string[];
    createdAt: string;
    updatedAt: string;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    sortedExpected.every((key, index) => actual[index] === key)
  );
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function roleCreateInputFailure(error: unknown): TeamMutationFailure {
  if (!(error instanceof BoundedJsonRequestError)) {
    return error instanceof TeamMutationFailure
      ? error
      : new TeamMutationFailure(
          "invalid",
          "The role creation payload is invalid.",
        );
  }
  if (error.code === "body_timeout") {
    return new TeamMutationFailure(
      "timeout",
      "The role creation body timed out before it could be validated.",
      { retryable: true },
    );
  }
  return new TeamMutationFailure("invalid", error.message, {
    status: error.status === 413 ? 413 : 422,
    fieldErrors: { body: "Send one complete JSON role definition." },
  });
}

function parseRoleCreateInput(value: unknown): RoleCreateInput {
  const payload = record(value);
  if (!payload || !exactKeys(payload, ROLE_CREATE_KEYS)) {
    throw new TeamMutationFailure(
      "invalid",
      "Send exactly one complete role definition.",
      {
        fieldErrors: {
          body: "Name, slug, and permissions are required; unsupported fields are not accepted.",
        },
      },
    );
  }

  const name =
    typeof payload["name"] === "string"
      ? payload["name"].normalize("NFKC").trim()
      : "";
  if (name.length < 1 || name.length > 120 || containsControlCharacter(name)) {
    throw new TeamMutationFailure("invalid", "Enter a valid role name.", {
      fieldErrors: {
        name: "Use 1–120 visible characters without control characters.",
      },
    });
  }

  const slug =
    typeof payload["slug"] === "string"
      ? normalizeTeamRoleSlug(payload["slug"].normalize("NFKC"))
      : "";
  if (!isValidTeamRoleSlug(slug)) {
    throw new TeamMutationFailure(
      "invalid",
      "Role slug must be 2–64 characters, start with a letter, and use only lowercase letters, numbers, underscores, or hyphens.",
      {
        fieldErrors: {
          slug: "Use 2–64 lowercase letters, numbers, underscores, or hyphens.",
        },
      },
    );
  }
  if (isBuiltInTeamRoleSlug(slug)) {
    throw new TeamMutationFailure(
      "conflict",
      "This role slug is reserved for a built-in role.",
      { fieldErrors: { slug: "Choose a different custom-role slug." } },
    );
  }

  const rawPermissions = payload["permissions"];
  const validated = validateAssignableTeamPermissions(rawPermissions);
  if (!validated.ok) {
    throw new TeamMutationFailure(
      "invalid",
      validated.code === "permissions_must_be_an_array"
        ? "Permissions must be an array of supported permission names."
        : "One or more permissions cannot be assigned.",
      {
        fieldErrors: {
          permissions:
            validated.invalidEntries.length > 0
              ? `Unsupported: ${validated.invalidEntries.join(", ")}`
              : "Choose only supported role permissions.",
        },
      },
    );
  }
  if (
    !Array.isArray(rawPermissions) ||
    rawPermissions.length > 100 ||
    validated.permissions.length !== rawPermissions.length ||
    rawPermissions.some(
      (permission) =>
        typeof permission !== "string" || permission !== permission.trim(),
    )
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Role permissions must be one unique reviewed list.",
      {
        fieldErrors: {
          permissions:
            "Remove duplicate, padded, blank, or unsupported permissions.",
        },
      },
    );
  }

  return { name, slug, permissions: [...validated.permissions].sort() };
}

const DEFAULT_ROLES = [
  {
    name: "Owner",
    slug: "owner",
    permissions: getDefaultPermissionsForRole("owner"),
  },
  {
    name: "Office",
    slug: "office",
    permissions: getDefaultPermissionsForRole("office"),
  },
  {
    name: "Sales",
    slug: "sales",
    permissions: getDefaultPermissionsForRole("sales"),
  },
  {
    name: "Crew",
    slug: "crew",
    permissions: getDefaultPermissionsForRole("crew"),
  },
  {
    name: "Read-only",
    slug: "read_only",
    permissions: getDefaultPermissionsForRole("read_only"),
  },
];

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const db = getDb();
  const rows = await db
    .select({
      id: teamRoles.id,
      name: teamRoles.name,
      slug: teamRoles.slug,
      permissions: teamRoles.permissions,
      createdAt: teamRoles.createdAt,
      updatedAt: teamRoles.updatedAt,
    })
    .from(teamRoles)
    .orderBy(asc(teamRoles.name));

  const roles = rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    permissions: row.permissions ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  return NextResponse.json({ roles });
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["access.manage"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "role.created",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let input: RoleCreateInput;
  try {
    input = parseRoleCreateInput(
      await readBoundedJsonRequest(request, {
        maximumBytes: ROLE_CREATE_MAXIMUM_BYTES,
        deadlineMs: ROLE_CREATE_DEADLINE_MS,
        rejectDuplicateObjectKeys: true,
      }),
    );
  } catch (error) {
    const failure = roleCreateInputFailure(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "team_role",
      code: failure.code,
      metadata: { boundary: "input" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/roles",
      entityType: "team_role_slug",
      entityId: input.slug,
      payload: input,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      await tx
        .insert(teamRoles)
        .values(
          DEFAULT_ROLES.map((defaultRole) => ({
            name: defaultRole.name,
            slug: defaultRole.slug,
            permissions: defaultRole.permissions,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        )
        .onConflictDoNothing({ target: teamRoles.slug });

      const [created] = await tx
        .insert(teamRoles)
        .values({
          name: input.name,
          slug: input.slug,
          permissions: input.permissions,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      if (!created) {
        throw new TeamMutationFailure(
          "internal",
          "The role could not be created. Try again.",
          { retryable: true },
        );
      }

      const version = created.updatedAt.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "team_role",
        entityId: created.id,
        after: {
          activeMemberCount: 0,
          permissionCount: created.permissions.length,
          version,
        },
        metadata: { permissionCount: created.permissions.length },
        committedAt: created.updatedAt,
      });
      const data: CreatedRoleData = {
        role: {
          id: created.id,
          name: created.name,
          slug: created.slug,
          permissions: created.permissions,
          createdAt: created.createdAt.toISOString(),
          updatedAt: version,
        },
      };
      const mutationResult = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "team_role",
        entityId: created.id,
        version,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        201,
        created.updatedAt,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(
      result as MutationResult<CreatedRoleData>,
      201,
      mutation.correlationId,
      {
        "Cache-Control": "private, no-store, max-age=0",
        ETag: `"${result.receipt.version}"`,
      },
    );
  } catch (error) {
    const operationError = isTeamRoleSlugUniqueViolation(error)
      ? new TeamMutationFailure(
          "conflict",
          "Another role already uses that slug.",
          { fieldErrors: { slug: "Choose a unique role slug." } },
        )
      : error;
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        operationError,
      ).catch(() => undefined);
    }
    const failure = teamMutationExceptionResult(operationError);
    await recordTeamMutationFailure(mutation, {
      entityType: "team_role",
      code: failure.result.code,
      metadata: { boundary: "operation" },
    });
    return teamMutationExceptionResponse(operationError, mutation);
  }
}
