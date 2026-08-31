import type { DatabaseClient } from "@/db";
import {
  enforceIndependentQuotePublicRateLimits,
  quoteRateLimitWindow,
  type ConsumeQuotePublicRateLimitBucket,
  type QuotePublicRateLimitResult,
} from "@/lib/quote-v2-rate-limit";

describe("quote V2 durable rate limits", () => {
  it("uses deterministic fixed windows across workers", () => {
    const window = quoteRateLimitWindow({
      now: new Date("2026-08-30T12:03:42.500Z"),
      windowSeconds: 300,
    });
    expect(window.windowStart.toISOString()).toBe("2026-08-30T12:00:00.000Z");
    expect(window.resetAt.toISOString()).toBe("2026-08-30T12:05:00.000Z");
  });

  it("rejects invalid windows", () => {
    expect(() =>
      quoteRateLimitWindow({
        now: new Date("2026-08-30T12:00:00.000Z"),
        windowSeconds: 0,
      }),
    ).toThrow("whole seconds from 1 through 86400");
    expect(() =>
      quoteRateLimitWindow({
        now: new Date("2026-08-30T12:00:00.000Z"),
        windowSeconds: 86_401,
      }),
    ).toThrow("whole seconds from 1 through 86400");
  });

  it("blocks the network before creating counters for rotating candidate tokens", async () => {
    const counts = new Map<string, number>();
    const consumedScopes: string[] = [];
    const consume: ConsumeQuotePublicRateLimitBucket = (_db, input) => {
      consumedScopes.push(input.scope);
      const key = `${input.scope}:${input.scopeKeyHash}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return Promise.resolve({
        allowed: count <= input.limit,
        limit: input.limit,
        remaining: Math.max(0, input.limit - count),
        resetAt: new Date("2026-08-31T12:01:00.000Z"),
        retryAfterSeconds: count <= input.limit ? 0 : 60,
      });
    };
    const db = {} as DatabaseClient;
    const networkKeyHash = "a".repeat(64);

    for (const candidate of ["b", "c", "d", "e"]) {
      await enforceIndependentQuotePublicRateLimits(
        db,
        {
          scope: "respond",
          networkKeyHash,
          candidateTokenKeyHash: candidate.repeat(64),
          networkLimit: 2,
          candidateTokenLimit: 20,
          windowSeconds: 60,
        },
        consume,
      );
    }

    expect(
      consumedScopes.filter((scope) => scope === "respond:network"),
    ).toHaveLength(4);
    expect(
      consumedScopes.filter((scope) => scope === "respond:candidate_token"),
    ).toHaveLength(2);
    expect(
      [...counts.keys()].filter((key) =>
        key.startsWith("respond:candidate_token:"),
      ),
    ).toHaveLength(2);
  });

  it("returns the blocking dimension and durable retry guidance", async () => {
    const staged: QuotePublicRateLimitResult[] = [
      {
        allowed: true,
        limit: 100,
        remaining: 99,
        resetAt: new Date("2026-08-31T12:01:00.000Z"),
        retryAfterSeconds: 0,
      },
      {
        allowed: false,
        limit: 20,
        remaining: 0,
        resetAt: new Date("2026-08-31T12:07:00.000Z"),
        retryAfterSeconds: 420,
      },
    ];
    const consume: ConsumeQuotePublicRateLimitBucket = () => {
      const result = staged.shift();
      if (!result) throw new Error("Unexpected rate-limit bucket call");
      return Promise.resolve(result);
    };
    const result = await enforceIndependentQuotePublicRateLimits(
      {} as DatabaseClient,
      {
        scope: "checkout",
        networkKeyHash: "a".repeat(64),
        candidateTokenKeyHash: "b".repeat(64),
        networkLimit: 100,
        candidateTokenLimit: 20,
        windowSeconds: 900,
      },
      consume,
    );
    expect(result).toMatchObject({
      allowed: false,
      blockedDimension: "candidate_token",
      retryAfterSeconds: 420,
    });
  });
});
