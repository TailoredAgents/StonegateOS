import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import {
  normalizePublicQuoteIdempotencyKey,
  publicQuoteMutationKeyHash,
} from "@/lib/public-quote-mutation";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";
import { PublicQuoteCheckoutCommandSchema } from "@/lib/quote-v2-contract";
import {
  createQuoteV2DepositCheckout,
  reconcileQuoteV2DepositForCapability,
} from "@/lib/quote-v2-deposit-service";
import {
  quoteV2CorrelationId,
  quoteV2ErrorResponse,
  quoteV2PublicJson,
} from "@/lib/quote-v2-http";
import {
  quoteV2PublicRequestHash,
  QuoteV2PublicStateError,
} from "@/lib/quote-v2-public";
import { limitQuoteV2PublicCandidate } from "@/lib/quote-v2-public-rate-limit";
import { loadQuoteV2CapabilityByHash } from "@/lib/quote-v2-public-service";

export const dynamic = "force-dynamic";

const CheckoutStatusQuerySchema = z
  .object({
    attemptId: z.string().uuid(),
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    responseId: z.string().uuid(),
  })
  .strict();

function stateError(error: QuoteV2PublicStateError, correlationId: string) {
  return quoteV2ErrorResponse(error.code, error.message, {
    correlationId,
    fieldErrors:
      Object.keys(error.fieldErrors).length > 0 ? error.fieldErrors : undefined,
    retryable: error.code === "provider_unavailable",
  });
}

async function identifyAndLimit(
  request: NextRequest,
  token: string,
  correlationId: string,
): Promise<
  { ok: true; tokenHash: string } | { ok: false; response: Response }
> {
  if (
    !isQuoteV2FeatureEnabled("public") ||
    !isQuoteV2FeatureEnabled("mutations") ||
    !isQuoteV2FeatureEnabled("deposits")
  ) {
    return {
      ok: false,
      response: quoteV2ErrorResponse(
        "not_found",
        "The proposal checkout was not found.",
        { correlationId },
      ),
    };
  }
  const limited = await limitQuoteV2PublicCandidate({
    request,
    token,
    scope: "checkout",
    correlationId,
    candidateTokenLimit: 20,
    networkLimit: 120,
    windowSeconds: 15 * 60,
    blockSeconds: 30 * 60,
  });
  if (limited.response) return { ok: false, response: limited.response };
  if (!limited.candidate) {
    return {
      ok: false,
      response: quoteV2ErrorResponse(
        "not_found",
        "The proposal checkout was not found.",
        { correlationId },
      ),
    };
  }
  if (!limited.tokenHash) {
    return {
      ok: false,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "Deposit checkout is temporarily unavailable.",
        { correlationId, retryable: true },
      ),
    };
  }
  const tokenHash = limited.tokenHash;
  let capability: Awaited<ReturnType<typeof loadQuoteV2CapabilityByHash>>;
  try {
    capability = await loadQuoteV2CapabilityByHash(getDb(), { tokenHash });
  } catch {
    return {
      ok: false,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "Deposit checkout is temporarily unavailable.",
        { correlationId, retryable: true },
      ),
    };
  }
  if (!capability) {
    return {
      ok: false,
      response: quoteV2ErrorResponse(
        "not_found",
        "The proposal checkout was not found.",
        { correlationId },
      ),
    };
  }
  return { ok: true, tokenHash };
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const correlationId = quoteV2CorrelationId(request);
  const { token } = await context.params;
  const identity = await identifyAndLimit(request, token ?? "", correlationId);
  if (!identity.ok) return identity.response;

  const idempotencyKey = normalizePublicQuoteIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  if (!idempotencyKey) {
    return quoteV2ErrorResponse(
      "invalid",
      "An idempotency key is required to start checkout.",
      {
        correlationId,
        fieldErrors: { idempotencyKey: "Refresh and try checkout again." },
      },
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, {
      maximumBytes: 8 * 1024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    const message =
      error instanceof BoundedJsonRequestError
        ? error.message
        : "The checkout request could not be read.";
    return quoteV2ErrorResponse("invalid", message, { correlationId });
  }
  const parsed = PublicQuoteCheckoutCommandSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = Object.fromEntries(
      parsed.error.issues.map((issue) => [
        issue.path.join(".") || "request",
        issue.message,
      ]),
    );
    return quoteV2ErrorResponse(
      "invalid",
      "The checkout request is incomplete.",
      { correlationId, fieldErrors },
    );
  }
  const publicSiteOrigin = resolvePublicSiteBaseUrl({
    devFallbackLocalhost: true,
  });
  if (!publicSiteOrigin) {
    return quoteV2ErrorResponse(
      "provider_unavailable",
      "Deposit checkout is temporarily unavailable.",
      { correlationId, retryable: true },
    );
  }
  try {
    const keyHash = publicQuoteMutationKeyHash(idempotencyKey);
    const receipt = await createQuoteV2DepositCheckout({
      tokenHash: identity.tokenHash,
      ...parsed.data,
      idempotencyKeyHash: keyHash,
      requestHash: quoteV2PublicRequestHash({
        action: "checkout",
        ...parsed.data,
      }),
      correlationId,
      publicSiteOrigin,
    });
    return quoteV2PublicJson(
      { ok: true, ...receipt },
      { status: receipt.replayed ? 200 : 201, correlationId },
    );
  } catch (error) {
    if (error instanceof QuoteV2PublicStateError) {
      return stateError(error, correlationId);
    }
    return quoteV2ErrorResponse(
      "provider_unavailable",
      "Deposit checkout is temporarily unavailable. Try again shortly.",
      { correlationId, retryable: true },
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const correlationId = quoteV2CorrelationId(request);
  const { token } = await context.params;
  const identity = await identifyAndLimit(request, token ?? "", correlationId);
  if (!identity.ok) return identity.response;
  const parsed = CheckoutStatusQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return quoteV2ErrorResponse(
      "invalid",
      "The checkout status request is incomplete.",
      { correlationId },
    );
  }
  try {
    const receipt = await reconcileQuoteV2DepositForCapability({
      tokenHash: identity.tokenHash,
      ...parsed.data,
    });
    return quoteV2PublicJson({ ok: true, ...receipt }, { correlationId });
  } catch (error) {
    if (error instanceof QuoteV2PublicStateError) {
      return stateError(error, correlationId);
    }
    return quoteV2ErrorResponse(
      "provider_unavailable",
      "Deposit verification is temporarily unavailable.",
      { correlationId, retryable: true },
    );
  }
}
