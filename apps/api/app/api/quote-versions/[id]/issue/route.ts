import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  QuoteDocumentSnapshotSchema,
  QuoteV2IssueCommandSchema,
} from "@/lib/quote-v2-contract";
import { calculateQuoteV2Totals } from "@/lib/quote-v2-domain";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import {
  getMediaStorageBucket,
  getMediaStorageProvider,
  putImmutableMediaObject,
} from "@/lib/media-storage";
import { requirePermission } from "@/lib/permissions";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";
import { prepareQuoteVersionIssue } from "@/lib/quote-v2-issue";
import {
  loadQuoteV2ReadyIssueSource,
  persistPreparedQuoteVersionIssue,
} from "@/lib/quote-v2-issue-persistence";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  extendTeamMutationIdempotencyLease,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
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
    auditAction: "quote.v2.issued",
  });
  if (!boundary.ok) return boundary.response;
  let mutation = boundary.mutation;
  const versionId = (await context.params).id?.trim() ?? "";
  if (!UUID_PATTERN.test(versionId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid quote version is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { versionId: "Review a valid proposal version." },
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
  const parsed = QuoteV2IssueCommandSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Review the signer, recipients, and channels before issuing.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { recipients: "Choose exactly one valid signer." },
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
      "The current quote revision is required before issue.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh and review the proposal again." },
      },
    );
  }
  const actorTeamMemberId = mutation.actor.id;
  if (!actorTeamMemberId || !mutation.idempotencyKeyHash) {
    return teamMutationErrorResponse(
      "internal",
      "The verified issue operation is incomplete.",
      { correlationId: mutation.correlationId },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const source = await loadQuoteV2ReadyIssueSource(db, versionId);
    if (source.quoteRevision !== expectedQuoteRevision) {
      throw new TeamMutationFailure(
        "conflict",
        "The quote changed after review. Refresh before issuing.",
        { fieldErrors: { version: "The reviewed quote is stale." } },
      );
    }
    const document = QuoteDocumentSnapshotSchema.parse(source.documentSnapshot);
    const totals = calculateQuoteV2Totals(document.pricing);
    if (totals.depositCents > 0) {
      const paymentPermissionError = await requirePermission(
        request,
        "payments.collect",
      );
      if (paymentPermissionError) {
        await recordTeamMutationFailure(mutation, {
          outcome: "denied",
          entityType: "quote_version",
          entityId: versionId,
          code: "forbidden",
          metadata: { phase: "deposit_permission" },
        });
        return teamMutationErrorResponse(
          "forbidden",
          "Issuing a proposal with an online deposit requires payment collection permission.",
          { correlationId: mutation.correlationId },
        );
      }
      mutation = strengthenTeamMutationPolicy(mutation, ["payments.collect"]);
    }

    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/quote-versions/:id/issue",
      entityType: "quote_version",
      entityId: versionId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    await extendTeamMutationIdempotencyLease(
      db,
      mutation,
      claim,
      2 * 60 * 1_000,
    );

    const publicBaseUrl = resolvePublicSiteBaseUrl({
      devFallbackLocalhost: true,
    });
    if (!publicBaseUrl) {
      throw new TeamMutationFailure(
        "internal",
        "The customer proposal origin is not configured.",
      );
    }
    const storageProvider = getMediaStorageProvider();
    const storageBucket = getMediaStorageBucket();
    const now = new Date();
    const prepared = await prepareQuoteVersionIssue(
      {
        quoteId: source.quoteId,
        versionId: source.versionId,
        quoteNumber: source.quoteNumber,
        versionNumber: source.versionNumber,
        document,
        selectedOptionIds: [],
        attachments: source.attachments,
        recipients: parsed.data.recipients,
        coverMessage: parsed.data.coverMessage,
        sendNow: parsed.data.sendNow,
        issuedByTeamMemberId: actorTeamMemberId,
        idempotencyKeyHash: mutation.idempotencyKeyHash,
        correlationId: mutation.correlationId,
        publicBaseUrl,
        storageProvider,
        storageBucket,
        attemptNumber: 1,
      },
      { now },
    );
    await putImmutableMediaObject({
      key: prepared.persistence.document.storageObjectKey,
      body: prepared.persistence.document.body,
      contentType: prepared.persistence.document.contentType,
    });

    const result = await db.transaction(async (tx) => {
      const receipt = await persistPreparedQuoteVersionIssue(tx, {
        source,
        prepared,
        actorTeamMemberId,
        correlationId: mutation.correlationId,
        now,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote_version",
        entityId: receipt.versionId,
        before: { state: "ready", quoteRevision: source.quoteRevision },
        after: {
          state: "issued",
          quoteRevision: receipt.quoteRevision,
          issuedAt: receipt.issuedAt,
          expiresAt: receipt.expiresAt,
        },
        metadata: {
          quoteId: receipt.quoteId,
          documentId: prepared.persistence.document.id,
          sendAttemptId: receipt.sendAttemptId,
          outboxEventId: receipt.outboxEventId,
          deliveryCount: prepared.persistence.deliveries.length,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(mutation, receipt, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "quote_version",
        entityId: receipt.versionId,
        version: String(receipt.quoteRevision),
      });
      // A create-link-only response exposes the raw link exactly once. The
      // idempotency receipt deliberately stores the token-free replay shape.
      const storedResult = {
        ...mutationResult,
        data: { ...mutationResult.data, oneTimeLinks: [] },
      };
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        storedResult,
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
      entityType: "quote_version",
      entityId: versionId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        phase: "v2_issue",
        retryable:
          error instanceof TeamMutationFailure ? error.retryable : true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
