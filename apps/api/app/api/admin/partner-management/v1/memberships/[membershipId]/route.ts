import type { NextRequest } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  partnerAccountMemberships,
  partnerRoleTemplates,
  partnerSessions,
  partnerUsers,
} from "@/db";
import {
  computePartnerCapabilities,
  PARTNER_SYSTEM_ROLE_TEMPLATES,
} from "@/lib/partner-account-authorization";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ membershipId?: string }> };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const InputSchema = z
  .object({
    accountId: z.string().uuid(),
    action: z.enum(["suspend", "reactivate"]),
    confirmation: z.enum(["SUSPEND MEMBERSHIP", "REACTIVATE MEMBERSHIP"]),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.action === "suspend"
        ? "SUSPEND MEMBERSHIP"
        : "REACTIVATE MEMBERSHIP";
    if (value.confirmation !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: `Enter ${expected} exactly.`,
      });
    }
  });

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.memberships.suspend"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_membership.lifecycle_changed",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { membershipId: rawMembershipId } = await context.params;
  const membershipId = rawMembershipId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(membershipId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid partner membership.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { membershipId: "Refresh Partner administration." },
      },
    );
  }
  if (!mutation.expectedVersion || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest membership version is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the membership before continuing." },
      },
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 2 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return teamMutationExceptionResponse(
      error instanceof BoundedJsonRequestError
        ? new TeamMutationFailure("invalid", "The request body is invalid.", {
            status: error.status,
          })
        : error,
      mutation,
    );
  }
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Confirm the account-scoped membership change.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          confirmation:
            "Enter the exact confirmation shown for this membership.",
        },
      },
    );
  }
  const input = parsed.data;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PATCH /api/admin/partner-management/v1/memberships/:membershipId",
      entityType: "partner_account_membership",
      entityId: membershipId,
      payload: input,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      // Lock every membership in the account so two concurrent staff actions
      // cannot both conclude that another active administrator remains.
      const membershipRows = await tx
        .select({
          id: partnerAccountMemberships.id,
          partnerAccountId: partnerAccountMemberships.partnerAccountId,
          partnerUserId: partnerAccountMemberships.partnerUserId,
          roleTemplateId: partnerAccountMemberships.roleTemplateId,
          roleKey: partnerAccountMemberships.roleKey,
          status: partnerAccountMemberships.status,
          capabilityGrants: partnerAccountMemberships.capabilityGrants,
          capabilityDenies: partnerAccountMemberships.capabilityDenies,
          migrationReviewStatus:
            partnerAccountMemberships.migrationReviewStatus,
          updatedAt: partnerAccountMemberships.updatedAt,
        })
        .from(partnerAccountMemberships)
        .where(eq(partnerAccountMemberships.partnerAccountId, input.accountId))
        .for("update");
      const target = membershipRows.find((row) => row.id === membershipId);
      if (!target) {
        throw new TeamMutationFailure(
          "invalid",
          "The membership was not found in that partner account.",
          { status: 404 },
        );
      }
      assertTeamMutationExpectedVersion(mutation, target.updatedAt);
      const expectedStatus =
        input.action === "suspend" ? "active" : "suspended";
      if (target.status !== expectedStatus) {
        throw new TeamMutationFailure(
          "conflict",
          input.action === "suspend"
            ? "Only an active membership can be suspended."
            : "Only a suspended membership can be reactivated.",
        );
      }
      if (
        input.action === "reactivate" &&
        target.migrationReviewStatus === "quarantined"
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "Resolve and release this membership from quarantine before reactivating it.",
          {
            fieldErrors: {
              membershipId: "Quarantined access cannot be reactivated.",
            },
          },
        );
      }

      const userIds = [
        ...new Set(membershipRows.map((row) => row.partnerUserId)),
      ];
      const roleIds = [
        ...new Set(
          membershipRows
            .map((row) => row.roleTemplateId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const users = userIds.length
        ? await tx
            .select({
              id: partnerUsers.id,
              active: partnerUsers.active,
              identityStatus: partnerUsers.identityStatus,
            })
            .from(partnerUsers)
            .where(inArray(partnerUsers.id, userIds))
        : [];
      const roles = roleIds.length
        ? await tx
            .select({
              id: partnerRoleTemplates.id,
              capabilities: partnerRoleTemplates.capabilities,
            })
            .from(partnerRoleTemplates)
            .where(inArray(partnerRoleTemplates.id, roleIds))
        : [];
      const activeUsers = new Map(users.map((user) => [user.id, user.active]));
      const identityStatuses = new Map(
        users.map((user) => [user.id, user.identityStatus]),
      );
      const roleCapabilities = new Map(
        roles.map((role) => [role.id, role.capabilities]),
      );
      const capabilitiesFor = (row: (typeof membershipRows)[number]) =>
        computePartnerCapabilities({
          roleCapabilities:
            (row.roleTemplateId
              ? roleCapabilities.get(row.roleTemplateId)
              : undefined) ??
            PARTNER_SYSTEM_ROLE_TEMPLATES[
              row.roleKey as keyof typeof PARTNER_SYSTEM_ROLE_TEMPLATES
            ] ??
            [],
          grants: row.capabilityGrants,
          denies: row.capabilityDenies,
        });
      if (
        input.action === "suspend" &&
        capabilitiesFor(target).includes("account.members.manage")
      ) {
        const activeAdministrators = membershipRows.filter(
          (row) =>
            row.status === "active" &&
            activeUsers.get(row.partnerUserId) === true &&
            capabilitiesFor(row).includes("account.members.manage"),
        ).length;
        if (activeAdministrators <= 1) {
          throw new TeamMutationFailure(
            "conflict",
            "Add or reactivate another account administrator before suspending the final administrator.",
            {
              fieldErrors: {
                membershipId: "The final active administrator is protected.",
              },
            },
          );
        }
      }
      if (
        input.action === "reactivate" &&
        (activeUsers.get(target.partnerUserId) !== true ||
          identityStatuses.get(target.partnerUserId) !== "active")
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "The global identity must be active before this account membership can be reactivated.",
        );
      }

      const now = new Date();
      const nextStatus = input.action === "suspend" ? "suspended" : "active";
      const [updated] = await tx
        .update(partnerAccountMemberships)
        .set({
          status: nextStatus,
          suspendedAt: input.action === "suspend" ? now : null,
          isDefault: input.action === "suspend" ? false : undefined,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccountMemberships.id, membershipId),
            eq(partnerAccountMemberships.partnerAccountId, input.accountId),
            eq(partnerAccountMemberships.status, expectedStatus),
            eq(partnerAccountMemberships.updatedAt, target.updatedAt),
          ),
        )
        .returning({
          id: partnerAccountMemberships.id,
          status: partnerAccountMemberships.status,
          updatedAt: partnerAccountMemberships.updatedAt,
        });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The membership changed while this action was being saved. Refresh and try again.",
          { retryable: true },
        );
      }

      const revokedSessions =
        input.action === "suspend"
          ? await tx
              .update(partnerSessions)
              .set({ revokedAt: now })
              .where(
                and(
                  eq(partnerSessions.partnerUserId, target.partnerUserId),
                  eq(partnerSessions.activePartnerAccountId, input.accountId),
                  isNull(partnerSessions.revokedAt),
                ),
              )
              .returning({ id: partnerSessions.id })
          : [];
      const version = updated.updatedAt.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_account_membership",
        entityId: membershipId,
        before: {
          status: target.status,
          version: target.updatedAt.toISOString(),
        },
        after: { status: updated.status, version },
        metadata: {
          partnerAccountId: target.partnerAccountId,
          partnerUserId: target.partnerUserId,
          sessionsRevoked: revokedSessions.length,
          scope: "single_partner_account",
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          membershipId,
          partnerAccountId: target.partnerAccountId,
          partnerUserId: target.partnerUserId,
          status: updated.status,
          sessionsRevoked: revokedSessions.length,
          version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account_membership",
          entityId: membershipId,
          version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      "Cache-Control": "private, no-store",
    });
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[partner-management] membership_settlement_failed", {
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
