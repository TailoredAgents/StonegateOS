import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseClient } from "@/db";
import {
  quoteV2EngagementRetentionCutoff,
  quoteV2RateLimitRetentionCutoff,
  QuoteV2EngagementRetentionInputError,
  runQuoteV2EngagementRetention,
} from "@/lib/quote-v2-engagement-retention";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function fakeDatabase(results: unknown[]): {
  db: DatabaseClient;
  state: { executeCalls: number; transactionCalls: number };
} {
  const state = { executeCalls: 0, transactionCalls: 0 };
  const execute = (_query: unknown): Promise<unknown> => {
    const result = results[state.executeCalls];
    state.executeCalls += 1;
    return Promise.resolve(result);
  };
  const transaction = (
    callback: (tx: { execute: typeof execute }) => unknown,
  ): Promise<unknown> => {
    state.transactionCalls += 1;
    return Promise.resolve(callback({ execute }));
  };
  return {
    db: { transaction } as unknown as DatabaseClient,
    state,
  };
}

describe("Quote V2 engagement retention", () => {
  it("uses an exact 90-day UTC retention boundary and bounded inputs", async () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    expect(quoteV2EngagementRetentionCutoff(now).toISOString()).toBe(
      "2026-06-02T12:00:00.000Z",
    );
    expect(quoteV2RateLimitRetentionCutoff(now).toISOString()).toBe(
      "2026-08-29T12:00:00.000Z",
    );

    let transactionCalls = 0;
    const db = {
      transaction: () => {
        transactionCalls += 1;
        throw new Error("unexpected_transaction");
      },
    } as unknown as DatabaseClient;
    await expect(
      runQuoteV2EngagementRetention(db, { engagementBatchSize: 0 }),
    ).rejects.toBeInstanceOf(QuoteV2EngagementRetentionInputError);
    await expect(
      runQuoteV2EngagementRetention(db, { receiptBatchSize: 10_001 }),
    ).rejects.toBeInstanceOf(QuoteV2EngagementRetentionInputError);
    await expect(
      runQuoteV2EngagementRetention(db, { rateLimitBatchSize: 10_001 }),
    ).rejects.toBeInstanceOf(QuoteV2EngagementRetentionInputError);
    expect(transactionCalls).toBe(0);
  });

  it("skips cleanly when another retention transaction owns the advisory lock", async () => {
    const { db, state } = fakeDatabase([[], [], [{ locked: false }]]);
    const result = await runQuoteV2EngagementRetention(db, {
      now: new Date("2026-08-31T12:00:00.000Z"),
    });
    expect(result).toMatchObject({
      status: "skipped_locked",
      engagementRowsAggregated: 0,
      expiredMutationReceiptsDeleted: 0,
      expiredRateLimitWindowsDeleted: 0,
    });
    expect(state.executeCalls).toBe(3);
  });

  it("returns only aggregate maintenance results after one atomic run", async () => {
    const { db, state } = fakeDatabase([
      [],
      [],
      [{ locked: true }],
      [{ engagementRowsAggregated: 5_000, aggregateBucketsTouched: 7 }],
      [{ expiredMutationReceiptsDeleted: 42 }],
      [{ deletedCount: 9 }],
    ]);
    const result = await runQuoteV2EngagementRetention(db, {
      now: new Date("2026-08-31T12:00:00.000Z"),
      engagementBatchSize: 5_000,
      receiptBatchSize: 100,
      rateLimitBatchSize: 100,
    });
    expect(result).toEqual({
      status: "completed",
      retentionDays: 90,
      cutoff: "2026-06-02T12:00:00.000Z",
      engagementRowsAggregated: 5_000,
      aggregateBucketsTouched: 7,
      expiredMutationReceiptsDeleted: 42,
      expiredRateLimitWindowsDeleted: 9,
      engagementBatchMayHaveMore: true,
      receiptBatchMayHaveMore: false,
      rateLimitBatchMayHaveMore: false,
    });
    expect(state.transactionCalls).toBe(1);
    expect(state.executeCalls).toBe(6);
    expect(JSON.stringify(result)).not.toMatch(
      /quoteId|versionId|capability|contact|token|email|phone|address/iu,
    );
  });

  it("installs retention stores, migrates old detail, and revokes deleted-contact capabilities", () => {
    const migration = source(
      "src/db/migrations/0126_quote_v2_engagement_retention.sql",
    );
    const schema = source("src/db/schema.ts");
    const maintenance = source("src/lib/quote-v2-engagement-retention.ts");
    const route = source("src/lib/quote-v2-public-route.ts");
    const operations = source("src/lib/quote-v2-operations.ts");
    const job = source("scripts/quote-v2-engagement-retention.ts");

    for (const table of [
      "quote_visible_engagement_events",
      "quote_visible_engagement_daily",
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(schema).toContain(`"${table}"`);
    }
    expect(migration).toContain("interval '90 days'");
    expect(migration).toContain(
      'DELETE FROM "quote_activity_events"\nWHERE "event_type" = \'proposal_visible\'',
    );
    expect(migration).toContain("\"revocation_reason\" = 'contact_inactive'");
    expect(migration).toContain('contact."deleted_at" IS NOT NULL');
    expect(maintenance).toContain("FOR UPDATE SKIP LOCKED");
    expect(maintenance).toContain(
      'INSERT INTO "quote_visible_engagement_daily"',
    );
    expect(maintenance).toContain(
      'DELETE FROM "quote_visible_engagement_events"',
    );
    expect(maintenance).toContain(
      'DELETE FROM "public_quote_mutation_receipts"',
    );
    expect(maintenance).toContain("deleteExpiredQuoteRateLimitWindows(tx");
    expect(
      maintenance.indexOf('INSERT INTO "quote_visible_engagement_daily"'),
    ).toBeLessThan(
      maintenance.indexOf('DELETE FROM "quote_visible_engagement_events"'),
    );
    expect(route).toContain("quoteVisibleEngagementEvents");
    expect(route).not.toContain("quoteActivityEvents");
    expect(operations).toContain("quoteVisibleEngagementEvents");
    expect(operations).not.toContain("quoteActivityEvents");
    expect(job).toContain('args[0] !== "--execute"');

    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({
        idx: 123,
        tag: "0126_quote_v2_engagement_retention",
      }),
    );
  });
});
