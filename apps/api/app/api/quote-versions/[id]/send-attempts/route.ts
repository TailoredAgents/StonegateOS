import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";
import { QuoteV2SendAttemptCommandSchema } from "@/lib/quote-v2-contract";
import { createQuoteV2SendAttempt } from "@/lib/quote-v2-send-attempt-service";
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
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.send"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "quote.v2.send_requested",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const versionId = (await context.params).id?.trim() ?? "";
  if (!UUID_PATTERN.test(versionId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid quote version is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { versionId: "Open a valid issued proposal." },
      },
    );
  }
  if (!isQuoteV2FeatureEnabled("staff") || !isQuoteV2FeatureEnabled("sender")) {
    return teamMutationErrorResponse(
      "forbidden",
      "The versioned proposal sender is not enabled for this cohort.",
      { correlationId: mutation.correlationId, status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, {
      maximumBytes: 64 * 1024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    const status =
      error instanceof BoundedJsonRequestError ? error.status : 422;
    return teamMutationErrorResponse(
      "invalid",
      error instanceof BoundedJsonRequestError
        ? error.message
        : "The send request could not be read.",
      {
        correlationId: mutation.correlationId,
        status,
        fieldErrors: { request: "Review the send request and try again." },
      },
    );
  }
  const parsed = QuoteV2SendAttemptCommandSchema.safeParse(body);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Review the recipients or failed deliveries before sending.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          sendAttempt:
            parsed.error.issues[0]?.message ?? "Review the send attempt.",
        },
      },
    );
  }
  const expectedQuoteRevision = Number(mutation.expectedVersion);
  if (
    !Number.isSafeInteger(expectedQuoteRevision) ||
    expectedQuoteRevision <= 0 ||
    expectedQuoteRevision !== parsed.data.quoteRevision
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The current quote revision is required before sending.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh delivery history before retrying." },
      },
    );
  }
  const actorTeamMemberId = mutation.actor.id;
  if (!actorTeamMemberId || !mutation.idempotencyKeyHash) {
    return teamMutationErrorResponse(
      "internal",
      "The verified send operation is incomplete.",
      { correlationId: mutation.correlationId },
    );
  }
  const publicBaseUrl =
    parsed.data.retryDeliveryIds.length > 0
      ? null
      : resolvePublicSiteBaseUrl({ devFallbackLocalhost: true });
  if (parsed.data.retryDeliveryIds.length === 0 && !publicBaseUrl) {
    return teamMutationErrorResponse(
      "internal",
      "The customer proposal URL is not configured.",
      { correlationId: mutation.correlationId, retryable: true },
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/quote-versions/:id/send-attempts",
      entityType: "quote_version",
      entityId: versionId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const receipt = await createQuoteV2SendAttempt(tx, {
        versionId,
        command: parsed.data,
        expectedQuoteRevision,
        actorTeamMemberId,
        idempotencyKeyHash: mutation.idempotencyKeyHash!,
        correlationId: mutation.correlationId,
        publicBaseUrl,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote_send_attempt",
        entityId: receipt.sendAttemptId,
        before: {
          quoteRevision: expectedQuoteRevision,
          issuedAt: receipt.issuedAt,
          expiresAt: receipt.expiresAt,
        },
        after: {
          quoteRevision: receipt.quoteRevision,
          status: receipt.overallState,
          mode: receipt.mode,
        },
        metadata: {
          quoteId: receipt.quoteId,
          versionId: receipt.versionId,
          attemptNumber: receipt.attemptNumber,
          deliveryIds: receipt.deliveryIds,
          retriedDeliveryIds: receipt.retriedDeliveryIds,
          outboxEventId: receipt.outboxEventId,
          expiryPreserved: true,
        },
      });
      const mutationResult = teamMutationSuccessResult(mutation, receipt, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "quote_send_attempt",
        entityId: receipt.sendAttemptId,
        version: String(receipt.quoteRevision),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        201,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 201, mutation.correlationId, {
      "Cache-Control": "private, no-store, max-age=0",
    });
  } catch (error) {
    if (claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "quote_version",
      entityId: versionId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        phase: "v2_send_attempt",
        retryable:
          error instanceof TeamMutationFailure ? error.retryable : true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
