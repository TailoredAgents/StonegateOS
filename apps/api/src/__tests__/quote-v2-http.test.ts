import { NextRequest } from "next/server";
import {
  parsePublicQuoteToken,
  quoteV2CandidateTokenRateLimitHash,
  quoteV2CorrelationId,
  quoteV2ErrorResponse,
  quoteV2NetworkClass,
  quoteV2ProxyNetworkSignature,
  quoteV2PublicJson,
  quoteV2RateLimitScopeHash,
  quoteV2RequestNetworkRateLimitHash,
} from "@/lib/quote-v2-http";

const RATE_SECRET = "test-only-rate-limit-secret-longer-than-32-bytes";
const PROXY_SECRET = "test-only-proxy-shared-secret-longer-than-32-bytes";

describe("quote V2 HTTP boundary", () => {
  it("accepts only bounded capability token shapes", () => {
    expect(parsePublicQuoteToken("a".repeat(43))).toBe("a".repeat(43));
    expect(parsePublicQuoteToken("short")).toBeNull();
    expect(parsePublicQuoteToken(`token/${"a".repeat(40)}`)).toBeNull();
  });

  it("preserves a safe correlation ID and replaces malformed values", () => {
    const supplied = new NextRequest(
      "https://example.test/api/public/quotes/token",
      {
        headers: { "x-correlation-id": "quote.request-123" },
      },
    );
    expect(quoteV2CorrelationId(supplied)).toBe("quote.request-123");

    const malformed = new NextRequest(
      "https://example.test/api/public/quotes/token",
      {
        headers: { "x-correlation-id": "not valid\n" },
      },
    );
    expect(quoteV2CorrelationId(malformed)).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("sets no-store, no-referrer, no-index, and stable error semantics", async () => {
    const response = quoteV2ErrorResponse(
      "provider_unavailable",
      "Availability cannot be checked right now.",
      {
        correlationId: "quote.request-123",
        retryable: true,
      },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    const limited = quoteV2ErrorResponse(
      "rate_limited",
      "Wait before trying again.",
      {
        correlationId: "quote.request-123",
        retryable: true,
        retryAfterSeconds: 420,
      },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("420");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "provider_unavailable",
      retryable: true,
      correlationId: "quote.request-123",
    });

    const success = quoteV2PublicJson(
      { ok: true },
      { correlationId: "quote.request-123" },
    );
    expect(success.headers.get("cache-control")).toContain("no-store");
  });

  it("creates deterministic HMAC rate-limit keys without retaining raw inputs", () => {
    const input = {
      tokenHash: "b".repeat(64),
      networkHint: "203.0.113.42",
      secret: "test-only-secret-that-is-longer-than-32-bytes",
    };
    const first = quoteV2RateLimitScopeHash(input);
    const second = quoteV2RateLimitScopeHash(input);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toContain(input.networkHint);
    expect(first).not.toContain(input.tokenHash);

    const candidate = "z".repeat(43);
    const candidateHash = quoteV2CandidateTokenRateLimitHash(
      candidate,
      RATE_SECRET,
    );
    expect(candidateHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(candidateHash).not.toContain(candidate);
  });

  it("uses trusted right-hand proxy hops and stable /24 or /64 classes", () => {
    expect(quoteV2NetworkClass("203.0.113.42")).toBe("203.0.113.0/24");
    expect(quoteV2NetworkClass("2001:db8:abcd:12::8")).toBe(
      "2001:0db8:abcd:0012::/64",
    );

    const first = new NextRequest("https://api.test/api/public/quotes/token", {
      headers: { "x-forwarded-for": "198.51.100.10, 203.0.113.42" },
    });
    const rotated = new NextRequest(
      "https://api.test/api/public/quotes/token",
      {
        headers: { "x-forwarded-for": "192.0.2.99, 203.0.113.42" },
      },
    );
    expect(
      quoteV2RequestNetworkRateLimitHash(first, {
        rateLimitSecret: RATE_SECRET,
        trustedProxyHops: "1",
      }),
    ).toBe(
      quoteV2RequestNetworkRateLimitHash(rotated, {
        rateLimitSecret: RATE_SECRET,
        trustedProxyHops: "1",
      }),
    );
  });

  it("ignores unsigned forwarded addresses unless trusted hops are configured", () => {
    const first = new NextRequest("https://api.test/api/public/quotes/token", {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const rotated = new NextRequest(
      "https://api.test/api/public/quotes/token",
      { headers: { "x-forwarded-for": "203.0.113.90" } },
    );
    expect(
      quoteV2RequestNetworkRateLimitHash(first, {
        rateLimitSecret: RATE_SECRET,
        trustedProxyHops: "",
      }),
    ).toBe(
      quoteV2RequestNetworkRateLimitHash(rotated, {
        rateLimitSecret: RATE_SECRET,
        trustedProxyHops: "",
      }),
    );
  });

  it("accepts only fresh, path-bound signed proxy network hashes", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const pathname = `/api/public/quotes/${"a".repeat(43)}`;
    const networkKeyHash = quoteV2RequestNetworkRateLimitHash(
      new NextRequest("https://api.test/direct"),
      { rateLimitSecret: RATE_SECRET, trustedProxyHops: "" },
    );
    const signature = quoteV2ProxyNetworkSignature(
      { timestamp, method: "GET", pathname, networkKeyHash },
      PROXY_SECRET,
    );
    const request = new NextRequest(`https://api.test${pathname}`, {
      headers: {
        "x-stonegate-quote-network-key": networkKeyHash,
        "x-stonegate-quote-network-timestamp": timestamp,
        "x-stonegate-quote-network-signature": signature,
      },
    });
    expect(
      quoteV2RequestNetworkRateLimitHash(request, {
        now,
        rateLimitSecret: RATE_SECRET,
        proxySecret: PROXY_SECRET,
      }),
    ).toBe(networkKeyHash);

    request.headers.set("x-stonegate-quote-network-signature", "0".repeat(64));
    expect(() =>
      quoteV2RequestNetworkRateLimitHash(request, {
        now,
        rateLimitSecret: RATE_SECRET,
        proxySecret: PROXY_SECRET,
      }),
    ).toThrow("proxy network identity is invalid");
  });
});
