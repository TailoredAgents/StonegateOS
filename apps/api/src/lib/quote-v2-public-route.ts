import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb, quotePdfDownloads, quoteVisibleEngagementEvents } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { getMediaObject } from "@/lib/media-storage";
import {
  normalizePublicQuoteIdempotencyKey,
  publicQuoteMutationKeyHash,
} from "@/lib/public-quote-mutation";
import { loadQuoteV2AttachmentContent } from "@/lib/quote-v2-attachment-service";
import {
  PublicQuoteChangeCommandSchema,
  PublicQuoteDecisionCommandSchema,
  PublicQuoteRefreshCommandSchema,
} from "@/lib/quote-v2-contract";
import {
  PUBLIC_QUOTE_HEADERS,
  quoteV2CorrelationId,
  quoteV2ErrorResponse,
  quoteV2PublicJson,
} from "@/lib/quote-v2-http";
import {
  buildQuoteV2PublicEnvelope,
  quoteV2PublicRequestHash,
  QuoteV2PublicStateError,
} from "@/lib/quote-v2-public";
import {
  loadQuoteV2CapabilityByHash,
  loadQuoteV2ProposalDocument,
  recordQuoteV2CapabilityUse,
  recordQuoteV2ChangeRequest,
  recordQuoteV2Decision,
  recordQuoteV2RefreshRequest,
} from "@/lib/quote-v2-public-service";
import { limitQuoteV2PublicCandidate } from "@/lib/quote-v2-public-rate-limit";
import { bookQuoteV2AcceptedResponse } from "@/lib/quote-v2-scheduling-service";
import type { QuotePublicRateLimitScope } from "@/lib/quote-v2-rate-limit";
import { TeamMutationFailure } from "@/lib/team-mutation";

export type QuoteV2PublicRouteResult =
  | { handled: false }
  | { handled: true; response: Response };

const PublicQuoteVisibleEngagementSchema = z
  .object({
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    event: z.literal("visible"),
    visibleMs: z.number().int().min(1_000).max(300_000),
  })
  .strict();

function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "request";
    result[path] ??= issue.message;
  }
  return result;
}

function stateErrorResponse(
  error: QuoteV2PublicStateError,
  correlationId: string,
): Response {
  return quoteV2ErrorResponse(error.code, error.message, {
    correlationId,
    fieldErrors:
      Object.keys(error.fieldErrors).length > 0 ? error.fieldErrors : undefined,
    retryable: error.code === "provider_unavailable",
  });
}

async function identifyCapability(input: {
  request: NextRequest;
  token: string;
  scope: QuotePublicRateLimitScope;
  correlationId: string;
}): Promise<{
  tokenHash?: string;
  capability?: Awaited<ReturnType<typeof loadQuoteV2CapabilityByHash>>;
  response?: Response;
} | null> {
  const mutation = input.scope !== "read";
  const limited = await limitQuoteV2PublicCandidate({
    request: input.request,
    token: input.token,
    scope: input.scope,
    correlationId: input.correlationId,
    candidateTokenLimit: mutation ? 20 : 240,
    networkLimit: mutation ? 120 : 1_200,
    windowSeconds: mutation ? 15 * 60 : 60,
    blockSeconds: mutation ? 30 * 60 : 5 * 60,
  });
  if (limited.response) return { response: limited.response };
  if (!limited.candidate) return null;
  if (!limited.tokenHash) {
    throw new Error("The public quote limiter returned no token hash.");
  }
  const capability = await loadQuoteV2CapabilityByHash(getDb(), {
    tokenHash: limited.tokenHash,
  });
  return { tokenHash: limited.tokenHash, capability };
}

/** Returns handled:false only when the token is not a V2 capability. */
export async function maybeHandleQuoteV2PublicGet(
  request: NextRequest,
  token: string,
): Promise<QuoteV2PublicRouteResult> {
  const correlationId = quoteV2CorrelationId(request);
  let identified: Awaited<ReturnType<typeof identifyCapability>>;
  try {
    identified = await identifyCapability({
      request,
      token,
      scope: "read",
      correlationId,
    });
  } catch {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "This proposal cannot be loaded right now.",
        { correlationId, retryable: true },
      ),
    };
  }
  if (identified?.response) {
    return { handled: true, response: identified.response };
  }
  if (!identified?.capability) return { handled: false };
  try {
    const envelope = buildQuoteV2PublicEnvelope(identified.capability);
    return {
      handled: true,
      response: quoteV2PublicJson({ quote: envelope }, { correlationId }),
    };
  } catch (error) {
    if (error instanceof QuoteV2PublicStateError) {
      return {
        handled: true,
        response: stateErrorResponse(error, correlationId),
      };
    }
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "The issued proposal cannot be loaded right now.",
        { correlationId, retryable: true },
      ),
    };
  }
}

/**
 * Records a browser-confirmed visible proposal, not a server render, link
 * scanner, or speculative GET. The idempotency key is hashed and used only as
 * a transaction-scoped dedupe identity.
 */
export async function maybeHandleQuoteV2VisibleEngagement(
  request: NextRequest,
  token: string,
): Promise<QuoteV2PublicRouteResult> {
  const correlationId = quoteV2CorrelationId(request);
  let identified: Awaited<ReturnType<typeof identifyCapability>>;
  try {
    identified = await identifyCapability({
      request,
      token,
      scope: "read",
      correlationId,
    });
  } catch {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "Proposal engagement could not be recorded right now.",
        { correlationId, retryable: true },
      ),
    };
  }
  if (identified?.response) {
    return { handled: true, response: identified.response };
  }
  if (!identified?.capability) return { handled: false };
  const idempotency = idempotencyDetails(request, correlationId);
  if (!idempotency.ok) return { handled: true, response: idempotency.response };
  const body = await readMutationBody(request, correlationId);
  if (!body.ok) return { handled: true, response: body.response };
  const parsed = PublicQuoteVisibleEngagementSchema.safeParse(body.body);
  if (!parsed.success) {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "invalid",
        "The proposal view could not be verified.",
        { correlationId, fieldErrors: zodFieldErrors(parsed.error) },
      ),
    };
  }
  const capability = identified.capability;
  try {
    const envelope = buildQuoteV2PublicEnvelope(capability);
    if (
      parsed.data.quoteId !== envelope.quoteId ||
      parsed.data.versionId !== envelope.versionId ||
      !envelope.allowedActions.includes("view")
    ) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "This page no longer matches the proposal being viewed.",
      );
    }
    const now = new Date();
    const replayed = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotency.hash}, 0))`,
      );
      const [existing] = await tx
        .select({ id: quoteVisibleEngagementEvents.id })
        .from(quoteVisibleEngagementEvents)
        .where(
          and(
            eq(quoteVisibleEngagementEvents.quoteId, envelope.quoteId),
            eq(quoteVisibleEngagementEvents.quoteVersionId, envelope.versionId),
            eq(
              quoteVisibleEngagementEvents.idempotencyKeyHash,
              idempotency.hash,
            ),
          ),
        )
        .limit(1);
      if (existing) return true;
      await tx.insert(quoteVisibleEngagementEvents).values({
        quoteId: envelope.quoteId,
        quoteVersionId: envelope.versionId,
        capabilityId: capability.capabilityId,
        idempotencyKeyHash: idempotency.hash,
        correlationId,
        visibleMsBucket:
          parsed.data.visibleMs < 5_000
            ? "1-5s"
            : parsed.data.visibleMs < 30_000
              ? "5-30s"
              : "30s+",
        occurredAt: now,
        createdAt: now,
      });
      await recordQuoteV2CapabilityUse(tx, {
        capabilityId: capability.capabilityId,
        at: now,
      });
      return false;
    });
    return {
      handled: true,
      response: quoteV2PublicJson(
        { ok: true, recorded: !replayed, replayed },
        { status: replayed ? 200 : 201, correlationId },
      ),
    };
  } catch (error) {
    if (error instanceof QuoteV2PublicStateError) {
      return {
        handled: true,
        response: stateErrorResponse(error, correlationId),
      };
    }
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "Proposal engagement could not be recorded right now.",
        { correlationId, retryable: true },
      ),
    };
  }
}

function safePdfFilename(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 160);
  return normalized.toLowerCase().endsWith(".pdf")
    ? normalized
    : `${normalized || "proposal"}.pdf`;
}

export async function maybeHandleQuoteV2PublicPdf(
  request: NextRequest,
  token: string,
): Promise<QuoteV2PublicRouteResult> {
  const correlationId = quoteV2CorrelationId(request);
  let identified: Awaited<ReturnType<typeof identifyCapability>>;
  try {
    identified = await identifyCapability({
      request,
      token,
      scope: "read",
      correlationId,
    });
  } catch {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "The proposal PDF cannot be loaded right now.",
        { correlationId, retryable: true },
      ),
    };
  }
  if (identified?.response) {
    return { handled: true, response: identified.response };
  }
  if (!identified?.capability) return { handled: false };

  try {
    const allowed = buildQuoteV2PublicEnvelope(
      identified.capability,
    ).allowedActions;
    if (!allowed.includes("pdf") || !identified.capability.proposalPdfHash) {
      throw new QuoteV2PublicStateError(
        "gone",
        "The proposal PDF is not available through this link.",
      );
    }
    const document = await loadQuoteV2ProposalDocument(getDb(), {
      versionId: identified.capability.versionId,
      expectedSha256: identified.capability.proposalPdfHash,
    });
    if (
      !document ||
      document.contentType !== "application/pdf" ||
      document.byteSize < 1 ||
      document.byteSize > 50 * 1024 * 1024
    ) {
      throw new QuoteV2PublicStateError(
        "provider_unavailable",
        "The issued proposal PDF is temporarily unavailable.",
      );
    }
    const bytes = await getMediaObject(
      document.storageObjectKey,
      document.byteSize,
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== document.byteSize || digest !== document.sha256) {
      throw new QuoteV2PublicStateError(
        "provider_unavailable",
        "The issued proposal PDF could not be verified.",
      );
    }
    const now = new Date();
    await Promise.all([
      recordQuoteV2CapabilityUse(getDb(), {
        capabilityId: identified.capability.capabilityId,
        at: now,
      }),
      getDb().insert(quotePdfDownloads).values({
        quoteId: identified.capability.quoteId,
        quoteVersionId: identified.capability.versionId,
        createdAt: now,
      }),
    ]);
    const headers = new Headers(PUBLIC_QUOTE_HEADERS);
    headers.set("x-correlation-id", correlationId);
    headers.set("content-type", "application/pdf");
    headers.set(
      "content-disposition",
      `attachment; filename="${safePdfFilename(document.filename)}"`,
    );
    headers.set("content-length", String(bytes.byteLength));
    return {
      handled: true,
      response: new Response(new Uint8Array(bytes), { status: 200, headers }),
    };
  } catch (error) {
    if (error instanceof QuoteV2PublicStateError) {
      return {
        handled: true,
        response: stateErrorResponse(error, correlationId),
      };
    }
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "The proposal PDF cannot be loaded right now.",
        { correlationId, retryable: true },
      ),
    };
  }
}

export async function maybeHandleQuoteV2PublicAttachment(
  request: NextRequest,
  token: string,
  attachmentId: string,
): Promise<QuoteV2PublicRouteResult> {
  const correlationId = quoteV2CorrelationId(request);
  let identified: Awaited<ReturnType<typeof identifyCapability>>;
  try {
    identified = await identifyCapability({
      request,
      token,
      scope: "read",
      correlationId,
    });
  } catch {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "The proposal attachment cannot be loaded right now.",
        { correlationId, retryable: true },
      ),
    };
  }
  if (identified?.response) {
    return { handled: true, response: identified.response };
  }
  if (!identified?.capability) return { handled: false };

  try {
    const envelope = buildQuoteV2PublicEnvelope(identified.capability);
    if (
      !envelope.allowedActions.includes("view") ||
      !envelope.attachments?.some(
        (attachment) => attachment.id === attachmentId,
      )
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The proposal attachment was not found.",
        { status: 404 },
      );
    }
    const content = await loadQuoteV2AttachmentContent(getDb(), {
      versionId: identified.capability.versionId,
      attachmentId,
      customerVisibleOnly: true,
    });
    await recordQuoteV2CapabilityUse(getDb(), {
      capabilityId: identified.capability.capabilityId,
      at: new Date(),
    });
    const headers = new Headers(PUBLIC_QUOTE_HEADERS);
    headers.set("x-correlation-id", correlationId);
    headers.set("content-type", content.contentType);
    headers.set("content-disposition", content.contentDisposition);
    headers.set("content-length", String(content.bytes.byteLength));
    headers.set("content-security-policy", "sandbox");
    headers.set("etag", `"sha256-${content.sha256}"`);
    const responseBytes = new Uint8Array(content.bytes.byteLength);
    responseBytes.set(content.bytes);
    return {
      handled: true,
      response: new Response(responseBytes, { status: 200, headers }),
    };
  } catch (error) {
    if (error instanceof QuoteV2PublicStateError) {
      return {
        handled: true,
        response: stateErrorResponse(error, correlationId),
      };
    }
    if (error instanceof TeamMutationFailure && error.status === 404) {
      return {
        handled: true,
        response: quoteV2ErrorResponse(
          "not_found",
          "The proposal attachment was not found.",
          { correlationId },
        ),
      };
    }
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "The proposal attachment cannot be loaded right now.",
        { correlationId, retryable: true },
      ),
    };
  }
}

async function readMutationBody(
  request: NextRequest,
  correlationId: string,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return {
      ok: true,
      body: await readBoundedJsonRequest(request, {
        maximumBytes: 16 * 1024,
        rejectDuplicateObjectKeys: true,
      }),
    };
  } catch (error) {
    const failure =
      error instanceof BoundedJsonRequestError
        ? error
        : new BoundedJsonRequestError(
            "invalid_body",
            "The request body could not be read.",
            400,
          );
    return {
      ok: false,
      response: quoteV2ErrorResponse("invalid", failure.message, {
        correlationId,
        fieldErrors: { request: failure.code },
      }),
    };
  }
}

function idempotencyDetails(
  request: NextRequest,
  correlationId: string,
):
  | { ok: true; normalized: string; hash: string }
  | { ok: false; response: Response } {
  const normalized = normalizePublicQuoteIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  if (!normalized) {
    return {
      ok: false,
      response: quoteV2ErrorResponse(
        "invalid",
        "An idempotency key is required. Refresh the page before trying again.",
        {
          correlationId,
          fieldErrors: { idempotencyKey: "Provide a valid request key." },
        },
      ),
    };
  }
  return {
    ok: true,
    normalized,
    hash: publicQuoteMutationKeyHash(normalized),
  };
}

async function identifyMutationCapability(input: {
  request: NextRequest;
  token: string;
  scope: "change" | "respond";
  correlationId: string;
}): Promise<
  | { handled: false }
  | {
      handled: true;
      tokenHash?: string;
      response?: Response;
    }
> {
  let identified: Awaited<ReturnType<typeof identifyCapability>>;
  try {
    identified = await identifyCapability({
      request: input.request,
      token: input.token,
      scope: input.scope,
      correlationId: input.correlationId,
    });
  } catch {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "This proposal action cannot be completed right now.",
        { correlationId: input.correlationId, retryable: true },
      ),
    };
  }
  if (!identified) return { handled: false };
  if (identified.response) {
    return { handled: true, response: identified.response };
  }
  if (!identified.tokenHash) {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "internal",
        "The request could not be completed.",
        { correlationId: input.correlationId },
      ),
    };
  }
  if (!identified.capability) return { handled: false };
  if (!isQuoteV2FeatureEnabled("mutations")) {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "Online proposal responses are temporarily unavailable. Please contact us for help.",
        { correlationId: input.correlationId, retryable: true },
      ),
    };
  }
  return { handled: true, tokenHash: identified.tokenHash };
}

export async function maybeHandleQuoteV2PublicChange(
  request: NextRequest,
  token: string,
): Promise<QuoteV2PublicRouteResult> {
  const correlationId = quoteV2CorrelationId(request);
  const identified = await identifyMutationCapability({
    request,
    token,
    scope: "change",
    correlationId,
  });
  if (!identified.handled) return { handled: false };
  if (identified.response || !identified.tokenHash) {
    return {
      handled: true,
      response:
        identified.response ??
        quoteV2ErrorResponse(
          "internal",
          "The request could not be completed.",
          {
            correlationId,
          },
        ),
    };
  }
  const idempotency = idempotencyDetails(request, correlationId);
  if (!idempotency.ok) return { handled: true, response: idempotency.response };
  const body = await readMutationBody(request, correlationId);
  if (!body.ok) return { handled: true, response: body.response };
  const parsed = PublicQuoteChangeCommandSchema.safeParse(body.body);
  if (!parsed.success) {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "invalid",
        "Complete the change request before submitting it.",
        { correlationId, fieldErrors: zodFieldErrors(parsed.error) },
      ),
    };
  }
  const requestHash = quoteV2PublicRequestHash({
    action: "change",
    command: parsed.data,
  });
  try {
    const receipt = await recordQuoteV2ChangeRequest(getDb(), {
      tokenHash: identified.tokenHash,
      command: parsed.data,
      idempotencyKeyHash: idempotency.hash,
      requestHash,
      correlationId,
    });
    const headers = new Headers(PUBLIC_QUOTE_HEADERS);
    headers.set("x-correlation-id", correlationId);
    if (receipt.replayed) headers.set("idempotency-replayed", "true");
    return {
      handled: true,
      response: Response.json(
        { ok: true, ...receipt },
        { status: receipt.replayed ? 200 : 201, headers },
      ),
    };
  } catch (error) {
    if (error instanceof QuoteV2PublicStateError) {
      return {
        handled: true,
        response: stateErrorResponse(error, correlationId),
      };
    }
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "internal",
        "The change request could not be saved. Please try again.",
        { correlationId, retryable: true },
      ),
    };
  }
}

export async function maybeHandleQuoteV2PublicRefresh(
  request: NextRequest,
  token: string,
): Promise<QuoteV2PublicRouteResult> {
  const correlationId = quoteV2CorrelationId(request);
  const identified = await identifyMutationCapability({
    request,
    token,
    scope: "change",
    correlationId,
  });
  if (!identified.handled) return { handled: false };
  if (identified.response || !identified.tokenHash) {
    return {
      handled: true,
      response:
        identified.response ??
        quoteV2ErrorResponse(
          "internal",
          "The request could not be completed.",
          { correlationId },
        ),
    };
  }
  const idempotency = idempotencyDetails(request, correlationId);
  if (!idempotency.ok) return { handled: true, response: idempotency.response };
  const body = await readMutationBody(request, correlationId);
  if (!body.ok) return { handled: true, response: body.response };
  const parsed = PublicQuoteRefreshCommandSchema.safeParse(body.body);
  if (!parsed.success) {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "invalid",
        "The updated proposal request is incomplete.",
        { correlationId, fieldErrors: zodFieldErrors(parsed.error) },
      ),
    };
  }
  const requestHash = quoteV2PublicRequestHash({
    action: "refresh",
    command: parsed.data,
  });
  try {
    const receipt = await recordQuoteV2RefreshRequest(getDb(), {
      tokenHash: identified.tokenHash,
      command: parsed.data,
      idempotencyKeyHash: idempotency.hash,
      requestHash,
      correlationId,
    });
    const headers = new Headers(PUBLIC_QUOTE_HEADERS);
    headers.set("x-correlation-id", correlationId);
    if (receipt.replayed) headers.set("idempotency-replayed", "true");
    return {
      handled: true,
      response: Response.json(
        { ok: true, ...receipt },
        { status: receipt.replayed ? 200 : 201, headers },
      ),
    };
  } catch (error) {
    if (error instanceof QuoteV2PublicStateError) {
      return {
        handled: true,
        response: stateErrorResponse(error, correlationId),
      };
    }
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "internal",
        "The updated proposal request could not be saved. Please try again.",
        { correlationId, retryable: true },
      ),
    };
  }
}

export async function maybeHandleQuoteV2PublicDecision(
  request: NextRequest,
  token: string,
): Promise<QuoteV2PublicRouteResult> {
  const correlationId = quoteV2CorrelationId(request);
  const identified = await identifyMutationCapability({
    request,
    token,
    scope: "respond",
    correlationId,
  });
  if (!identified.handled) return { handled: false };
  if (identified.response || !identified.tokenHash) {
    return {
      handled: true,
      response:
        identified.response ??
        quoteV2ErrorResponse(
          "internal",
          "The request could not be completed.",
          {
            correlationId,
          },
        ),
    };
  }
  const idempotency = idempotencyDetails(request, correlationId);
  if (!idempotency.ok) return { handled: true, response: idempotency.response };
  const body = await readMutationBody(request, correlationId);
  if (!body.ok) return { handled: true, response: body.response };
  const parsed = PublicQuoteDecisionCommandSchema.safeParse(body.body);
  if (!parsed.success) {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "invalid",
        "Complete the proposal response before submitting it.",
        { correlationId, fieldErrors: zodFieldErrors(parsed.error) },
      ),
    };
  }
  const requestHash = quoteV2PublicRequestHash({
    action: parsed.data.decision,
    command: parsed.data,
  });
  try {
    const receipt = await recordQuoteV2Decision(getDb(), {
      tokenHash: identified.tokenHash,
      command: parsed.data,
      idempotencyKeyHash: idempotency.hash,
      requestHash,
      correlationId,
      afterAcceptance: async (tx, accepted) => {
        if (accepted.acceptedDepositCents > 0 || !accepted.holdId) return null;
        const bookingKeyHash = quoteV2PublicRequestHash({
          action: "accepted_and_booked",
          acceptanceKeyHash: idempotency.hash,
          responseId: accepted.responseId,
          holdId: accepted.holdId,
        });
        const booking = await bookQuoteV2AcceptedResponse({
          tokenHash: identified.tokenHash!,
          quoteId: accepted.quoteId,
          versionId: accepted.versionId,
          responseId: accepted.responseId,
          holdId: accepted.holdId,
          idempotencyKeyHash: bookingKeyHash,
          requestHash: quoteV2PublicRequestHash({
            action: "book_after_acceptance",
            quoteId: accepted.quoteId,
            versionId: accepted.versionId,
            responseId: accepted.responseId,
            holdId: accepted.holdId,
          }),
          correlationId: accepted.correlationId,
          transaction: tx,
        });
        return {
          appointmentId: booking.appointmentId,
          outboxEventId: booking.outboxEventId,
        };
      },
    });
    const headers = new Headers(PUBLIC_QUOTE_HEADERS);
    headers.set("x-correlation-id", correlationId);
    if (receipt.replayed) headers.set("idempotency-replayed", "true");
    return {
      handled: true,
      response: Response.json({ ok: true, ...receipt }, { headers }),
    };
  } catch (error) {
    if (error instanceof QuoteV2PublicStateError) {
      return {
        handled: true,
        response: stateErrorResponse(error, correlationId),
      };
    }
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "internal",
        "The proposal response could not be saved. Please try again.",
        { correlationId, retryable: true },
      ),
    };
  }
}
