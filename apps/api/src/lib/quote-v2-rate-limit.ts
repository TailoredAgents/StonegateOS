import { and, desc, eq, gt, sql } from "drizzle-orm";
import { quotePublicRateLimits, type DatabaseClient } from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

export type QuotePublicRateLimitScope =
  | "read"
  | "change"
  | "respond"
  | "availability"
  | "hold"
  | "checkout"
  | "book";

export type QuotePublicRateLimitDimension = "network" | "candidate_token";
export type QuotePublicRateLimitBucket =
  `${QuotePublicRateLimitScope}:${QuotePublicRateLimitDimension}`;

export type QuotePublicRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
};

export type QuotePublicIndependentRateLimitResult =
  QuotePublicRateLimitResult & {
    blockedDimension: QuotePublicRateLimitDimension | null;
  };

export type ConsumeQuotePublicRateLimitBucket = (
  db: TeamMutationTransaction,
  input: {
    scope: QuotePublicRateLimitBucket;
    scopeKeyHash: string;
    limit: number;
    windowSeconds: number;
    blockSeconds?: number;
    now?: Date;
  },
) => Promise<QuotePublicRateLimitResult>;

export function quoteRateLimitWindow(input: {
  now: Date;
  windowSeconds: number;
}): { windowStart: Date; resetAt: Date } {
  if (
    !Number.isInteger(input.windowSeconds) ||
    input.windowSeconds < 1 ||
    input.windowSeconds > 24 * 60 * 60
  ) {
    throw new Error(
      "Rate-limit windows must use whole seconds from 1 through 86400.",
    );
  }
  const windowMs = input.windowSeconds * 1_000;
  const windowStart = new Date(
    Math.floor(input.now.getTime() / windowMs) * windowMs,
  );
  return { windowStart, resetAt: new Date(windowStart.getTime() + windowMs) };
}

export async function enforceQuotePublicRateLimit(
  db: TeamMutationTransaction,
  input: {
    scope: QuotePublicRateLimitScope | QuotePublicRateLimitBucket;
    scopeKeyHash: string;
    limit: number;
    windowSeconds: number;
    blockSeconds?: number;
    now?: Date;
  },
): Promise<QuotePublicRateLimitResult> {
  if (!/^[0-9a-f]{64}$/u.test(input.scopeKeyHash)) {
    throw new Error("Rate-limit scope keys must be SHA-256/HMAC digests.");
  }
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 10_000
  ) {
    throw new Error("Rate-limit thresholds must be between 1 and 10000.");
  }
  const now = input.now ?? new Date();
  const { windowStart, resetAt } = quoteRateLimitWindow({
    now,
    windowSeconds: input.windowSeconds,
  });
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.scope}:${input.scopeKeyHash}`}, 0))`,
  );
  const [activeBlock] = await db
    .select({ blockedUntil: quotePublicRateLimits.blockedUntil })
    .from(quotePublicRateLimits)
    .where(
      and(
        eq(quotePublicRateLimits.scope, input.scope),
        eq(quotePublicRateLimits.scopeKeyHash, input.scopeKeyHash),
        gt(quotePublicRateLimits.blockedUntil, now),
      ),
    )
    .orderBy(desc(quotePublicRateLimits.blockedUntil))
    .limit(1);
  if (activeBlock?.blockedUntil) {
    return {
      allowed: false,
      limit: input.limit,
      remaining: 0,
      resetAt: activeBlock.blockedUntil,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((activeBlock.blockedUntil.getTime() - now.getTime()) / 1_000),
      ),
    };
  }
  const [counter] = await db
    .insert(quotePublicRateLimits)
    .values({
      scope: input.scope,
      scopeKeyHash: input.scopeKeyHash,
      windowStart,
      windowSeconds: input.windowSeconds,
      requestCount: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        quotePublicRateLimits.scope,
        quotePublicRateLimits.scopeKeyHash,
        quotePublicRateLimits.windowStart,
        quotePublicRateLimits.windowSeconds,
      ],
      set: {
        requestCount: sql`${quotePublicRateLimits.requestCount} + 1`,
        updatedAt: now,
      },
    })
    .returning({
      id: quotePublicRateLimits.id,
      requestCount: quotePublicRateLimits.requestCount,
      blockedUntil: quotePublicRateLimits.blockedUntil,
    });
  if (!counter)
    throw new Error("The public quote rate limit could not be recorded.");

  const alreadyBlocked = Boolean(
    counter.blockedUntil && counter.blockedUntil.getTime() > now.getTime(),
  );
  const exceeded = counter.requestCount > input.limit;
  let blockedUntil = counter.blockedUntil;
  if (exceeded && !alreadyBlocked) {
    const blockSeconds = Math.max(
      input.windowSeconds,
      Math.min(input.blockSeconds ?? input.windowSeconds, 24 * 60 * 60),
    );
    blockedUntil = new Date(now.getTime() + blockSeconds * 1_000);
    await db
      .update(quotePublicRateLimits)
      .set({ blockedUntil, updatedAt: now })
      .where(eq(quotePublicRateLimits.id, counter.id));
  }

  const allowed = !alreadyBlocked && !exceeded;
  const effectiveReset =
    blockedUntil && blockedUntil > resetAt ? blockedUntil : resetAt;
  return {
    allowed,
    limit: input.limit,
    remaining: Math.max(0, input.limit - counter.requestCount),
    resetAt: effectiveReset,
    retryAfterSeconds: allowed
      ? 0
      : Math.max(
          1,
          Math.ceil((effectiveReset.getTime() - now.getTime()) / 1_000),
        ),
  };
}

/**
 * Consumes the independently keyed network bucket before the candidate-token
 * bucket. Once a network is blocked, rotating token candidates cannot create
 * an unbounded set of database counter rows.
 */
export async function enforceIndependentQuotePublicRateLimits(
  db: DatabaseClient,
  input: {
    scope: QuotePublicRateLimitScope;
    networkKeyHash: string;
    candidateTokenKeyHash: string;
    networkLimit: number;
    candidateTokenLimit: number;
    windowSeconds: number;
    blockSeconds?: number;
    now?: Date;
  },
  consumeBucket?: ConsumeQuotePublicRateLimitBucket,
): Promise<QuotePublicIndependentRateLimitResult> {
  const consumeInOrder = async (
    executor: TeamMutationTransaction,
    consume: ConsumeQuotePublicRateLimitBucket,
  ): Promise<QuotePublicIndependentRateLimitResult> => {
    const shared = {
      windowSeconds: input.windowSeconds,
      ...(input.blockSeconds === undefined
        ? {}
        : { blockSeconds: input.blockSeconds }),
      ...(input.now === undefined ? {} : { now: input.now }),
    };
    const network = await consume(executor, {
      ...shared,
      scope: `${input.scope}:network`,
      scopeKeyHash: input.networkKeyHash,
      limit: input.networkLimit,
    });
    if (!network.allowed) {
      return { ...network, blockedDimension: "network" };
    }

    const candidateToken = await consume(executor, {
      ...shared,
      scope: `${input.scope}:candidate_token`,
      scopeKeyHash: input.candidateTokenKeyHash,
      limit: input.candidateTokenLimit,
    });
    return {
      ...candidateToken,
      blockedDimension: candidateToken.allowed ? null : "candidate_token",
    };
  };

  if (consumeBucket) {
    return consumeInOrder(
      db as unknown as TeamMutationTransaction,
      consumeBucket,
    );
  }
  return db.transaction((tx) =>
    consumeInOrder(tx, enforceQuotePublicRateLimit),
  );
}

export async function deleteExpiredQuoteRateLimitWindows(
  db: TeamMutationTransaction,
  input: { before: Date; limit: number },
): Promise<number> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 10_000
  ) {
    throw new Error("Rate-limit cleanup batches must be between 1 and 10000.");
  }
  if (!Number.isFinite(input.before.getTime())) {
    throw new Error("Rate-limit cleanup requires a valid cutoff date.");
  }
  const cutoff = input.before.toISOString();
  const result = await db.execute(sql`
    WITH eligible AS MATERIALIZED (
      SELECT "id"
      FROM "quote_public_rate_limits"
      WHERE "window_start" < ${cutoff}::timestamptz
        AND ("blocked_until" IS NULL OR "blocked_until" < ${cutoff}::timestamptz)
      ORDER BY "window_start" ASC, "id" ASC
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    ),
    deleted AS (
      DELETE FROM "quote_public_rate_limits" AS rate_limit
      USING eligible
      WHERE rate_limit."id" = eligible."id"
      RETURNING rate_limit."id"
    )
    SELECT count(*)::integer AS "deletedCount"
    FROM deleted
  `);
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === "object" && "rows" in result
      ? (result as { rows?: unknown }).rows
      : null;
  const first = Array.isArray(rows) ? (rows[0] as unknown) : null;
  const count =
    first && typeof first === "object" && "deletedCount" in first
      ? Number((first as { deletedCount?: unknown }).deletedCount)
      : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("The public quote rate-limit cleanup returned no count.");
  }
  return count;
}
