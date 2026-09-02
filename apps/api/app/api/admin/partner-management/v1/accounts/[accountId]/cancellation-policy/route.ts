import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { updatePartnerAccountCancellationPolicyAsStaff } from "@/lib/partner-account-cancellation-policy-administration";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CancellationPolicyInputSchema = z
  .object({
    minimumNoticeMinutes: z.number().int().min(1_440).max(525_600),
    directCancellationEnabled: z.boolean(),
    reason: z.string().trim().min(12).max(1_000),
    confirmation: z.literal("UPDATE CANCELLATION POLICY"),
  })
  .strict();

type RouteContext = { params: Promise<{ accountId?: string }> };

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.accounts.manage"],
    risk: "external",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_account.cancellation_policy_updated",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { accountId: rawAccountId } = await context.params;
  const accountId = rawAccountId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(accountId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid partner account.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { accountId: "Refresh Partner administration." },
      },
    );
  }
  if (!mutation.expectedVersion || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest cancellation-policy revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the account before continuing." },
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
  const parsed = CancellationPolicyInputSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Provide a bounded cancellation policy, an operational reason, and the exact confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          policy:
            "Notice must be between 1440 and 525600 minutes; late requests always require staff review and never create an automatic fee.",
          confirmation: "Enter UPDATE CANCELLATION POLICY exactly.",
        },
      },
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "PATCH /api/admin/partner-management/v1/accounts/:accountId/cancellation-policy",
      entityType: "partner_account_cancellation_policy",
      entityId: accountId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const changed = await updatePartnerAccountCancellationPolicyAsStaff(tx, {
        partnerAccountId: accountId,
        minimumNoticeMinutes: parsed.data.minimumNoticeMinutes,
        directCancellationEnabled: parsed.data.directCancellationEnabled,
        expectedVersion: mutation.expectedVersion!,
        changedByTeamMemberId: mutation.actor.id!,
      });
      const policy = changed.policy;
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_account_cancellation_policy",
        entityId: accountId,
        before: changed.before,
        after: changed.after,
        metadata: {
          partnerAccountId: accountId,
          precedence: "max_notice_and_direct_cancellation",
          lateCancellationDisposition: "staff_review",
          automaticFeeMinor: null,
          reason: parsed.data.reason,
        },
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          partnerAccountId: policy.partnerAccountId,
          minimumNoticeMinutes: policy.minimumNoticeMinutes,
          directCancellationEnabled: policy.directCancellationEnabled,
          lateCancellationDisposition: policy.lateCancellationDisposition,
          automaticFeeMinor: policy.automaticFeeMinor,
          revision: policy.revision,
          updatedAt: policy.updatedAt.toISOString(),
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account_cancellation_policy",
          entityId: accountId,
          version: String(policy.revision),
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
          "[partner-management] cancellation_policy_settlement_failed",
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
