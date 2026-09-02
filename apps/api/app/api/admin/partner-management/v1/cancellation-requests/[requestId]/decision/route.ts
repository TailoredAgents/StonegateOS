import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { decidePartnerCancellationRequestAsStaff } from "@/lib/partner-cancellation-request-lifecycle";
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
const DecisionSchema = z
  .object({
    decision: z.enum(["approved", "declined"]),
    reason: z.string().trim().min(12).max(1_000),
    confirmation: z.enum(["APPROVE CANCELLATION", "DECLINE CANCELLATION"]),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.decision === "approved"
        ? "APPROVE CANCELLATION"
        : "DECLINE CANCELLATION";
    if (value.confirmation !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmation"],
        message: `Enter ${expected} exactly.`,
      });
    }
  });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ requestId?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.cancellation_requests.decide"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_cancellation_request.decided",
  });
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;
  const requestId =
    (await context.params).requestId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(requestId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid cancellation request.",
      { status: 404, correlationId: mutation.correlationId },
    );
  }
  if (
    !mutation.expectedVersion ||
    !/^[1-9][0-9]{0,9}$/u.test(mutation.expectedVersion)
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest cancellation-request revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh Cancellation reviews." },
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
  const parsed = DecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "A bounded decision reason and exact typed confirmation are required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          reason: "Explain the decision in 12–1000 characters.",
          confirmation:
            "Type the confirmation shown for the selected decision exactly.",
        },
      },
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "POST /api/admin/partner-management/v1/cancellation-requests/:requestId/decision",
      entityType: "partner_cancellation_request",
      entityId: requestId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const decided = await decidePartnerCancellationRequestAsStaff(tx, {
        requestId,
        decision: parsed.data.decision,
        reason: parsed.data.reason,
        expectedVersion: mutation.expectedVersion!,
        teamMemberId: mutation.actor.id!,
        correlationId: mutation.correlationId,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_cancellation_request",
        entityId: requestId,
        before: decided.before,
        after: decided.after,
        metadata: {
          partnerAccountId: decided.partnerAccountId,
          partnerBookingId: decided.partnerBookingId,
          decision: decided.state,
          reason: parsed.data.reason,
          currentScheduleCanceled: decided.state === "approved",
          pendingRescheduleSuperseded:
            decided.supersededRescheduleRequestId !== null,
          supersededRescheduleRequestId: decided.supersededRescheduleRequestId,
          pendingChangeRequestSuperseded:
            decided.supersededChangeRequestId !== null,
          supersededChangeRequestId: decided.supersededChangeRequestId,
          automaticFeeMinor: null,
        },
        committedAt: decided.resolvedAt,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          requestId: decided.requestId,
          partnerAccountId: decided.partnerAccountId,
          partnerBookingId: decided.partnerBookingId,
          state: decided.state,
          revision: decided.revision,
          resolvedAt: decided.resolvedAt.toISOString(),
          publicStatus: decided.publicStatus,
          bookingVersion: decided.bookingVersion,
          appointmentStatus: decided.appointmentStatus,
          currentScheduleCanceled: decided.state === "approved",
          supersededChangeRequestId: decided.supersededChangeRequestId,
          automaticFeeMinor: null,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_cancellation_request",
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
          "[partner-management] cancellation_decision_settlement_failed",
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
