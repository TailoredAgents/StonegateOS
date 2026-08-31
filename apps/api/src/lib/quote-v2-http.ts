import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  QuoteV2ErrorEnvelopeSchema,
  quoteV2ErrorStatus,
  type QuoteV2ErrorCode,
} from "@/lib/quote-v2-contract";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,200}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PROXY_TIMESTAMP_PATTERN = /^\d{10}$/u;
const MAXIMUM_PROXY_CLOCK_SKEW_SECONDS = 5 * 60;

export const QUOTE_PUBLIC_NETWORK_KEY_HEADER = "x-stonegate-quote-network-key";
export const QUOTE_PUBLIC_NETWORK_TIMESTAMP_HEADER =
  "x-stonegate-quote-network-timestamp";
export const QUOTE_PUBLIC_NETWORK_SIGNATURE_HEADER =
  "x-stonegate-quote-network-signature";

export const PUBLIC_QUOTE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
} as const;

export type QuoteV2HttpErrorOptions = {
  correlationId: string;
  fieldErrors?: Record<string, string>;
  retryable?: boolean;
  retryAfterSeconds?: number;
};

export function quoteV2CorrelationId(request: NextRequest): string {
  const supplied = request.headers.get("x-correlation-id")?.trim() ?? "";
  return CORRELATION_ID_PATTERN.test(supplied) ? supplied : randomUUID();
}

export function parsePublicQuoteToken(value: string): string | null {
  const normalized = value.normalize("NFKC").trim();
  return PUBLIC_TOKEN_PATTERN.test(normalized) ? normalized : null;
}

function requiredRateLimitSecret(secret?: string): string {
  const resolved =
    secret ?? process.env["QUOTE_RATE_LIMIT_HMAC_SECRET"]?.trim();
  if (!resolved || resolved.length < 32) {
    throw new Error(
      "QUOTE_RATE_LIMIT_HMAC_SECRET must contain at least 32 characters",
    );
  }
  return resolved;
}

function hmacRateLimitIdentity(
  kind: "candidate-token" | "network-class",
  value: string,
  secret?: string,
): string {
  return createHmac("sha256", requiredRateLimitSecret(secret))
    .update(`quote-v2-rate-limit:${kind}\0${value}`, "utf8")
    .digest("hex");
}

/**
 * Hashes a capability-shaped candidate before any capability lookup. A
 * non-existent token therefore consumes the same durable bucket as a valid
 * token without persisting the bearer value itself.
 */
export function quoteV2CandidateTokenRateLimitHash(
  candidateToken: string,
  secret?: string,
): string {
  return hmacRateLimitIdentity("candidate-token", candidateToken, secret);
}

function ipv6NetworkClass(address: string): string | null {
  let candidate = address.toLowerCase();
  const zoneIndex = candidate.indexOf("%");
  if (zoneIndex >= 0) candidate = candidate.slice(0, zoneIndex);

  const embeddedIpv4 = candidate.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (embeddedIpv4) {
    const octets = embeddedIpv4.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet > 255)) {
      return null;
    }
    const first = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const second = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    candidate = candidate.replace(
      embeddedIpv4,
      `${first.toString(16)}:${second.toString(16)}`,
    );
  }

  const halves = candidate.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))
  ) {
    return null;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, "0"))
    .join(":")}::/64`;
}

export function quoteV2NetworkClass(address: string): string | null {
  const candidate = address.normalize("NFKC").trim();
  const version = isIP(candidate);
  if (version === 4) {
    const octets = candidate.split(".");
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  return version === 6 ? ipv6NetworkClass(candidate) : null;
}

function trustedProxyHops(value?: string): number | null {
  const candidate = value?.trim() ?? "";
  if (!candidate) return null;
  if (!/^\d{1,2}$/u.test(candidate)) {
    throw new Error("QUOTE_PUBLIC_TRUSTED_PROXY_HOPS must be a whole number");
  }
  const hops = Number(candidate);
  if (hops < 1 || hops > 10) {
    throw new Error("QUOTE_PUBLIC_TRUSTED_PROXY_HOPS must be between 1 and 10");
  }
  return hops;
}

/**
 * Reads X-Forwarded-For only when a deployment-declared trusted-hop count is
 * present, and selects from the trusted (right-hand) edge of the chain. A
 * browser-supplied left-most value can therefore never choose its bucket.
 */
export function quoteV2TrustedForwardedNetworkClass(
  headers: Pick<Headers, "get">,
  options: { trustedProxyHops?: string } = {},
): string | null {
  const hops = trustedProxyHops(
    options.trustedProxyHops ?? process.env["QUOTE_PUBLIC_TRUSTED_PROXY_HOPS"],
  );
  if (!hops) return null;
  const chain =
    headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  if (chain.length < hops || chain.length > 32) return null;
  return quoteV2NetworkClass(chain[chain.length - hops] ?? "");
}

function proxyNetworkSignaturePayload(input: {
  timestamp: string;
  method: string;
  pathname: string;
  networkKeyHash: string;
}): string {
  return [
    "quote-v2-public-network-v1",
    input.timestamp,
    input.method.toUpperCase(),
    input.pathname,
    input.networkKeyHash,
  ].join("\n");
}

export function quoteV2ProxyNetworkSignature(
  input: {
    timestamp: string;
    method: string;
    pathname: string;
    networkKeyHash: string;
  },
  secret?: string,
): string {
  const resolved =
    secret ?? process.env["QUOTE_PUBLIC_PROXY_SHARED_SECRET"]?.trim();
  if (!resolved || resolved.length < 32) {
    throw new Error(
      "QUOTE_PUBLIC_PROXY_SHARED_SECRET must contain at least 32 characters",
    );
  }
  return createHmac("sha256", resolved)
    .update(proxyNetworkSignaturePayload(input), "utf8")
    .digest("hex");
}

function signedProxyNetworkHash(
  request: NextRequest,
  options: { now?: Date; proxySecret?: string } = {},
): string | null {
  const networkKeyHash = request.headers
    .get(QUOTE_PUBLIC_NETWORK_KEY_HEADER)
    ?.trim();
  const timestamp = request.headers
    .get(QUOTE_PUBLIC_NETWORK_TIMESTAMP_HEADER)
    ?.trim();
  const signature = request.headers
    .get(QUOTE_PUBLIC_NETWORK_SIGNATURE_HEADER)
    ?.trim();
  const supplied = [networkKeyHash, timestamp, signature].some(Boolean);
  if (!supplied) return null;
  if (
    !networkKeyHash ||
    !SHA256_PATTERN.test(networkKeyHash) ||
    !timestamp ||
    !PROXY_TIMESTAMP_PATTERN.test(timestamp) ||
    !signature ||
    !SHA256_PATTERN.test(signature)
  ) {
    throw new Error("The public quote proxy network identity is malformed");
  }
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const suppliedSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(suppliedSeconds) ||
    Math.abs(nowSeconds - suppliedSeconds) > MAXIMUM_PROXY_CLOCK_SKEW_SECONDS
  ) {
    throw new Error("The public quote proxy network identity has expired");
  }
  const expected = quoteV2ProxyNetworkSignature(
    {
      timestamp,
      method: request.method,
      pathname: request.nextUrl.pathname,
      networkKeyHash,
    },
    options.proxySecret,
  );
  const actualBytes = Buffer.from(signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new Error("The public quote proxy network identity is invalid");
  }
  return networkKeyHash;
}

/**
 * Resolves a privacy-safe, durable network key. The authenticated site proxy
 * can forward an already-HMACed class. Direct traffic may use XFF only behind
 * an explicitly configured trusted hop count; otherwise it shares the bounded
 * unknown-direct bucket rather than trusting a caller-controlled header.
 */
export function quoteV2RequestNetworkRateLimitHash(
  request: NextRequest,
  options: {
    now?: Date;
    rateLimitSecret?: string;
    proxySecret?: string;
    trustedProxyHops?: string;
  } = {},
): string {
  const signed = signedProxyNetworkHash(request, {
    now: options.now,
    proxySecret: options.proxySecret,
  });
  if (signed) return signed;
  const networkClass = quoteV2TrustedForwardedNetworkClass(request.headers, {
    trustedProxyHops: options.trustedProxyHops,
  });
  return hmacRateLimitIdentity(
    "network-class",
    networkClass ?? "unknown-direct",
    options.rateLimitSecret,
  );
}

export function quoteV2ErrorResponse(
  code: QuoteV2ErrorCode,
  message: string,
  options: QuoteV2HttpErrorOptions,
): NextResponse {
  const headers = new Headers(PUBLIC_QUOTE_HEADERS);
  headers.set("x-correlation-id", options.correlationId);
  if (options.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(options.retryAfterSeconds));
  }
  const body = QuoteV2ErrorEnvelopeSchema.parse({
    ok: false,
    code,
    message,
    ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
    retryable: options.retryable ?? false,
    correlationId: options.correlationId,
  });
  return NextResponse.json(body, {
    status: quoteV2ErrorStatus(code),
    headers,
  });
}

export function quoteV2PublicJson(
  body: unknown,
  options: { status?: number; correlationId: string },
): NextResponse {
  const headers = new Headers(PUBLIC_QUOTE_HEADERS);
  headers.set("x-correlation-id", options.correlationId);
  return NextResponse.json(body, {
    status: options.status ?? 200,
    headers,
  });
}

/**
 * Produces a privacy-preserving abuse-control identifier. The returned digest
 * is safe to persist; raw capability and forwarded-address values are not.
 */
export function quoteV2RateLimitScopeHash(input: {
  tokenHash: string;
  networkHint: string | null;
  secret?: string;
}): string {
  const secret = requiredRateLimitSecret(input.secret);
  const networkClass = input.networkHint?.trim().slice(0, 128) || "unknown";
  return createHmac("sha256", secret)
    .update(`${input.tokenHash}:${networkClass}`, "utf8")
    .digest("hex");
}

/** @deprecated Use quoteV2RequestNetworkRateLimitHash. */
export function publicNetworkHint(request: NextRequest): string | null {
  return quoteV2TrustedForwardedNetworkClass(request.headers);
}
