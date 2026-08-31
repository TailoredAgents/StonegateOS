import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { hashQuoteCapabilityToken } from "@/lib/quote-v2-capability";
import {
  parsePublicQuoteToken,
  quoteV2CandidateTokenRateLimitHash,
  quoteV2ErrorResponse,
  quoteV2RequestNetworkRateLimitHash,
} from "@/lib/quote-v2-http";
import {
  enforceIndependentQuotePublicRateLimits,
  type QuotePublicRateLimitScope,
} from "@/lib/quote-v2-rate-limit";

export type QuoteV2PublicCandidateRateLimitResult =
  | { candidate: false; response?: Response }
  | { candidate: true; tokenHash?: string; response?: Response };

/**
 * Applies durable abuse controls before any quote capability or legacy share
 * lookup. Legacy tokens still continue through their compatibility handler
 * after both buckets allow the request.
 */
export async function limitQuoteV2PublicCandidate(input: {
  request: NextRequest;
  token: string;
  scope: QuotePublicRateLimitScope;
  correlationId: string;
  candidateTokenLimit: number;
  networkLimit: number;
  windowSeconds: number;
  blockSeconds: number;
}): Promise<QuoteV2PublicCandidateRateLimitResult> {
  const candidateToken = parsePublicQuoteToken(input.token);
  const normalizedCandidate = input.token.normalize("NFKC").trim();

  try {
    const result = await enforceIndependentQuotePublicRateLimits(getDb(), {
      scope: input.scope,
      networkKeyHash: quoteV2RequestNetworkRateLimitHash(input.request),
      candidateTokenKeyHash:
        quoteV2CandidateTokenRateLimitHash(normalizedCandidate),
      networkLimit: input.networkLimit,
      candidateTokenLimit: input.candidateTokenLimit,
      windowSeconds: input.windowSeconds,
      blockSeconds: input.blockSeconds,
    });
    if (!result.allowed) {
      return {
        candidate: Boolean(candidateToken),
        response: quoteV2ErrorResponse(
          "rate_limited",
          "Too many proposal requests were received. Please wait before trying again.",
          {
            correlationId: input.correlationId,
            retryable: true,
            retryAfterSeconds: result.retryAfterSeconds,
          },
        ),
      };
    }
    if (!candidateToken) return { candidate: false };
    return {
      candidate: true,
      tokenHash: hashQuoteCapabilityToken(candidateToken),
    };
  } catch {
    return {
      candidate: Boolean(candidateToken),
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "This proposal service is temporarily unavailable.",
        { correlationId: input.correlationId, retryable: true },
      ),
    };
  }
}
