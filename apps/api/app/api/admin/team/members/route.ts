import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, policySettings, teamMembers, teamRoles } from "@/db";
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
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import {
  isTeamMemberEmailUniqueViolation,
  isTeamMemberPhoneUniqueViolation,
  normalizeTeamMemberEmail,
  normalizeTeamMemberPhoneE164,
} from "@/lib/team-member-identity";

const MEMBER_CREATE_MAXIMUM_BYTES = 16 * 1024;
const MEMBER_CREATE_DEADLINE_MS = 5_000;
const MEMBER_CREATE_ALLOWED_KEYS = new Set([
  "active",
  "email",
  "name",
  "phone",
  "roleId",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type MemberCreateInput = {
  name: string;
  email: string | null;
  phoneE164: string | null;
  roleId: string | null;
  active: boolean;
};

type CreatedMemberData = {
  member: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    roleId: string | null;
    active: boolean;
    createdAt: string;
    updatedAt: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function memberCreateInputFailure(error: unknown): TeamMutationFailure {
  if (!(error instanceof BoundedJsonRequestError)) {
    return error instanceof TeamMutationFailure
      ? error
      : new TeamMutationFailure(
          "invalid",
          "The team-member creation payload is invalid.",
        );
  }
  if (error.code === "body_timeout") {
    return new TeamMutationFailure(
      "timeout",
      "The team-member creation body timed out before it could be validated.",
      { retryable: true },
    );
  }
  return new TeamMutationFailure("invalid", error.message, {
    status: error.status === 413 ? 413 : 422,
    fieldErrors: { body: "Send one complete JSON team-member definition." },
  });
}

function parseMemberCreateInput(value: unknown): MemberCreateInput {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "Send one complete team-member definition.",
      { fieldErrors: { body: "A JSON object is required." } },
    );
  }
  if (
    !("name" in value) ||
    Object.keys(value).some((key) => !MEMBER_CREATE_ALLOWED_KEYS.has(key))
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The team-member definition is incomplete or contains unsupported fields.",
      {
        fieldErrors: {
          body: "Name is required; only active, email, phone, and roleId may accompany it.",
        },
      },
    );
  }

  const name =
    typeof value["name"] === "string"
      ? value["name"].normalize("NFKC").trim()
      : "";
  if (name.length < 1 || name.length > 120 || containsControlCharacter(name)) {
    throw new TeamMutationFailure("invalid", "Enter a valid member name.", {
      fieldErrors: {
        name: "Use 1–120 visible characters without control characters.",
      },
    });
  }

  const rawEmail = value["email"];
  if (
    rawEmail !== undefined &&
    rawEmail !== null &&
    typeof rawEmail !== "string"
  ) {
    throw new TeamMutationFailure("invalid", "Enter a valid email address.", {
      fieldErrors: { email: "Use a valid email address or leave it blank." },
    });
  }
  const email = normalizeTeamMemberEmail(rawEmail);
  if (
    email &&
    (email.length > 320 ||
      !EMAIL_PATTERN.test(email) ||
      containsControlCharacter(email))
  ) {
    throw new TeamMutationFailure("invalid", "Enter a valid email address.", {
      fieldErrors: { email: "Use a valid email address or leave it blank." },
    });
  }

  const rawPhone = value["phone"];
  if (
    rawPhone !== undefined &&
    rawPhone !== null &&
    typeof rawPhone !== "string"
  ) {
    throw new TeamMutationFailure("invalid", "Enter a valid phone number.", {
      fieldErrors: { phone: "Use a valid phone number or leave it blank." },
    });
  }
  const phoneE164 = normalizeTeamMemberPhoneE164(rawPhone);
  if (
    typeof rawPhone === "string" &&
    rawPhone.trim().length > 0 &&
    !phoneE164
  ) {
    throw new TeamMutationFailure("invalid", "Enter a valid phone number.", {
      fieldErrors: { phone: "Use a valid US or E.164 phone number." },
    });
  }

  const rawRoleId = value["roleId"];
  if (
    rawRoleId !== undefined &&
    rawRoleId !== null &&
    typeof rawRoleId !== "string"
  ) {
    throw new TeamMutationFailure("invalid", "Choose a valid role.", {
      fieldErrors: { roleId: "Choose a valid role or no role." },
    });
  }
  const roleId =
    typeof rawRoleId === "string" && rawRoleId.trim().length > 0
      ? rawRoleId.trim()
      : null;
  if (roleId && !UUID_PATTERN.test(roleId)) {
    throw new TeamMutationFailure("invalid", "Choose a valid role.", {
      fieldErrors: { roleId: "Choose a valid role or no role." },
    });
  }

  const rawActive = value["active"];
  if (rawActive !== undefined && typeof rawActive !== "boolean") {
    throw new TeamMutationFailure(
      "invalid",
      "Member activation must be true or false.",
      { fieldErrors: { active: "Choose an explicit activation state." } },
    );
  }

  return {
    name,
    email,
    phoneE164,
    roleId,
    active: rawActive === undefined ? true : rawActive,
  };
}

function extractPgCode(error: unknown): string | null {
  const direct = isRecord(error) ? error : null;
  const directCode =
    direct && typeof direct["code"] === "string" ? direct["code"] : null;
  if (directCode) return directCode;
  const cause = direct && isRecord(direct["cause"]) ? direct["cause"] : null;
  const causeCode =
    cause && typeof cause["code"] === "string" ? cause["code"] : null;
  return causeCode;
}

function readPhoneMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const phonesRaw = value["phones"];
  if (!isRecord(phonesRaw)) return {};
  const phones: Record<string, string> = {};
  for (const [key, raw] of Object.entries(phonesRaw)) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      phones[key] = raw.trim();
    }
  }
  return phones;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const db = getDb();
  const [phoneSetting] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, "team_member_phones"))
    .limit(1);
  const phoneMap = readPhoneMap(phoneSetting?.value);

  let rows: Array<{
    id: string;
    name: string;
    email: string | null;
    emailNormalized: string | null;
    emailIdentityStatus: string;
    phoneE164: string | null;
    roleId: string | null;
    defaultCrewSplitBps: number | null;
    fixedCrewJobRateBps: number | null;
    permissionsGrant?: string[] | null;
    permissionsDeny?: string[] | null;
    passwordHash?: string | null;
    active: boolean | null;
    createdAt: Date;
    updatedAt: Date;
    roleName: string | null;
    roleSlug: string | null;
  }> = [];

  try {
    rows = await db
      .select({
        id: teamMembers.id,
        name: teamMembers.name,
        email: teamMembers.email,
        emailNormalized: teamMembers.emailNormalized,
        emailIdentityStatus: teamMembers.emailIdentityStatus,
        phoneE164: teamMembers.phoneE164,
        roleId: teamMembers.roleId,
        defaultCrewSplitBps: teamMembers.defaultCrewSplitBps,
        fixedCrewJobRateBps: teamMembers.fixedCrewJobRateBps,
        permissionsGrant: teamMembers.permissionsGrant,
        permissionsDeny: teamMembers.permissionsDeny,
        passwordHash: teamMembers.passwordHash,
        active: teamMembers.active,
        createdAt: teamMembers.createdAt,
        updatedAt: teamMembers.updatedAt,
        roleName: teamRoles.name,
        roleSlug: teamRoles.slug,
      })
      .from(teamMembers)
      .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
      .orderBy(asc(teamMembers.name));
  } catch (error) {
    const code = extractPgCode(error);
    if (code !== "42703") {
      throw error;
    }

    const fallbackRows = await db
      .select({
        id: teamMembers.id,
        name: teamMembers.name,
        email: teamMembers.email,
        roleId: teamMembers.roleId,
        active: teamMembers.active,
        createdAt: teamMembers.createdAt,
        updatedAt: teamMembers.updatedAt,
        roleName: teamRoles.name,
        roleSlug: teamRoles.slug,
      })
      .from(teamMembers)
      .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
      .orderBy(asc(teamMembers.name));

    rows = fallbackRows.map((row) => ({
      ...row,
      emailNormalized: row.email,
      emailIdentityStatus: row.email ? "ready" : "none",
      phoneE164: null,
      defaultCrewSplitBps: null,
      fixedCrewJobRateBps: null,
      permissionsGrant: [],
      permissionsDeny: [],
    }));
  }

  const members = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    emailMigrationStatus:
      row.emailIdentityStatus === "needs_review"
        ? "needs_review"
        : row.emailNormalized
          ? "ready"
          : "none",
    phone: row.phoneE164 ?? null,
    phoneMigrationStatus: row.phoneE164
      ? "ready"
      : phoneMap[row.id]
        ? "needs_review"
        : "none",
    defaultCrewSplitBps: row.defaultCrewSplitBps ?? null,
    fixedCrewJobRateBps: row.fixedCrewJobRateBps ?? null,
    permissionsGrant: Array.isArray(row.permissionsGrant)
      ? row.permissionsGrant
      : [],
    permissionsDeny: Array.isArray(row.permissionsDeny)
      ? row.permissionsDeny
      : [],
    role: row.roleId
      ? {
          id: row.roleId,
          name: row.roleName ?? null,
          slug: row.roleSlug ?? null,
        }
      : null,
    active: row.active ?? true,
    passwordSet: Boolean(row.passwordHash),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  return NextResponse.json({ members });
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["access.manage"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "team_member.created",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let input: MemberCreateInput;
  try {
    input = parseMemberCreateInput(
      await readBoundedJsonRequest(request, {
        maximumBytes: MEMBER_CREATE_MAXIMUM_BYTES,
        deadlineMs: MEMBER_CREATE_DEADLINE_MS,
        rejectDuplicateObjectKeys: true,
      }),
    );
  } catch (error) {
    const failure = memberCreateInputFailure(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "team_member",
      code: failure.code,
      metadata: { boundary: "input" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const identity = input.email ?? input.phoneE164 ?? input.name.toLowerCase();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/team/members",
      entityType: "team_member_identity",
      entityId: identity,
      payload: input,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      if (input.roleId) {
        const [role] = await tx
          .select({ id: teamRoles.id })
          .from(teamRoles)
          .where(eq(teamRoles.id, input.roleId))
          .for("key share")
          .limit(1);
        if (!role) {
          throw new TeamMutationFailure(
            "invalid",
            "That role no longer exists. Refresh the role list.",
            { status: 404, fieldErrors: { roleId: "Role not found." } },
          );
        }
      }

      const committedAt = new Date();
      const [created] = await tx
        .insert(teamMembers)
        .values({
          name: input.name,
          email: input.email,
          emailNormalized: input.email,
          emailIdentityStatus: input.email ? "ready" : "none",
          phoneE164: input.phoneE164,
          roleId: input.roleId,
          active: input.active,
          createdAt: committedAt,
          updatedAt: committedAt,
        })
        .returning();
      if (!created) {
        throw new TeamMutationFailure(
          "internal",
          "The member could not be created. Try again.",
          { retryable: true },
        );
      }

      // Expand-first rollback compatibility: old workers may still consume the
      // policy map. Authentication never reads this compatibility copy.
      if (input.phoneE164) {
        const [existing] = await tx
          .select({ value: policySettings.value })
          .from(policySettings)
          .where(eq(policySettings.key, "team_member_phones"))
          .for("update")
          .limit(1);
        const legacyPhoneMap = readPhoneMap(existing?.value);
        legacyPhoneMap[created.id] = input.phoneE164;
        await tx
          .insert(policySettings)
          .values({
            key: "team_member_phones",
            value: { phones: legacyPhoneMap },
            updatedBy: mutation.actor.id ?? null,
          })
          .onConflictDoUpdate({
            target: policySettings.key,
            set: {
              value: { phones: legacyPhoneMap },
              updatedBy: mutation.actor.id,
              updatedAt: committedAt,
            },
          });
      }

      const version = created.updatedAt.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "team_member",
        entityId: created.id,
        after: {
          active: created.active ?? true,
          emailConfigured: Boolean(created.email),
          phoneConfigured: Boolean(created.phoneE164),
          roleAssigned: Boolean(created.roleId),
          version,
        },
        metadata: {
          active: created.active ?? true,
          roleAssigned: Boolean(created.roleId),
          emailConfigured: Boolean(created.email),
          phoneConfigured: Boolean(created.phoneE164),
        },
        committedAt: created.updatedAt,
      });
      const data: CreatedMemberData = {
        member: {
          id: created.id,
          name: created.name,
          email: created.email ?? null,
          phone: created.phoneE164 ?? null,
          roleId: created.roleId ?? null,
          active: created.active ?? true,
          createdAt: created.createdAt.toISOString(),
          updatedAt: version,
        },
      };
      const mutationResult = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "team_member",
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
      result as MutationResult<CreatedMemberData>,
      201,
      mutation.correlationId,
      {
        "Cache-Control": "private, no-store, max-age=0",
        ETag: `"${result.receipt.version}"`,
      },
    );
  } catch (error) {
    const operationError = isTeamMemberEmailUniqueViolation(error)
      ? new TeamMutationFailure(
          "conflict",
          "That email is already assigned to another member.",
          { fieldErrors: { email: "Use a unique member email." } },
        )
      : isTeamMemberPhoneUniqueViolation(error)
        ? new TeamMutationFailure(
            "conflict",
            "That phone is already assigned to another member.",
            { fieldErrors: { phone: "Use a unique member phone." } },
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
      entityType: "team_member",
      code: failure.result.code,
      metadata: { boundary: "operation" },
    });
    return teamMutationExceptionResponse(operationError, mutation);
  }
}
