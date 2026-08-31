import { getDb } from "@/db";
import { QuoteV2CreateCommandSchema } from "@/lib/quote-v2-contract";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { createQuoteV2Draft } from "@/lib/quote-v2-staff-service";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
  type TeamMutationContext,
} from "@/lib/team-mutation";

export async function handleCreateQuoteV2(input: {
  body: unknown;
  mutation: TeamMutationContext;
}): Promise<Response> {
  const { mutation } = input;
  if (!isQuoteV2FeatureEnabled("staff")) {
    await recordTeamMutationFailure(mutation, {
      outcome: "denied",
      entityType: "quote",
      code: "operation_disabled",
      metadata: { phase: "feature_flag", feature: "quote_v2_staff" },
    });
    return teamMutationErrorResponse(
      "forbidden",
      "The versioned quote workspace is not enabled for this cohort.",
      { correlationId: mutation.correlationId, status: 404 },
    );
  }
  const parsed = QuoteV2CreateCommandSchema.safeParse(input.body);
  if (!parsed.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      code: "invalid",
      metadata: { phase: "request_validation", quoteEngine: "v2" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "Choose a client, service property, and project before creating the draft.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { quote: "Review the client and project details." },
      },
    );
  }
  const actorTeamMemberId = mutation.actor.id;
  if (!actorTeamMemberId) {
    return teamMutationErrorResponse(
      "internal",
      "The verified team member could not be resolved.",
      { correlationId: mutation.correlationId },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/quotes",
      entityType: "quote_v2",
      entityId: "new",
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const receipt = await createQuoteV2Draft(tx, {
        command: parsed.data,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote",
        entityId: receipt.quoteId,
        after: {
          engineVersion: "v2",
          state: receipt.state,
          quoteRevision: receipt.quoteRevision,
          draftRevision: receipt.draftRevision,
          versionId: receipt.versionId,
        },
        metadata: { quoteNumber: receipt.quoteNumber },
      });
      const mutationResult = teamMutationSuccessResult(mutation, receipt, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "quote",
        entityId: receipt.quoteId,
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
    return teamMutationResultResponse(result, 201, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        phase: "v2_create",
        retryable:
          error instanceof TeamMutationFailure ? error.retryable : true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
