import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { QuoteV2SaveDraftCommandSchema } from "@/lib/quote-v2-contract";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { saveQuoteV2Draft } from "@/lib/quote-v2-staff-service";
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

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "quote.v2.draft_saved",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const quoteId = (await context.params).id?.trim() ?? "";
  if (!UUID_PATTERN.test(quoteId)) {
    return teamMutationErrorResponse("invalid", "A valid quote is required.", {
      correlationId: mutation.correlationId,
      fieldErrors: { quoteId: "Open a valid quote draft." },
    });
  }
  if (!isQuoteV2FeatureEnabled("staff")) {
    return teamMutationErrorResponse(
      "forbidden",
      "The versioned quote workspace is not enabled for this cohort.",
      { correlationId: mutation.correlationId, status: 404 },
    );
  }
  const parsed = QuoteV2SaveDraftCommandSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "The quote draft contains invalid or oversized fields.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { quote: "Review the highlighted proposal fields." },
      },
    );
  }
  const expectedDraftRevision = Number(mutation.expectedVersion);
  if (
    !Number.isSafeInteger(expectedDraftRevision) ||
    expectedDraftRevision <= 0 ||
    expectedDraftRevision !== parsed.data.draftRevision
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The current draft revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the proposal before saving." },
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
      route: "PATCH /api/quotes/:id/draft",
      entityType: "quote",
      entityId: quoteId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const receipt = await saveQuoteV2Draft(tx, {
        quoteId,
        command: parsed.data,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
        expectedDraftRevision,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote_version",
        entityId: receipt.versionId,
        after: {
          state: receipt.state,
          draftRevision: receipt.draftRevision,
          quoteRevision: receipt.quoteRevision,
        },
        metadata: { quoteId: receipt.quoteId },
      });
      const mutationResult = teamMutationSuccessResult(mutation, receipt, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "quote_version",
        entityId: receipt.versionId,
        version: String(receipt.draftRevision),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId);
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
      entityId: quoteId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: { phase: "v2_draft_save" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
