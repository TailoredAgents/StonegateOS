import { sql } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import { deleteExpiredQuoteRateLimitWindows } from "@/lib/quote-v2-rate-limit";

export const QUOTE_V2_ENGAGEMENT_DETAIL_RETENTION_DAYS = 90;
export const QUOTE_V2_RETENTION_DEFAULT_BATCH_SIZE = 5_000;
export const QUOTE_V2_RETENTION_MAX_BATCH_SIZE = 10_000;
export const QUOTE_V2_RATE_LIMIT_WINDOW_RETENTION_HOURS = 48;

const DAY_MS = 24 * 60 * 60 * 1_000;

export type QuoteV2EngagementRetentionOptions = {
  now?: Date;
  engagementBatchSize?: number;
  receiptBatchSize?: number;
  rateLimitBatchSize?: number;
};

export type QuoteV2EngagementRetentionResult = {
  status: "completed" | "skipped_locked";
  retentionDays: number;
  cutoff: string;
  engagementRowsAggregated: number;
  aggregateBucketsTouched: number;
  expiredMutationReceiptsDeleted: number;
  expiredRateLimitWindowsDeleted: number;
  engagementBatchMayHaveMore: boolean;
  receiptBatchMayHaveMore: boolean;
  rateLimitBatchMayHaveMore: boolean;
};

export class QuoteV2EngagementRetentionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteV2EngagementRetentionInputError";
  }
}

function boundedBatchSize(value: number | undefined, field: string): number {
  const candidate = value ?? QUOTE_V2_RETENTION_DEFAULT_BATCH_SIZE;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > QUOTE_V2_RETENTION_MAX_BATCH_SIZE
  ) {
    throw new QuoteV2EngagementRetentionInputError(
      `${field} must be a whole number from 1 through ${QUOTE_V2_RETENTION_MAX_BATCH_SIZE}.`,
    );
  }
  return candidate;
}

function validNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new QuoteV2EngagementRetentionInputError("now must be a valid date.");
  }
  return now;
}

export function quoteV2EngagementRetentionCutoff(now: Date): Date {
  const safeNow = validNow(now);
  return new Date(
    safeNow.getTime() - QUOTE_V2_ENGAGEMENT_DETAIL_RETENTION_DAYS * DAY_MS,
  );
}

export function quoteV2RateLimitRetentionCutoff(now: Date): Date {
  const safeNow = validNow(now);
  return new Date(
    safeNow.getTime() -
      QUOTE_V2_RATE_LIMIT_WINDOW_RETENTION_HOURS * 60 * 60 * 1_000,
  );
}

function firstRow(result: unknown): Record<string, unknown> | null {
  if (Array.isArray(result)) {
    const row: unknown = (result as unknown[])[0];
    return row && typeof row === "object"
      ? (row as Record<string, unknown>)
      : null;
  }
  if (result && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      const row: unknown = (rows as unknown[])[0];
      return row && typeof row === "object"
        ? (row as Record<string, unknown>)
        : null;
    }
  }
  return null;
}

function safeCount(row: Record<string, unknown> | null, field: string): number {
  const value = row?.[field];
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number" || typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`quote_v2_retention_invalid_${field}`);
  }
  return parsed;
}

/**
 * Atomically aggregates then deletes bounded engagement detail older than 90
 * days and removes bounded expired public-mutation replay receipts. A global
 * transaction advisory lock makes concurrent scheduler invocations a no-op;
 * adding counts and deleting their exact source rows in the same transaction
 * makes every completed invocation idempotent and restart-safe.
 */
export async function runQuoteV2EngagementRetention(
  db: DatabaseClient,
  options: QuoteV2EngagementRetentionOptions = {},
): Promise<QuoteV2EngagementRetentionResult> {
  const now = validNow(options.now);
  const cutoff = quoteV2EngagementRetentionCutoff(now);
  const rateLimitCutoff = quoteV2RateLimitRetentionCutoff(now);
  const nowIso = now.toISOString();
  const cutoffIso = cutoff.toISOString();
  const engagementBatchSize = boundedBatchSize(
    options.engagementBatchSize,
    "engagementBatchSize",
  );
  const receiptBatchSize = boundedBatchSize(
    options.receiptBatchSize,
    "receiptBatchSize",
  );
  const rateLimitBatchSize = boundedBatchSize(
    options.rateLimitBatchSize,
    "rateLimitBatchSize",
  );

  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    const lockResult = await tx.execute(sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended('quote-v2-engagement-retention', 0)
      ) AS "locked"
    `);
    if (firstRow(lockResult)?.["locked"] !== true) {
      return {
        status: "skipped_locked" as const,
        retentionDays: QUOTE_V2_ENGAGEMENT_DETAIL_RETENTION_DAYS,
        cutoff: cutoff.toISOString(),
        engagementRowsAggregated: 0,
        aggregateBucketsTouched: 0,
        expiredMutationReceiptsDeleted: 0,
        expiredRateLimitWindowsDeleted: 0,
        engagementBatchMayHaveMore: false,
        receiptBatchMayHaveMore: false,
        rateLimitBatchMayHaveMore: false,
      };
    }

    const engagementResult = await tx.execute(sql`
      WITH eligible AS MATERIALIZED (
        SELECT
          detail."id",
          (detail."occurred_at" AT TIME ZONE 'UTC')::date AS "engagement_date",
          detail."visible_ms_bucket",
          detail."occurred_at"
        FROM "quote_visible_engagement_events" AS detail
        WHERE detail."occurred_at" < ${cutoffIso}::timestamptz
        ORDER BY detail."occurred_at" ASC, detail."id" ASC
        LIMIT ${engagementBatchSize}
        FOR UPDATE SKIP LOCKED
      ),
      aggregated AS MATERIALIZED (
        SELECT
          eligible."engagement_date",
          eligible."visible_ms_bucket",
          count(*)::bigint AS "event_count",
          min(eligible."occurred_at") AS "first_occurred_at",
          max(eligible."occurred_at") AS "last_occurred_at"
        FROM eligible
        GROUP BY eligible."engagement_date", eligible."visible_ms_bucket"
      ),
      upserted AS (
        INSERT INTO "quote_visible_engagement_daily" (
          "engagement_date",
          "visible_ms_bucket",
          "event_count",
          "first_occurred_at",
          "last_occurred_at",
          "updated_at"
        )
        SELECT
          aggregated."engagement_date",
          aggregated."visible_ms_bucket",
          aggregated."event_count",
          aggregated."first_occurred_at",
          aggregated."last_occurred_at",
          ${nowIso}::timestamptz
        FROM aggregated
        ON CONFLICT ("engagement_date", "visible_ms_bucket") DO UPDATE
        SET "event_count" = "quote_visible_engagement_daily"."event_count" + EXCLUDED."event_count",
            "first_occurred_at" = LEAST("quote_visible_engagement_daily"."first_occurred_at", EXCLUDED."first_occurred_at"),
            "last_occurred_at" = GREATEST("quote_visible_engagement_daily"."last_occurred_at", EXCLUDED."last_occurred_at"),
            "updated_at" = EXCLUDED."updated_at"
        RETURNING "engagement_date", "visible_ms_bucket"
      ),
      deleted AS (
        DELETE FROM "quote_visible_engagement_events" AS detail
        USING eligible
        WHERE detail."id" = eligible."id"
          AND EXISTS (SELECT 1 FROM upserted)
        RETURNING detail."id"
      )
      SELECT
        (SELECT count(*)::integer FROM deleted) AS "engagementRowsAggregated",
        (SELECT count(*)::integer FROM upserted) AS "aggregateBucketsTouched"
    `);
    const engagementRow = firstRow(engagementResult);
    const engagementRowsAggregated = safeCount(
      engagementRow,
      "engagementRowsAggregated",
    );
    const aggregateBucketsTouched = safeCount(
      engagementRow,
      "aggregateBucketsTouched",
    );

    const receiptResult = await tx.execute(sql`
      WITH eligible AS MATERIALIZED (
        SELECT receipt."id"
        FROM "public_quote_mutation_receipts" AS receipt
        WHERE receipt."expires_at" <= ${nowIso}::timestamptz
        ORDER BY receipt."expires_at" ASC, receipt."id" ASC
        LIMIT ${receiptBatchSize}
        FOR UPDATE SKIP LOCKED
      ),
      deleted AS (
        DELETE FROM "public_quote_mutation_receipts" AS receipt
        USING eligible
        WHERE receipt."id" = eligible."id"
        RETURNING receipt."id"
      )
      SELECT count(*)::integer AS "expiredMutationReceiptsDeleted"
      FROM deleted
    `);
    const expiredMutationReceiptsDeleted = safeCount(
      firstRow(receiptResult),
      "expiredMutationReceiptsDeleted",
    );
    const expiredRateLimitWindowsDeleted =
      await deleteExpiredQuoteRateLimitWindows(tx, {
        before: rateLimitCutoff,
        limit: rateLimitBatchSize,
      });

    return {
      status: "completed" as const,
      retentionDays: QUOTE_V2_ENGAGEMENT_DETAIL_RETENTION_DAYS,
      cutoff: cutoff.toISOString(),
      engagementRowsAggregated,
      aggregateBucketsTouched,
      expiredMutationReceiptsDeleted,
      expiredRateLimitWindowsDeleted,
      engagementBatchMayHaveMore:
        engagementRowsAggregated === engagementBatchSize,
      receiptBatchMayHaveMore:
        expiredMutationReceiptsDeleted === receiptBatchSize,
      rateLimitBatchMayHaveMore:
        expiredRateLimitWindowsDeleted === rateLimitBatchSize,
    };
  });
}
