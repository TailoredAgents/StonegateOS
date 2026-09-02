import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, partnerAccountMemberships } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePermission } from "@/lib/permissions";
import { reviewMigratedPartnerAccountMemberAsStaff } from "@/lib/partner-portal-v2-members";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  strengthenTeamMutationPolicy,
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
    decision: z.enum(["approve", "quarantine"]),
    note: z.string().trim().min(12).max(2_000),
    ownerOverride: z.boolean().default(false),
    confirmation: z.enum([
      "APPROVE MIGRATED MEMBERSHIP",
      "APPROVE MIGRATED OWNER",
      "QUARANTINE MIGRATED MEMBERSHIP",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.decision === "quarantine" &&
      value.confirmation !== "QUARANTINE MIGRATED MEMBERSHIP"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: "Confirm the quarantine decision exactly.",
      });
    }
    if (
      value.decision === "approve" &&
      value.confirmation === "QUARANTINE MIGRATED MEMBERSHIP"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: "Confirm the approval decision exactly.",
      });
    }
  });

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.memberships.migration.review"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_membership.migration_reviewed",
  });
  if (!boundary.ok) return boundary.response;
  let mutation = boundary.mutation;
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
      maximumBytes: 4 * 1_024,
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
      "Provide a review note and exact decision confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          confirmation: "Use the confirmation shown for this decision.",
        },
      },
    );
  }
  const input = parsed.data;
  const db = getDb();
  const [preflight] = await db
    .select({
      migrationLegacyRoleKey: partnerAccountMemberships.migrationLegacyRoleKey,
      migrationReviewStatus: partnerAccountMemberships.migrationReviewStatus,
    })
    .from(partnerAccountMemberships)
    .where(
      and(
        eq(partnerAccountMemberships.id, membershipId),
        eq(partnerAccountMemberships.partnerAccountId, input.accountId),
      ),
    )
    .limit(1);
  if (!preflight) {
    await recordTeamMutationFailure(mutation, {
      entityType: "partner_account_membership",
      entityId: membershipId,
      code: "invalid",
      metadata: { phase: "account_bound_preflight" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "The membership was not found.",
      {
        status: 404,
        correlationId: mutation.correlationId,
      },
    );
  }

  const isMigratedOwnerApproval =
    input.decision === "approve" &&
    preflight.migrationLegacyRoleKey === "owner";
  if (
    isMigratedOwnerApproval &&
    (!input.ownerOverride || input.confirmation !== "APPROVE MIGRATED OWNER")
  ) {
    await recordTeamMutationFailure(mutation, {
      outcome: "denied",
      entityType: "partner_account_membership",
      entityId: membershipId,
      code: "forbidden",
      metadata: { phase: "owner_recovery_confirmation" },
    });
    return teamMutationErrorResponse(
      "forbidden",
      "Migrated owner approval requires the Team Owner recovery confirmation.",
      { correlationId: mutation.correlationId },
    );
  }
  if (
    input.decision === "approve" &&
    !isMigratedOwnerApproval &&
    input.confirmation !== "APPROVE MIGRATED MEMBERSHIP"
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "Confirm this migrated membership approval exactly.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { confirmation: "Enter APPROVE MIGRATED MEMBERSHIP." },
      },
    );
  }
  if (isMigratedOwnerApproval) {
    const ownerPermissionError = await requirePermission(
      request,
      "partners.memberships.recover_admin",
    );
    if (ownerPermissionError) {
      await recordTeamMutationFailure(mutation, {
        outcome: "denied",
        entityType: "partner_account_membership",
        entityId: membershipId,
        code: "forbidden",
        metadata: {
          phase: "owner_recovery_permission",
          additionalRequiredPermission: "partners.memberships.recover_admin",
        },
      });
      return teamMutationErrorResponse(
        "forbidden",
        "Only a Team Owner can approve a migrated account owner.",
        { correlationId: mutation.correlationId },
      );
    }
    mutation = strengthenTeamMutationPolicy(mutation, [
      "partners.memberships.recover_admin",
    ]);
  }

  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "PATCH /api/admin/partner-management/v1/memberships/:membershipId/migration-review",
      entityType: "partner_account_membership",
      entityId: membershipId,
      payload: input,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const reviewed = await reviewMigratedPartnerAccountMemberAsStaff(tx, {
        partnerAccountId: input.accountId,
        membershipId,
        decision: input.decision,
        note: input.note,
        reviewedByTeamMemberId: mutation.actor.id!,
        expectedVersion: mutation.expectedVersion!,
        allowAdministratorRecovery: isMigratedOwnerApproval,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_account_membership",
        entityId: membershipId,
        before: reviewed.before,
        after: reviewed.after,
        metadata: {
          partnerAccountId: reviewed.partnerAccountId,
          partnerUserId: reviewed.partnerUserId,
          legacyRoleKey: reviewed.legacyRoleKey,
          protectiveDeniesRemoved: reviewed.protectiveDeniesRemoved,
          sessionsRevoked: reviewed.sessionsRevoked,
          ownerRecovery: isMigratedOwnerApproval,
          scope: "single_partner_account",
        },
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          membershipId,
          partnerAccountId: reviewed.partnerAccountId,
          partnerUserId: reviewed.partnerUserId,
          migrationReviewStatus: reviewed.migrationReviewStatus,
          status: reviewed.status,
          protectiveDeniesRemoved: reviewed.protectiveDeniesRemoved,
          sessionsRevoked: reviewed.sessionsRevoked,
          version: reviewed.version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account_membership",
          entityId: membershipId,
          version: reviewed.version,
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
      ETag: `"${String(result.receipt.version)}"`,
    });
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error(
          "[partner-management] migration_review_settlement_failed",
          {
            correlationId: mutation.correlationId,
            errorName:
              settlementError instanceof Error
                ? settlementError.name
                : "UnknownError",
          },
        );
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
