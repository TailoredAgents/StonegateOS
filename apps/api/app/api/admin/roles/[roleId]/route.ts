import {
  TEAM_OWNER_ONLY_PERMISSION_CATALOG,
  type ActionPolicy,
  type MutationResult,
} from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, teamMembers, teamRoles, teamSessions } from "@/db";
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
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationExceptionResult,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  computeEffectivePermissions,
  permissionMatches,
} from "@/lib/permissions";
import { validateAssignableTeamPermissions } from "@/lib/team-permission-input";
import {
  isBuiltInTeamRoleSlug,
  isTeamRoleSlugUniqueViolation,
  isValidTeamRoleSlug,
  normalizeTeamRoleSlug,
} from "@/lib/team-role-input";
import {
  evaluateSelfAccessChange,
  isActiveOwner,
  TEAM_ACCESS_SAFETY_LOCK_KEY,
} from "@/lib/team-access-safety";

const ROLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLE_UPDATE_MAXIMUM_BYTES = 16 * 1024;
const ROLE_UPDATE_DEADLINE_MS = 5_000;
const ROLE_UPDATE_KEYS = [
  "expectedUpdatedAt",
  "name",
  "permissions",
  "slug",
] as const;

type RoleUpdateInput = {
  expectedUpdatedAt: string;
  name: string;
  slug: string;
  permissions: string[];
};

type UpdatedRoleData = {
  role: {
    id: string;
    name: string;
    slug: string;
    permissions: string[];
    createdAt: string;
    updatedAt: string;
  };
  assignedMemberCount: number;
  revokedSessionCount: number;
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
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  );
}

function exactInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function inputFailure(error: unknown): TeamMutationFailure {
  if (!(error instanceof BoundedJsonRequestError)) {
    return error instanceof TeamMutationFailure
      ? error
      : new TeamMutationFailure(
          "invalid",
          "The role update payload is invalid.",
        );
  }
  if (error.code === "body_timeout") {
    return new TeamMutationFailure(
      "timeout",
      "The role update body timed out before it could be validated.",
      { retryable: true },
    );
  }
  return new TeamMutationFailure("invalid", error.message, {
    fieldErrors: { body: "Send one complete JSON role update." },
  });
}

function parseRoleUpdateInput(
  value: unknown,
  expectedVersion: string | null,
): RoleUpdateInput {
  const payload = record(value);
  if (!payload || !exactKeys(payload, ROLE_UPDATE_KEYS)) {
    throw new TeamMutationFailure(
      "invalid",
      "Send exactly one complete role update.",
      {
        fieldErrors: {
          body: "Name, slug, permissions, and expectedUpdatedAt are required; unsupported fields are not accepted.",
        },
      },
    );
  }

  const expectedUpdatedAt = exactInstant(payload["expectedUpdatedAt"]);
  if (
    !expectedUpdatedAt ||
    expectedVersion === null ||
    expectedVersion === "*" ||
    expectedUpdatedAt !== expectedVersion
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The request must carry the exact role version in both If-Match and expectedUpdatedAt.",
      {
        fieldErrors: {
          version: "Refresh the role and submit its exact updatedAt value.",
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
      "Role permissions must be a unique reviewed list.",
      {
        fieldErrors: {
          permissions:
            "Remove duplicate, blank, padded, or unsupported permissions.",
        },
      },
    );
  }

  return {
    expectedUpdatedAt,
    name,
    slug,
    permissions: [...validated.permissions].sort(),
  };
}

function samePermissions(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((permission) => rightSet.has(permission));
}

function roleConflict(
  reason:
    | "active_owner_role_immutable"
    | "built_in_role_slug_immutable"
    | "cannot_remove_own_access"
    | "owner_role_requires_access_manage"
    | "reserved_role_slug"
    | "role_slug_already_exists"
    | "last_active_owner_required",
): TeamMutationFailure {
  switch (reason) {
    case "active_owner_role_immutable":
      return new TeamMutationFailure(
        "conflict",
        "The active Owner role cannot be renamed.",
        { fieldErrors: { slug: "Keep the Owner role slug unchanged." } },
      );
    case "built_in_role_slug_immutable":
      return new TeamMutationFailure(
        "conflict",
        "Built-in role slugs are permanent.",
        { fieldErrors: { slug: "Keep this built-in slug unchanged." } },
      );
    case "cannot_remove_own_access":
      return new TeamMutationFailure(
        "conflict",
        "This change would remove your own Access administration permission without another active Owner.",
        {
          fieldErrors: {
            permissions:
              "Transfer ownership or preserve access.manage before saving.",
          },
        },
      );
    case "owner_role_requires_access_manage":
      return new TeamMutationFailure(
        "conflict",
        "The Owner role must retain Access administration permission.",
        {
          fieldErrors: {
            permissions: "Keep access.manage enabled for the Owner role.",
          },
        },
      );
    case "reserved_role_slug":
      return new TeamMutationFailure(
        "conflict",
        "That slug is reserved for a built-in role.",
        { fieldErrors: { slug: "Choose a different custom-role slug." } },
      );
    case "role_slug_already_exists":
      return new TeamMutationFailure(
        "conflict",
        "Another role already uses that slug.",
        { fieldErrors: { slug: "Choose a unique role slug." } },
      );
    case "last_active_owner_required":
      return new TeamMutationFailure(
        "conflict",
        "At least one active team member must retain Access administration.",
        {
          fieldErrors: {
            permissions:
              "Add or promote another Access administrator before saving.",
          },
        },
      );
  }
}

function hasConstraint(error: unknown, constraint: string): boolean {
  const direct = record(error);
  const cause = direct ? record(direct["cause"]) : null;
  const candidate = cause ?? direct;
  return Boolean(
    candidate &&
      (candidate["constraint"] === constraint ||
        candidate["constraint_name"] === constraint ||
        (typeof candidate["message"] === "string" &&
          candidate["message"].includes(constraint))),
  );
}

function normalizeOperationError(error: unknown): unknown {
  if (isTeamRoleSlugUniqueViolation(error)) {
    return roleConflict("role_slug_already_exists");
  }
  if (hasConstraint(error, "team_access_continuity_requires_active_owner")) {
    return roleConflict("last_active_owner_required");
  }
  return error;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ roleId: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["access.manage"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "role.updated",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  // Params and request bytes are deliberately untouched until the complete
  // authorization, origin, kill-switch, idempotency, and version boundary.
  const { roleId } = await context.params;
  if (!ROLE_ID_PATTERN.test(roleId)) {
    const error = new TeamMutationFailure(
      "invalid",
      "Choose a valid role to update.",
      { fieldErrors: { roleId: "Select a valid role." } },
    );
    await recordTeamMutationFailure(mutation, {
      entityType: "team_role",
      code: error.code,
      metadata: { boundary: "role_id" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }

  let input: RoleUpdateInput;
  try {
    input = parseRoleUpdateInput(
      await readBoundedJsonRequest(request, {
        maximumBytes: ROLE_UPDATE_MAXIMUM_BYTES,
        deadlineMs: ROLE_UPDATE_DEADLINE_MS,
      }),
      mutation.expectedVersion,
    );
  } catch (error) {
    const failure = inputFailure(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "team_role",
      entityId: roleId,
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
      route: "PATCH /api/admin/roles/:roleId",
      entityType: "team_role",
      entityId: roleId,
      payload: input,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${TEAM_ACCESS_SAFETY_LOCK_KEY}))`,
      );

      const [currentRole] = await tx
        .select({
          id: teamRoles.id,
          name: teamRoles.name,
          slug: teamRoles.slug,
          permissions: teamRoles.permissions,
          createdAt: teamRoles.createdAt,
          updatedAt: teamRoles.updatedAt,
        })
        .from(teamRoles)
        .where(eq(teamRoles.id, roleId))
        .for("update")
        .limit(1);
      if (!currentRole) {
        throw new TeamMutationFailure(
          "invalid",
          "That role no longer exists. Refresh the role list.",
          { status: 404, fieldErrors: { roleId: "Role not found." } },
        );
      }
      assertTeamMutationExpectedVersion(mutation, currentRole.updatedAt);

      const slugChanged = input.slug !== currentRole.slug;
      const nextPermissions =
        normalizeTeamRoleSlug(currentRole.slug) === "owner"
          ? [
              ...new Set([
                ...input.permissions,
                ...TEAM_OWNER_ONLY_PERMISSION_CATALOG,
              ]),
            ].sort()
          : input.permissions;
      const permissionsChanged = !samePermissions(
        currentRole.permissions,
        nextPermissions,
      );
      const nameChanged = input.name !== currentRole.name;

      if (slugChanged && isBuiltInTeamRoleSlug(currentRole.slug)) {
        throw roleConflict("built_in_role_slug_immutable");
      }
      if (slugChanged && isBuiltInTeamRoleSlug(input.slug)) {
        throw roleConflict("reserved_role_slug");
      }
      if (
        normalizeTeamRoleSlug(currentRole.slug) === "owner" &&
        !nextPermissions.some((permission) =>
          permissionMatches(permission, "access.manage"),
        )
      ) {
        throw roleConflict("owner_role_requires_access_manage");
      }

      const roleMembers = await tx
        .select({
          id: teamMembers.id,
          active: teamMembers.active,
          permissionsGrant: teamMembers.permissionsGrant,
          permissionsDeny: teamMembers.permissionsDeny,
        })
        .from(teamMembers)
        .where(eq(teamMembers.roleId, roleId))
        .for("update");

      if (
        currentRole.slug.trim().toLowerCase() === "owner" &&
        input.slug.trim().toLowerCase() !== "owner" &&
        roleMembers.some((member) =>
          isActiveOwner({
            active: member.active ?? true,
            roleSlug: currentRole.slug,
            permissionsDeny: member.permissionsDeny,
          }),
        )
      ) {
        throw roleConflict("active_owner_role_immutable");
      }

      const actingMember = roleMembers.find(
        (member) => member.id === mutation.actor.id,
      );
      if (actingMember && (slugChanged || permissionsChanged)) {
        const nextEffectivePermissions = computeEffectivePermissions({
          rolePermissions: nextPermissions,
          grant: actingMember.permissionsGrant,
          deny: actingMember.permissionsDeny,
        });
        const retainsAccess = nextEffectivePermissions.some((permission) =>
          permissionMatches(permission, "access.manage"),
        );
        if (!retainsAccess) {
          const activeOwners = await tx
            .select({
              id: teamMembers.id,
              active: teamMembers.active,
              roleSlug: teamRoles.slug,
              permissionsDeny: teamMembers.permissionsDeny,
            })
            .from(teamMembers)
            .innerJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
            .where(
              and(
                eq(teamMembers.active, true),
                sql`lower(${teamRoles.slug}) = 'owner'`,
              ),
            )
            .for("update");
          const hasOtherOwner = activeOwners.some(
            (owner) =>
              owner.id !== mutation.actor.id &&
              isActiveOwner({
                active: owner.active ?? true,
                roleSlug: owner.roleSlug,
                permissionsDeny: owner.permissionsDeny,
              }),
          );
          const selfAccessConflict = evaluateSelfAccessChange({
            actorId: mutation.actor.id ?? "",
            memberId: actingMember.id,
            retainsAccess,
            hasOtherActiveOwner: hasOtherOwner,
          });
          if (selfAccessConflict) throw roleConflict(selfAccessConflict);
        }
      }

      const updatedAt = new Date(
        Math.max(Date.now(), currentRole.updatedAt.getTime() + 1),
      );
      const [role] = await tx
        .update(teamRoles)
        .set({
          name: input.name,
          slug: input.slug,
          permissions: nextPermissions,
          updatedAt,
        })
        .where(
          and(
            eq(teamRoles.id, roleId),
            eq(teamRoles.updatedAt, currentRole.updatedAt),
          ),
        )
        .returning({
          id: teamRoles.id,
          name: teamRoles.name,
          slug: teamRoles.slug,
          permissions: teamRoles.permissions,
          createdAt: teamRoles.createdAt,
          updatedAt: teamRoles.updatedAt,
        });
      if (!role) {
        throw new TeamMutationFailure(
          "conflict",
          "The role changed while it was being saved. Refresh and try again.",
          { retryable: true, fieldErrors: { version: "Refresh the role." } },
        );
      }

      let revokedSessionCount = 0;
      if (slugChanged || permissionsChanged) {
        const memberIds = roleMembers.map((member) => member.id);
        if (memberIds.length > 0) {
          const revoked = await tx
            .update(teamSessions)
            .set({ revokedAt: updatedAt })
            .where(
              and(
                inArray(teamSessions.teamMemberId, memberIds),
                isNull(teamSessions.revokedAt),
              ),
            )
            .returning({ id: teamSessions.id });
          revokedSessionCount = revoked.length;
        }
      }

      const changedFields = [
        ...(nameChanged ? ["name"] : []),
        ...(slugChanged ? ["slug"] : []),
        ...(permissionsChanged ? ["permissions"] : []),
      ];
      const version = role.updatedAt.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "team_role",
        entityId: role.id,
        before: {
          permissionCount: currentRole.permissions.length,
          version: currentRole.updatedAt.toISOString(),
        },
        after: {
          permissionCount: role.permissions.length,
          version,
          assignedMemberCount: roleMembers.length,
          revokedSessionCount,
        },
        metadata: {
          changedFields,
          assignedMemberCount: roleMembers.length,
          revokedSessionCount,
        },
        committedAt: role.updatedAt,
      });

      const data: UpdatedRoleData = {
        role: {
          id: role.id,
          name: role.name,
          slug: role.slug,
          permissions: role.permissions,
          createdAt: role.createdAt.toISOString(),
          updatedAt: version,
        },
        assignedMemberCount: roleMembers.length,
        revokedSessionCount,
      };
      const mutationResult = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "team_role",
        entityId: role.id,
        version,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
        role.updatedAt,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(
      result as MutationResult<UpdatedRoleData>,
      200,
      mutation.correlationId,
      {
        "Cache-Control": "private, no-store, max-age=0",
        ETag: `"${result.receipt.version}"`,
      },
    );
  } catch (error) {
    const operationError = normalizeOperationError(error);
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(
          db,
          mutation,
          claim,
          operationError,
        );
      } catch (settlementError) {
        console.error("[access-role-update] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    const failure = teamMutationExceptionResult(operationError);
    await recordTeamMutationFailure(mutation, {
      entityType: "team_role",
      entityId: roleId,
      code: failure.result.code,
      metadata: { boundary: "operation" },
    });
    return teamMutationExceptionResponse(operationError, mutation);
  }
}
