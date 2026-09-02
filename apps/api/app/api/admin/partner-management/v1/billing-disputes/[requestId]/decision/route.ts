import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { decidePartnerBillingDisputeAsStaff } from "@/lib/partner-billing-dispute-requests";
import { withPartnerBillingNoStore } from "@/lib/partner-billing-route-response";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  type TeamMutationIdempotencyReplay,
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
const CONFIRMATIONS = {
  information_provided: "PROVIDE BILLING INFORMATION",
  adjustment_required: "REQUIRE BILLING ADJUSTMENT",
  refund_review: "SEND TO REFUND REVIEW",
  declined: "DECLINE BILLING REQUEST",
} as const;
const DecisionSchema = z
  .object({
    decision: z.enum([
      "information_provided",
      "adjustment_required",
      "refund_review",
      "declined",
    ]),
    reason: z.string().trim().min(12).max(2_000),
    confirmation: z.enum([
      "PROVIDE BILLING INFORMATION",
      "REQUIRE BILLING ADJUSTMENT",
      "SEND TO REFUND REVIEW",
      "DECLINE BILLING REQUEST",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.confirmation !== CONFIRMATIONS[value.decision]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: `Enter ${CONFIRMATIONS[value.decision]} exactly.`,
      });
    }
  });

export function billingDisputeDecisionReplayResponse(
  replay: TeamMutationIdempotencyReplay,
): Response {
  const replayVersion = replay.result.ok ? replay.result.receipt.version : null;
  return teamMutationResultResponse(
    replay.result,
    replay.status,
    replay.correlationId,
    {
      "Cache-Control": "private, no-store",
      "idempotency-replayed": "true",
      ...(replayVersion ? { ETag: `"${replayVersion}"` } : {}),
    },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ requestId?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.billing_disputes.decide"],
    risk: "financial",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_billing_dispute.decided",
  });
  if (!boundary.ok) return withPartnerBillingNoStore(boundary.response);
  const mutation = boundary.mutation;
  const requestId =
    (await context.params).requestId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(requestId)) {
    return withPartnerBillingNoStore(
      teamMutationErrorResponse("invalid", "Billing request not found.", {
        status: 404,
        correlationId: mutation.correlationId,
      }),
    );
  }
  if (
    !mutation.expectedVersion ||
    !/^[1-9][0-9]{0,9}$/u.test(mutation.expectedVersion)
  ) {
    return withPartnerBillingNoStore(
      teamMutationErrorResponse(
        "invalid",
        "The latest billing-request revision is required.",
        {
          correlationId: mutation.correlationId,
          fieldErrors: { version: "Refresh Billing requests." },
        },
      ),
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 6 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return withPartnerBillingNoStore(
      teamMutationExceptionResponse(
        error instanceof BoundedJsonRequestError
          ? new TeamMutationFailure("invalid", "The request body is invalid.", {
              status: error.status,
            })
          : error,
        mutation,
      ),
    );
  }
  const parsed = DecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return withPartnerBillingNoStore(
      teamMutationErrorResponse(
        "invalid",
        "A bounded outcome reason and exact typed confirmation are required.",
        {
          correlationId: mutation.correlationId,
          fieldErrors: {
            reason: "Explain the outcome in 12–2000 characters.",
            confirmation: "Type the confirmation shown for the outcome exactly.",
          },
        },
      ),
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "POST /api/admin/partner-management/v1/billing-disputes/:requestId/decision",
      entityType: "partner_billing_dispute_request",
      entityId: requestId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return billingDisputeDecisionReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const decided = await decidePartnerBillingDisputeAsStaff(tx, {
        requestId,
        decision: parsed.data.decision,
        reason: parsed.data.reason,
        expectedVersion: mutation.expectedVersion!,
        teamMemberId: mutation.actor.id!,
        correlationId: mutation.correlationId,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_billing_dispute_request",
        entityId: requestId,
        before: decided.before,
        after: decided.after,
        metadata: {
          partnerAccountId: decided.partnerAccountId,
          partnerInvoiceId: decided.partnerInvoiceId,
          decision: decided.state,
          classificationOnly: true,
          monetaryMutationPerformed: false,
          providerActionPerformed: false,
        },
        committedAt: decided.resolvedAt,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          requestId: decided.requestId,
          partnerAccountId: decided.partnerAccountId,
          partnerInvoiceId: decided.partnerInvoiceId,
          state: decided.state,
          revision: decided.revision,
          resolvedAt: decided.resolvedAt.toISOString(),
          monetaryMutationPerformed: false,
          providerActionPerformed: false,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_billing_dispute_request",
          entityId: requestId,
          version: String(decided.revision),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
        decided.resolvedAt,
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
          "[partner-management] billing_dispute_decision_settlement_failed",
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
    return withPartnerBillingNoStore(
      teamMutationExceptionResponse(error, mutation),
    );
  }
}
