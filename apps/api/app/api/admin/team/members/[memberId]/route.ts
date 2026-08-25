import type { ActionPolicy } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  getDb,
  policySettings,
  teamLoginTokens,
  teamMembers,
  teamRoles,
  teamSessions,
} from "@/db";
import {
  computeEffectivePermissions,
  permissionMatches,
  requirePermission,
} from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";
import {
  getAccessAuditCorrelationId,
  getVerifiedAccessActor,
  insertAccessSuccessAuditEvent,
  isAccessAuditPersistenceError,
} from "@/lib/access-audit";
import { SALES_SCORECARD_POLICY_KEY } from "@/lib/sales-scorecard";
import {
  evaluateMemberDeletion,
  evaluateMemberSecurityChange,
  evaluateSelfAccessChange,
  isActiveOwner,
  isOwnerDemotion,
  shouldRevokeMemberSessions,
  TEAM_ACCESS_SAFETY_LOCK_KEY,
} from "@/lib/team-access-safety";
import {
  isTeamMemberEmailUniqueViolation,
  isTeamMemberPhoneUniqueViolation,
  normalizeTeamMemberEmail,
  normalizeTeamMemberPhoneE164,
} from "@/lib/team-member-identity";
import { validateAssignableTeamPermissions } from "@/lib/team-permission-input";
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

const MEMBER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MEMBER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MEMBER_UPDATE_MAXIMUM_BYTES = 24 * 1024;
const MEMBER_UPDATE_DEADLINE_MS = 5_000;
const MEMBER_UPDATE_ALLOWED_KEYS = new Set([
  "active",
  "defaultCrewSplitBps",
  "fixedCrewJobRateBps",
  "email",
  "expectedUpdatedAt",
  "name",
  "permissionsDeny",
  "permissionsGrant",
  "phone",
  "roleId",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const MEMBER_SELECT = {
  id: teamMembers.id,
  name: teamMembers.name,
  email: teamMembers.email,
  emailNormalized: teamMembers.emailNormalized,
  emailIdentityStatus: teamMembers.emailIdentityStatus,
  phoneE164: teamMembers.phoneE164,
  roleId: teamMembers.roleId,
  active: teamMembers.active,
  createdAt: teamMembers.createdAt,
  updatedAt: teamMembers.updatedAt,
} as const;

type MemberConflictCode =
  | "cannot_deactivate_current_member"
  | "cannot_delete_current_member"
  | "cannot_remove_own_access"
  | "last_active_owner_required";

function conflictResponse(error: MemberConflictCode): Response {
  return NextResponse.json({ error, retryable: false }, { status: 409 });
}

function exactInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function memberUpdateInputFailure(error: unknown): TeamMutationFailure {
  if (!(error instanceof BoundedJsonRequestError)) {
    return error instanceof TeamMutationFailure
      ? error
      : new TeamMutationFailure(
          "invalid",
          "The team-member update payload is invalid.",
        );
  }
  if (error.code === "body_timeout") {
    return new TeamMutationFailure(
      "timeout",
      "The team-member update body timed out before it could be validated.",
      { retryable: true },
    );
  }
  return new TeamMutationFailure("invalid", error.message, {
    status: error.status === 413 ? 413 : 422,
    fieldErrors: { body: "Send one complete JSON team-member update." },
  });
}

function memberConflict(error: MemberConflictCode): TeamMutationFailure {
  const field =
    error === "cannot_deactivate_current_member" ||
    error === "last_active_owner_required"
      ? "active"
      : error === "cannot_remove_own_access"
        ? "permissions"
        : "memberId";
  const message =
    error === "cannot_deactivate_current_member"
      ? "Use Log out instead of deactivating your current member account."
      : error === "cannot_delete_current_member"
        ? "You cannot delete the member account for your current session."
        : error === "cannot_remove_own_access"
          ? "This change would remove your own Access administration permission without another active Owner."
          : "At least one active team member must retain Access administration.";
  return new TeamMutationFailure("conflict", message, {
    fieldErrors: { [field]: "Transfer ownership or preserve access first." },
  });
}

function hasConstraint(error: unknown, constraint: string): boolean {
  const direct = isRecord(error) ? error : null;
  const cause = direct && isRecord(direct["cause"]) ? direct["cause"] : null;
  const candidate = cause ?? direct;
  return Boolean(
    candidate &&
      (candidate["constraint"] === constraint ||
        candidate["constraint_name"] === constraint ||
        (typeof candidate["message"] === "string" &&
          candidate["message"].includes(constraint))),
  );
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

function readDefaultAssignee(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const raw = value["defaultAssigneeMemberId"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["access.manage"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "team_member.updated",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const verifiedActorId = mutation.actor.id ?? "";

  const { memberId } = await context.params;
  if (!MEMBER_ID_PATTERN.test(memberId)) {
    const failure = new TeamMutationFailure(
      "invalid",
      "Choose a valid team member to update.",
      { fieldErrors: { memberId: "Select a valid member." } },
    );
    await recordTeamMutationFailure(mutation, {
      entityType: "team_member",
      code: failure.code,
      metadata: { boundary: "member_id" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  let payload: {
    expectedUpdatedAt?: unknown;
    name?: string;
    email?: string | null;
    roleId?: string | null;
    active?: boolean;
    phone?: string | null;
    defaultCrewSplitBps?: number | null;
    fixedCrewJobRateBps?: number | null;
    permissionsGrant?: unknown;
    permissionsDeny?: unknown;
  };
  try {
    const value = await readBoundedJsonRequest(request, {
      maximumBytes: MEMBER_UPDATE_MAXIMUM_BYTES,
      deadlineMs: MEMBER_UPDATE_DEADLINE_MS,
      rejectDuplicateObjectKeys: true,
    });
    if (!isRecord(value) || Array.isArray(value)) {
      throw new TeamMutationFailure(
        "invalid",
        "Send one complete team-member update.",
        { fieldErrors: { body: "A JSON object is required." } },
      );
    }
    if (
      Object.keys(value).some((key) => !MEMBER_UPDATE_ALLOWED_KEYS.has(key))
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The team-member update contains unsupported fields.",
        { fieldErrors: { body: "Refresh and submit the current form only." } },
      );
    }
    if (Object.keys(value).every((key) => key === "expectedUpdatedAt")) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose at least one member field to update.",
        { fieldErrors: { body: "No member changes were submitted." } },
      );
    }
    const expectedUpdatedAt = exactInstant(value["expectedUpdatedAt"]);
    if (
      !expectedUpdatedAt ||
      mutation.expectedVersion === null ||
      mutation.expectedVersion === "*" ||
      expectedUpdatedAt !== mutation.expectedVersion
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The request must carry the exact member version in both If-Match and expectedUpdatedAt.",
        {
          fieldErrors: {
            version: "Refresh the member and submit its exact updatedAt value.",
          },
        },
      );
    }

    if (Object.prototype.hasOwnProperty.call(value, "name")) {
      const name =
        typeof value["name"] === "string"
          ? value["name"].normalize("NFKC").trim()
          : "";
      if (
        name.length < 1 ||
        name.length > 120 ||
        Array.from(name).some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || codePoint === 127;
        })
      ) {
        throw new TeamMutationFailure("invalid", "Enter a valid member name.", {
          fieldErrors: {
            name: "Use 1–120 visible characters without control characters.",
          },
        });
      }
      value["name"] = name;
    }
    if (Object.prototype.hasOwnProperty.call(value, "email")) {
      const rawEmail = value["email"];
      if (rawEmail !== null && typeof rawEmail !== "string") {
        throw new TeamMutationFailure(
          "invalid",
          "Enter a valid email address.",
          { fieldErrors: { email: "Use a valid email or leave it blank." } },
        );
      }
      const email = normalizeTeamMemberEmail(rawEmail);
      if (email && (email.length > 320 || !MEMBER_EMAIL_PATTERN.test(email))) {
        throw new TeamMutationFailure(
          "invalid",
          "Enter a valid email address.",
          { fieldErrors: { email: "Use a valid email or leave it blank." } },
        );
      }
      value["email"] = email;
    }
    if (Object.prototype.hasOwnProperty.call(value, "roleId")) {
      const rawRoleId = value["roleId"];
      if (rawRoleId !== null && typeof rawRoleId !== "string") {
        throw new TeamMutationFailure("invalid", "Choose a valid role.", {
          fieldErrors: { roleId: "Choose a valid role or no role." },
        });
      }
      const roleId =
        typeof rawRoleId === "string" && rawRoleId.trim().length > 0
          ? rawRoleId.trim()
          : null;
      if (roleId && !MEMBER_ID_PATTERN.test(roleId)) {
        throw new TeamMutationFailure("invalid", "Choose a valid role.", {
          fieldErrors: { roleId: "Choose a valid role or no role." },
        });
      }
      value["roleId"] = roleId;
    }
    if (
      Object.prototype.hasOwnProperty.call(value, "active") &&
      typeof value["active"] !== "boolean"
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "Member activation must be true or false.",
        { fieldErrors: { active: "Choose an explicit activation state." } },
      );
    }
    if (Object.prototype.hasOwnProperty.call(value, "phone")) {
      const rawPhone = value["phone"];
      if (rawPhone !== null && typeof rawPhone !== "string") {
        throw new TeamMutationFailure(
          "invalid",
          "Enter a valid phone number.",
          { fieldErrors: { phone: "Use a valid phone or leave it blank." } },
        );
      }
      if (
        typeof rawPhone === "string" &&
        rawPhone.trim().length > 0 &&
        !normalizeTeamMemberPhoneE164(rawPhone)
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "Enter a valid phone number.",
          { fieldErrors: { phone: "Use a valid US or E.164 phone number." } },
        );
      }
    }
    if (Object.prototype.hasOwnProperty.call(value, "defaultCrewSplitBps")) {
      const split = value["defaultCrewSplitBps"];
      if (
        split !== null &&
        (typeof split !== "number" ||
          !Number.isSafeInteger(split) ||
          split < 0 ||
          split > 10_000)
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "Crew split must be a whole number from 0 to 10,000 basis points.",
          {
            fieldErrors: {
              defaultCrewSplitBps: "Use a value from 0 through 10,000.",
            },
          },
        );
      }
    }
    if (Object.prototype.hasOwnProperty.call(value, "fixedCrewJobRateBps")) {
      const rate = value["fixedCrewJobRateBps"];
      if (
        rate !== null &&
        (typeof rate !== "number" ||
          !Number.isSafeInteger(rate) ||
          rate < 0 ||
          rate > 10_000)
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "Fixed crew job rate must be a whole number from 0 to 10,000 basis points.",
          {
            fieldErrors: {
              fixedCrewJobRateBps: "Use a value from 0 through 10,000.",
            },
          },
        );
      }
    }
    for (const key of ["permissionsGrant", "permissionsDeny"] as const) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const raw = value[key];
      const permissionList = raw === null ? [] : raw;
      const validated = validateAssignableTeamPermissions(permissionList);
      if (!validated.ok) {
        throw new TeamMutationFailure(
          "invalid",
          "Permission overrides contain unsupported values.",
          {
            fieldErrors: {
              [key]:
                validated.invalidEntries.length > 0
                  ? `Unsupported: ${validated.invalidEntries.join(", ")}`
                  : "Choose only supported permissions.",
            },
          },
        );
      }
      if (
        !Array.isArray(permissionList) ||
        permissionList.length > 100 ||
        validated.permissions.length !== permissionList.length ||
        permissionList.some(
          (permission) =>
            typeof permission !== "string" || permission !== permission.trim(),
        )
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "Permission overrides must be one unique reviewed list.",
          {
            fieldErrors: {
              [key]:
                "Remove duplicate, padded, blank, or unsupported permissions.",
            },
          },
        );
      }
      value[key] = [...validated.permissions].sort();
    }
    payload = value;
  } catch (error) {
    const failure = memberUpdateInputFailure(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "team_member",
      entityId: memberId,
      code: failure.code,
      metadata: { boundary: "input" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  const updates: Record<string, unknown> = {};
  let phoneUpdate: { value: string | null } | null = null;

  if (typeof payload.name === "string" && payload.name.trim().length > 0) {
    updates["name"] = payload.name.trim();
  }
  if (typeof payload.email === "string" || payload.email === null) {
    const normalizedEmail = normalizeTeamMemberEmail(payload.email);
    updates["email"] = normalizedEmail;
    updates["emailNormalized"] = normalizedEmail;
    updates["emailIdentityStatus"] = normalizedEmail ? "ready" : "none";
  }
  if (typeof payload.roleId === "string") {
    updates["roleId"] =
      payload.roleId.trim().length > 0 ? payload.roleId.trim() : null;
  } else if (payload.roleId === null) {
    updates["roleId"] = null;
  }
  if (typeof payload.active === "boolean") {
    updates["active"] = payload.active;
  }
  if (payload.defaultCrewSplitBps !== undefined) {
    if (payload.defaultCrewSplitBps === null) {
      updates["defaultCrewSplitBps"] = null;
    } else if (typeof payload.defaultCrewSplitBps === "number") {
      const value = Math.round(payload.defaultCrewSplitBps);
      if (!Number.isFinite(value) || value < 0 || value > 10000) {
        return NextResponse.json(
          { error: "invalid_default_crew_split" },
          { status: 400 },
        );
      }
      updates["defaultCrewSplitBps"] = value;
    } else {
      return NextResponse.json(
        { error: "invalid_default_crew_split" },
        { status: 400 },
      );
    }
  }
  if (payload.fixedCrewJobRateBps !== undefined) {
    updates["fixedCrewJobRateBps"] = payload.fixedCrewJobRateBps;
  }

  if (payload.permissionsGrant !== undefined) {
    if (payload.permissionsGrant === null) {
      updates["permissionsGrant"] = [];
    } else {
      const validated = validateAssignableTeamPermissions(
        payload.permissionsGrant,
      );
      if (!validated.ok) {
        return NextResponse.json(
          {
            error: validated.code,
            field: "permissionsGrant",
            invalidPermissions: validated.invalidEntries,
            message:
              validated.code === "permissions_must_be_an_array"
                ? "Permission grants must be an array of supported permission names."
                : "One or more permission grants cannot be assigned.",
          },
          { status: 400 },
        );
      }
      updates["permissionsGrant"] = validated.permissions;
    }
  }

  if (payload.permissionsDeny !== undefined) {
    if (payload.permissionsDeny === null) {
      updates["permissionsDeny"] = [];
    } else {
      const validated = validateAssignableTeamPermissions(
        payload.permissionsDeny,
      );
      if (!validated.ok) {
        return NextResponse.json(
          {
            error: validated.code,
            field: "permissionsDeny",
            invalidPermissions: validated.invalidEntries,
            message:
              validated.code === "permissions_must_be_an_array"
                ? "Permission denies must be an array of supported permission names."
                : "One or more permission denies cannot be assigned.",
          },
          { status: 400 },
        );
      }
      updates["permissionsDeny"] = validated.permissions;
    }
  }

  if (payload.phone !== undefined) {
    if (payload.phone === null) {
      phoneUpdate = { value: null };
    } else if (typeof payload.phone === "string") {
      if (payload.phone.trim().length === 0) {
        phoneUpdate = { value: null };
      } else {
        const normalized = normalizeTeamMemberPhoneE164(payload.phone);
        if (!normalized) {
          return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
        }
        phoneUpdate = { value: normalized };
      }
    } else {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
  }

  if (Object.keys(updates).length === 0 && !phoneUpdate) {
    return NextResponse.json({ error: "no_updates" }, { status: 400 });
  }

  if (phoneUpdate) {
    updates["phoneE164"] = phoneUpdate.value;
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PATCH /api/admin/team/members/:memberId",
      entityType: "team_member",
      entityId: memberId,
      payload,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      // Every member and role mutation participating in the owner invariant uses
      // the same transaction-scoped lock. Two owners cannot concurrently demote
      // one another and both observe the other as the remaining owner.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${TEAM_ACCESS_SAFETY_LOCK_KEY}))`,
      );

      const [currentMember] = await tx
        .select({
          ...MEMBER_SELECT,
          permissionsGrant: teamMembers.permissionsGrant,
          permissionsDeny: teamMembers.permissionsDeny,
        })
        .from(teamMembers)
        .where(eq(teamMembers.id, memberId))
        .for("update")
        .limit(1);

      if (!currentMember) {
        throw new TeamMutationFailure(
          "invalid",
          "That member no longer exists. Refresh the member list.",
          { status: 404, fieldErrors: { memberId: "Member not found." } },
        );
      }
      assertTeamMutationExpectedVersion(mutation, currentMember.updatedAt);

      const [currentRole] = currentMember.roleId
        ? await tx
            .select({
              id: teamRoles.id,
              slug: teamRoles.slug,
              permissions: teamRoles.permissions,
            })
            .from(teamRoles)
            .where(eq(teamRoles.id, currentMember.roleId))
            .for("update")
            .limit(1)
        : [];

      const nextRoleId = Object.prototype.hasOwnProperty.call(updates, "roleId")
        ? ((updates["roleId"] as string | null) ?? null)
        : currentMember.roleId;
      let nextRoleSlug: string | null = null;
      let nextRolePermissions: string[] = [];
      if (nextRoleId === currentRole?.id) {
        nextRoleSlug = currentRole.slug;
        nextRolePermissions = currentRole.permissions;
      } else if (nextRoleId) {
        const [nextRole] = await tx
          .select({ slug: teamRoles.slug, permissions: teamRoles.permissions })
          .from(teamRoles)
          .where(eq(teamRoles.id, nextRoleId))
          .for("update")
          .limit(1);
        if (!nextRole) {
          throw new TeamMutationFailure(
            "invalid",
            "That role no longer exists. Refresh the role list.",
            { status: 404, fieldErrors: { roleId: "Role not found." } },
          );
        }
        nextRoleSlug = nextRole.slug;
        nextRolePermissions = nextRole.permissions;
      }

      const currentActive = currentMember.active ?? true;
      const nextActive =
        typeof updates["active"] === "boolean"
          ? updates["active"]
          : currentActive;
      const nextPermissionsDeny = Array.isArray(updates["permissionsDeny"])
        ? (updates["permissionsDeny"] as string[])
        : currentMember.permissionsDeny;
      const nextPermissionsGrant = Array.isArray(updates["permissionsGrant"])
        ? (updates["permissionsGrant"] as string[])
        : currentMember.permissionsGrant;
      const currentSecurityState = {
        active: currentActive,
        roleSlug: currentRole?.slug ?? null,
        permissionsDeny: currentMember.permissionsDeny,
      };
      const nextSecurityState = {
        active: nextActive,
        roleSlug: nextRoleSlug,
        permissionsDeny: nextPermissionsDeny,
      };

      const selfSafetyConflict = evaluateMemberSecurityChange({
        actorId: verifiedActorId,
        memberId,
        current: currentSecurityState,
        next: nextSecurityState,
        hasOtherActiveOwner: true,
      });
      if (selfSafetyConflict) {
        throw memberConflict(selfSafetyConflict);
      }

      const selfWouldLoseAccess =
        verifiedActorId === memberId &&
        (payload.roleId !== undefined ||
          payload.permissionsGrant !== undefined ||
          payload.permissionsDeny !== undefined) &&
        !computeEffectivePermissions({
          rolePermissions: nextRolePermissions,
          grant: nextPermissionsGrant,
          deny: nextPermissionsDeny,
        }).some((permission) => permissionMatches(permission, "access.manage"));

      if (
        isOwnerDemotion(currentSecurityState, nextSecurityState) ||
        selfWouldLoseAccess
      ) {
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
            owner.id !== memberId &&
            isActiveOwner({
              active: owner.active ?? true,
              roleSlug: owner.roleSlug,
              permissionsDeny: owner.permissionsDeny,
            }),
        );
        const ownershipConflict = evaluateMemberSecurityChange({
          actorId: verifiedActorId,
          memberId,
          current: currentSecurityState,
          next: nextSecurityState,
          hasOtherActiveOwner: hasOtherOwner,
        });
        if (ownershipConflict) {
          throw memberConflict(ownershipConflict);
        }
        const selfAccessConflict = evaluateSelfAccessChange({
          actorId: verifiedActorId,
          memberId,
          retainsAccess: !selfWouldLoseAccess,
          hasOtherActiveOwner: hasOtherOwner,
        });
        if (selfAccessConflict) {
          throw memberConflict(selfAccessConflict);
        }
      }

      const nextEmail = Object.prototype.hasOwnProperty.call(updates, "email")
        ? ((updates["email"] as string | null) ?? null)
        : currentMember.email;
      const revokeSessions = shouldRevokeMemberSessions({
        current: {
          email: currentMember.email,
          roleId: currentMember.roleId,
          active: currentActive,
        },
        next: {
          email: nextEmail,
          roleId: nextRoleId,
          active: nextActive,
        },
        phoneWasSubmitted: payload.phone !== undefined,
        permissionsWereSubmitted:
          payload.permissionsGrant !== undefined ||
          payload.permissionsDeny !== undefined,
      });

      const committedAt = new Date(
        Math.max(Date.now(), currentMember.updatedAt.getTime() + 1),
      );
      let updatedMember = currentMember;
      if (Object.keys(updates).length > 0) {
        const persistedUpdates = { ...updates, updatedAt: committedAt };
        const [row] = await tx
          .update(teamMembers)
          .set(persistedUpdates)
          .where(
            and(
              eq(teamMembers.id, memberId),
              eq(teamMembers.updatedAt, currentMember.updatedAt),
            ),
          )
          .returning(MEMBER_SELECT);
        if (!row) {
          throw new TeamMutationFailure(
            "conflict",
            "The member changed while it was being saved. Refresh and try again.",
            {
              retryable: true,
              fieldErrors: { version: "Refresh the member." },
            },
          );
        }
        updatedMember = { ...currentMember, ...row };
      }

      if (phoneUpdate) {
        const [existing] = await tx
          .select({ value: policySettings.value })
          .from(policySettings)
          .where(eq(policySettings.key, "team_member_phones"))
          .for("update")
          .limit(1);

        const phoneMap = readPhoneMap(existing?.value);
        if (phoneUpdate.value) {
          phoneMap[memberId] = phoneUpdate.value;
        } else {
          delete phoneMap[memberId];
        }

        await tx
          .insert(policySettings)
          .values({
            key: "team_member_phones",
            value: { phones: phoneMap },
            updatedBy: verifiedActorId,
          })
          .onConflictDoUpdate({
            target: policySettings.key,
            set: {
              value: { phones: phoneMap },
              updatedBy: verifiedActorId,
              updatedAt: committedAt,
            },
          });
      }

      let revokedSessionCount = 0;
      if (revokeSessions) {
        const revoked = await tx
          .update(teamSessions)
          .set({ revokedAt: committedAt })
          .where(
            and(
              eq(teamSessions.teamMemberId, memberId),
              isNull(teamSessions.revokedAt),
            ),
          )
          .returning({ id: teamSessions.id });
        revokedSessionCount = revoked.length;
        await tx
          .delete(teamLoginTokens)
          .where(eq(teamLoginTokens.teamMemberId, memberId));
      }

      const version = updatedMember.updatedAt.toISOString();
      const changedFields = Object.keys(updates).filter(
        (field) =>
          field !== "emailNormalized" && field !== "emailIdentityStatus",
      );
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "team_member",
        entityId: memberId,
        before: {
          active: currentMember.active ?? true,
          grantCount: currentMember.permissionsGrant.length,
          denyCount: currentMember.permissionsDeny.length,
          roleAssigned: Boolean(currentMember.roleId),
          version: currentMember.updatedAt.toISOString(),
        },
        after: {
          active: updatedMember.active ?? true,
          grantCount: nextPermissionsGrant.length,
          denyCount: nextPermissionsDeny.length,
          roleAssigned: Boolean(updatedMember.roleId),
          revokedSessionCount,
          version,
        },
        metadata: {
          changedFields,
          phoneChanged: Boolean(phoneUpdate),
          sessionsRevoked: revokeSessions,
          revokedSessionCount,
        },
        committedAt,
      });
      const data = {
        member: {
          id: updatedMember.id,
          name: updatedMember.name,
          email: updatedMember.email ?? null,
          phone: updatedMember.phoneE164 ?? null,
          roleId: updatedMember.roleId ?? null,
          active: updatedMember.active ?? true,
          createdAt: updatedMember.createdAt.toISOString(),
          updatedAt: version,
        },
        revokedSessionCount,
      };
      const mutationResult = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "team_member",
        entityId: memberId,
        version,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
        committedAt,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      "Cache-Control": "private, no-store, max-age=0",
      ETag: `"${result.receipt.version}"`,
    });
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
        : hasConstraint(error, "team_access_continuity_requires_active_owner")
          ? memberConflict("last_active_owner_required")
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
      entityId: memberId,
      code: failure.result.code,
      metadata: { boundary: "operation" },
    });
    return teamMutationExceptionResponse(operationError, mutation);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;
  const verifiedActor = getVerifiedAccessActor(request);
  if (!verifiedActor) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const verifiedActorId = verifiedActor.id;
  const correlationId = getAccessAuditCorrelationId(request);

  const { memberId } = await context.params;
  if (!memberId) {
    return NextResponse.json({ error: "member_id_required" }, { status: 400 });
  }
  const db = getDb();
  const performDelete = () =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${TEAM_ACCESS_SAFETY_LOCK_KEY}))`,
      );

      const [currentMember] = await tx
        .select({
          ...MEMBER_SELECT,
          permissionsDeny: teamMembers.permissionsDeny,
        })
        .from(teamMembers)
        .where(eq(teamMembers.id, memberId))
        .for("update")
        .limit(1);
      if (!currentMember) {
        return {
          kind: "not_found" as const,
          member: null,
          clearedDefaultAssignee: false,
        };
      }

      const [role] = currentMember.roleId
        ? await tx
            .select({ slug: teamRoles.slug })
            .from(teamRoles)
            .where(eq(teamRoles.id, currentMember.roleId))
            .for("update")
            .limit(1)
        : [];

      if (
        isActiveOwner({
          active: currentMember.active ?? true,
          roleSlug: role?.slug ?? null,
          permissionsDeny: currentMember.permissionsDeny,
        })
      ) {
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
            owner.id !== memberId &&
            isActiveOwner({
              active: owner.active ?? true,
              roleSlug: owner.roleSlug,
              permissionsDeny: owner.permissionsDeny,
            }),
        );
        const ownershipConflict = evaluateMemberDeletion({
          actorId: verifiedActorId,
          memberId,
          current: {
            active: currentMember.active ?? true,
            roleSlug: role?.slug ?? null,
            permissionsDeny: currentMember.permissionsDeny,
          },
          hasOtherActiveOwner: hasOtherOwner,
        });
        if (ownershipConflict) {
          return {
            kind: "conflict" as const,
            error: ownershipConflict,
            member: null,
            clearedDefaultAssignee: false,
          };
        }
      }

      const deletionConflict = evaluateMemberDeletion({
        actorId: verifiedActorId,
        memberId,
        current: {
          active: currentMember.active ?? true,
          roleSlug: role?.slug ?? null,
          permissionsDeny: currentMember.permissionsDeny,
        },
        hasOtherActiveOwner: true,
      });
      if (deletionConflict) {
        return {
          kind: "conflict" as const,
          error: deletionConflict,
          member: null,
          clearedDefaultAssignee: false,
        };
      }

      const revokedAt = new Date();
      await tx
        .update(teamSessions)
        .set({ revokedAt })
        .where(
          and(
            eq(teamSessions.teamMemberId, memberId),
            isNull(teamSessions.revokedAt),
          ),
        );
      await tx
        .delete(teamLoginTokens)
        .where(eq(teamLoginTokens.teamMemberId, memberId));

      const [member] = await tx
        .delete(teamMembers)
        .where(eq(teamMembers.id, memberId))
        .returning(MEMBER_SELECT);
      if (!member) {
        return {
          kind: "not_found" as const,
          member: null,
          clearedDefaultAssignee: false,
        };
      }

      let clearedDefaultAssignee = false;

      // Remove any saved phone mapping for this member.
      const [phoneSetting] = await tx
        .select({ value: policySettings.value })
        .from(policySettings)
        .where(eq(policySettings.key, "team_member_phones"))
        .for("update")
        .limit(1);
      const phoneMap = readPhoneMap(phoneSetting?.value);
      if (phoneMap[memberId]) {
        delete phoneMap[memberId];
        await tx
          .insert(policySettings)
          .values({
            key: "team_member_phones",
            value: { phones: phoneMap },
            updatedBy: verifiedActorId,
          })
          .onConflictDoUpdate({
            target: policySettings.key,
            set: {
              value: { phones: phoneMap },
              updatedBy: verifiedActorId,
              updatedAt: new Date(),
            },
          });
      }

      // If this member was the default lead assignee, clear it so it doesn't point at a deleted member.
      const [salesSetting] = await tx
        .select({ value: policySettings.value })
        .from(policySettings)
        .where(eq(policySettings.key, SALES_SCORECARD_POLICY_KEY))
        .for("update")
        .limit(1);
      const currentDefault = readDefaultAssignee(salesSetting?.value);
      if (currentDefault === memberId) {
        const nextValue: Record<string, unknown> = isRecord(salesSetting?.value)
          ? { ...salesSetting.value }
          : {};
        delete nextValue["defaultAssigneeMemberId"];
        clearedDefaultAssignee = true;

        await tx
          .insert(policySettings)
          .values({
            key: SALES_SCORECARD_POLICY_KEY,
            value: nextValue,
            updatedBy: verifiedActorId,
          })
          .onConflictDoUpdate({
            target: policySettings.key,
            set: {
              value: nextValue,
              updatedBy: verifiedActorId,
              updatedAt: new Date(),
            },
          });
      }

      await insertAccessSuccessAuditEvent(tx, {
        actor: verifiedActor,
        correlationId,
        action: "team_member.deleted",
        entityType: "team_member",
        entityId: memberId,
        metadata: {
          clearedDefaultAssignee,
          sessionsRevoked: true,
        },
      });

      return { kind: "deleted" as const, member, clearedDefaultAssignee };
    });

  let result: Awaited<ReturnType<typeof performDelete>>;
  try {
    result = await performDelete();
  } catch (error) {
    if (isAccessAuditPersistenceError(error)) {
      return NextResponse.json(
        { error: "audit_persistence_failed", retryable: true },
        { status: 503 },
      );
    }
    throw error;
  }

  if (result.kind === "not_found") {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }
  if (result.kind === "conflict") return conflictResponse(result.error);

  return NextResponse.json({ ok: true });
}
