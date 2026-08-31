import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { QuoteV2RevisionCommandSchema } from "@/lib/quote-v2-contract";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { createQuoteV2Revision } from "@/lib/quote-v2-management";
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
    requiredPermissions: ["quotes.update"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "quote.v2.revision_created",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const quoteId = (await context.params).id?.trim() ?? "";
  if (!UUID_PATTERN.test(quoteId)) {
    return teamMutationErrorResponse("invalid", "A valid quote is required.", {
      correlationId: mutation.correlationId,
      fieldErrors: { quoteId: "Open a valid published quote." },
    });
  }
  if (!isQuoteV2FeatureEnabled("staff")) {
    return teamMutationErrorResponse(
      "forbidden",
      "The versioned quote workspace is not enabled for this cohort.",
      { correlationId: mutation.correlationId, status: 404 },
    );
  }
  const parsed = QuoteV2RevisionCommandSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose the current published version and explain the revision.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { revision: "Review the revision request." },
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
      "The current quote revision is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          version: "Refresh the published quote before revising.",
        },
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
      route: "POST /api/quotes/:id/revisions",
      entityType: "quote",
      entityId: quoteId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const receipt = await createQuoteV2Revision(tx, {
        quoteId,
        command: parsed.data,
        expectedQuoteRevision,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote_version",
        entityId: receipt.versionId,
        before: {
          sourceVersionId: receipt.sourceVersionId,
          quoteRevision: parsed.data.quoteRevision,
        },
        after: {
          state: receipt.state,
          versionNumber: receipt.versionNumber,
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
      entityId: quoteId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: { phase: "v2_revision_create" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
