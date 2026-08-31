import type { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb, outboxEvents, quotes } from "@/db";
import {
  requireActiveContactForDirectOutbound,
  resolveUsableQuoteDeliveryChannels,
} from "@/lib/contact-outbound-safety";
import { buildQuoteSendAttemptId } from "@/lib/quote-outbox-contract";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { nanoid } from "nanoid";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";
import {
  LegacyQuoteExpiryError,
  resolveLegacyQuoteSendTiming,
} from "@/lib/quote-legacy-expiry";

const SendQuoteSchema = z.object({
  confirmation: z.literal("send_quote"),
  expiresInDays: z.number().int().min(1).max(120).optional(),
  shareBaseUrl: z.string().url().optional(),
});
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function buildShareUrl(token: string, baseUrl?: string): string | null {
  const configuredBase = resolvePublicSiteBaseUrl();
  if (!configuredBase) return null;
  if (baseUrl) {
    const candidate = /^https?:\/\//iu.test(baseUrl)
      ? baseUrl
      : `https://${baseUrl}`;
    try {
      const parsed = new URL(candidate);
      if (parsed.origin === configuredBase) {
        return new URL(`/quote/${token}`, parsed.origin).toString();
      }
    } catch {
      // Ignore an untrusted override and use the configured public origin.
    }
  }
  return new URL(`/quote/${token}`, configuredBase).toString();
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.send"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "quote.sent",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { id: rawId } = await context.params;
  const quoteId = rawId?.trim() ?? "";
  if (!UUID_PATTERN.test(quoteId)) {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      code: "invalid",
      metadata: { phase: "request_validation", reason: "invalid_quote_id" },
    });
    return teamMutationErrorResponse("invalid", "A valid quote is required.", {
      correlationId: mutation.correlationId,
      fieldErrors: { quoteId: "Select a valid quote." },
    });
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "version_required" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "The latest quote version is required before sending.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the quote and try again." },
      },
    );
  }

  const parsedBody = SendQuoteSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsedBody.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "confirmation" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "Confirm the current quote before sending it.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { confirmation: "Confirm this send." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  let failurePhase = "claim";
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/quotes/:id/send",
      entityType: "quote",
      entityId: quoteId,
      payload: {
        confirmation: parsedBody.data.confirmation,
        expiresInDays: parsedBody.data.expiresInDays ?? null,
      },
    });
    if (claimed.kind === "replay") {
      if (!claimed.replay.result.ok) {
        return teamMutationIdempotencyReplayResponse(claimed.replay);
      }
      const [replayQuote] = await db
        .select({
          engineVersion: quotes.engineVersion,
          shareToken: quotes.shareToken,
        })
        .from(quotes)
        .where(eq(quotes.id, quoteId))
        .limit(1);
      if (replayQuote?.engineVersion !== "legacy") {
        throw new TeamMutationFailure(
          "conflict",
          "This versioned quote must be sent through its immutable version workflow.",
        );
      }
      const replayShareUrl = replayQuote?.shareToken
        ? buildShareUrl(replayQuote.shareToken, parsedBody.data.shareBaseUrl)
        : null;
      if (!replayShareUrl) {
        throw new TeamMutationFailure(
          "internal",
          "The quote was sent, but its protected share link could not be reconstructed.",
        );
      }
      const replayData = claimed.replay.result.data;
      if (!replayData || typeof replayData !== "object") {
        throw new TeamMutationFailure(
          "internal",
          "The original quote send receipt is incomplete.",
        );
      }
      return teamMutationResultResponse(
        {
          ...claimed.replay.result,
          data: { ...replayData, shareUrl: replayShareUrl },
        },
        claimed.replay.status,
        claimed.replay.correlationId,
        { "idempotency-replayed": "true" },
      );
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      failurePhase = "quote_lock";
      const [existing] = await tx
        .select({
          id: quotes.id,
          engineVersion: quotes.engineVersion,
          status: quotes.status,
          shareToken: quotes.shareToken,
          contactId: quotes.contactId,
          revision: quotes.revision,
          sentAt: quotes.sentAt,
          expiresAt: quotes.expiresAt,
        })
        .from(quotes)
        .where(eq(quotes.id, quoteId))
        .for("update")
        .limit(1);
      if (!existing) {
        throw new TeamMutationFailure("invalid", "The quote was not found.", {
          status: 404,
        });
      }
      if (existing.engineVersion !== "legacy") {
        throw new TeamMutationFailure(
          "conflict",
          "This versioned quote must be sent through its immutable version workflow.",
        );
      }
      assertTeamMutationExpectedVersion(mutation, existing.revision);
      if (existing.status === "accepted" || existing.status === "declined") {
        throw new TeamMutationFailure(
          "conflict",
          "This quote is already finalized and cannot be sent again.",
        );
      }
      failurePhase = "contact_policy";
      const deliveryContact = await requireActiveContactForDirectOutbound(
        tx,
        existing.contactId,
      );
      if (deliveryContact.doNotContact) {
        throw new TeamMutationFailure(
          "conflict",
          "This contact is marked Do Not Contact. Remove that restriction through the explicit Inbox review flow before sending a quote.",
        );
      }
      const deliveryChannels =
        resolveUsableQuoteDeliveryChannels(deliveryContact);
      if (!deliveryChannels.phone && !deliveryChannels.email) {
        throw new TeamMutationFailure(
          "conflict",
          "Add a valid phone number or email address before sending this quote.",
        );
      }

      const shareToken = existing.shareToken ?? nanoid(24);
      const attemptAt = new Date();
      let timing: ReturnType<typeof resolveLegacyQuoteSendTiming>;
      failurePhase = "expiry_policy";
      try {
        timing = resolveLegacyQuoteSendTiming({
          now: attemptAt,
          sentAt: existing.sentAt,
          expiresAt: existing.expiresAt,
          requestedValidityDays: parsedBody.data.expiresInDays,
        });
      } catch (error) {
        if (error instanceof LegacyQuoteExpiryError) {
          throw new TeamMutationFailure("conflict", error.message, {
            fieldErrors: { expiresInDays: error.message },
          });
        }
        throw error;
      }
      const shareUrl = buildShareUrl(shareToken, parsedBody.data.shareBaseUrl);
      if (!shareUrl) {
        throw new TeamMutationFailure(
          "internal",
          "The public quote URL is not configured. No send was queued.",
        );
      }

      const sentAt = timing.firstSentAt;
      const expiresAt = timing.expiresAt;
      const updatedAt = attemptAt;
      const nextRevision = existing.revision + 1;
      failurePhase = "quote_update";
      const [updated] = await tx
        .update(quotes)
        .set({
          shareToken,
          sentAt,
          expiresAt,
          status: "sent",
          refreshRequestedAt: null,
          revision: nextRevision,
          updatedAt,
        })
        .where(
          and(
            eq(quotes.id, quoteId),
            eq(quotes.engineVersion, "legacy"),
            eq(quotes.revision, existing.revision),
          ),
        )
        .returning({
          id: quotes.id,
          shareToken: quotes.shareToken,
          sentAt: quotes.sentAt,
          expiresAt: quotes.expiresAt,
          revision: quotes.revision,
        });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The quote changed while it was being sent. Refresh and try again.",
          { retryable: true },
        );
      }

      const sendAttemptId = buildQuoteSendAttemptId(updated.revision);

      failurePhase = "outbox_insert";
      const [outbox] = await tx
        .insert(outboxEvents)
        .values({
          type: "quote.sent",
          payload: {
            quoteId: updated.id,
            contactId: existing.contactId,
            sendAttemptId,
          },
        })
        .returning({ id: outboxEvents.id });
      if (!outbox?.id) {
        throw new TeamMutationFailure(
          "internal",
          "The quote send could not be queued.",
        );
      }

      failurePhase = "audit_insert";
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote",
        entityId: updated.id,
        before: {
          status: existing.status,
          revision: existing.revision,
          sentAt: existing.sentAt?.toISOString() ?? null,
        },
        after: {
          status: "sent",
          revision: updated.revision,
          sentAt: updated.sentAt?.toISOString() ?? null,
          expiresAt: updated.expiresAt?.toISOString() ?? null,
        },
        metadata: {
          contactId: existing.contactId,
          outboxEventId: outbox.id,
          sendAttemptId,
          deliveryChannels: {
            sms: Boolean(deliveryChannels.phone),
            email: Boolean(deliveryChannels.email),
          },
        },
        committedAt: updatedAt,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          quoteId: updated.id,
          shareUrl,
          sentAt: updated.sentAt?.toISOString() ?? null,
          expiresAt: updated.expiresAt?.toISOString() ?? null,
          revision: updated.revision,
          sendAttemptId,
          outboxEventId: outbox.id,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "quote",
          entityId: updated.id,
          version: String(updated.revision),
        },
      );
      const storedMutationResult = {
        ...mutationResult,
        data: { ...mutationResult.data, shareUrl: null },
      };
      failurePhase = "idempotency_complete";
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        storedMutationResult,
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
      metadata: {
        phase: failurePhase,
        retryable:
          error instanceof TeamMutationFailure ? error.retryable : true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
