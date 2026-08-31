import { createHash, randomUUID } from "node:crypto";
import { and, inArray } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  quotePublicRateLimits,
  type DatabaseClient,
} from "@/db";
import {
  deleteExpiredQuoteRateLimitWindows,
  enforceIndependentQuotePublicRateLimits,
} from "@/lib/quote-v2-rate-limit";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describeWithDatabase("Quote V2 public rate-limit persistence", () => {
  let db: DatabaseClient;

  beforeAll(() => {
    db = getDb();
  });

  afterAll(async () => {
    await closeDbForTests();
  });

  it("bounds an invalid-token spray by its network row before token lookup", async () => {
    const testRun = randomUUID();
    const networkKeyHash = digest(`${testRun}:network`);
    const candidateHashes = [0, 1, 2, 3].map((index) =>
      digest(`${testRun}:invalid-candidate:${index}`),
    );
    const allHashes = [networkKeyHash, ...candidateHashes];
    const now = new Date("2026-08-31T12:00:05.000Z");

    try {
      const results = [];
      for (const candidateTokenKeyHash of candidateHashes.slice(0, 3)) {
        results.push(
          await enforceIndependentQuotePublicRateLimits(db, {
            scope: "respond",
            networkKeyHash,
            candidateTokenKeyHash,
            networkLimit: 2,
            candidateTokenLimit: 20,
            windowSeconds: 60,
            blockSeconds: 120,
            now,
          }),
        );
      }
      results.push(
        await enforceIndependentQuotePublicRateLimits(db, {
          scope: "respond",
          networkKeyHash,
          candidateTokenKeyHash: candidateHashes[3]!,
          networkLimit: 2,
          candidateTokenLimit: 20,
          windowSeconds: 60,
          blockSeconds: 120,
          now: new Date(now.getTime() + 60_000),
        }),
      );
      expect(results.map((result) => result.allowed)).toEqual([
        true,
        true,
        false,
        false,
      ]);
      expect(results[2]).toMatchObject({
        blockedDimension: "network",
        retryAfterSeconds: 120,
      });
      expect(results[3]).toMatchObject({
        blockedDimension: "network",
        retryAfterSeconds: 60,
      });

      const rows = await db
        .select({
          scope: quotePublicRateLimits.scope,
          scopeKeyHash: quotePublicRateLimits.scopeKeyHash,
          requestCount: quotePublicRateLimits.requestCount,
        })
        .from(quotePublicRateLimits)
        .where(inArray(quotePublicRateLimits.scopeKeyHash, allHashes));
      const networkRows = rows.filter((row) => row.scope === "respond:network");
      expect(networkRows).toHaveLength(1);
      expect(networkRows[0]).toMatchObject({
        scopeKeyHash: networkKeyHash,
        requestCount: 3,
      });
      expect(
        rows.filter((row) => row.scope === "respond:candidate_token"),
      ).toHaveLength(2);
    } finally {
      await db
        .delete(quotePublicRateLimits)
        .where(and(inArray(quotePublicRateLimits.scopeKeyHash, allHashes)));
    }
  });

  it("deletes only a bounded batch after the conservative block horizon", async () => {
    const testRun = randomUUID();
    const hashes = [0, 1].map((index) => digest(`${testRun}:old:${index}`));
    const oldWindow = new Date("2026-08-25T12:00:00.000Z");
    try {
      await db.insert(quotePublicRateLimits).values(
        hashes.map((scopeKeyHash) => ({
          scope: "read:network",
          scopeKeyHash,
          windowStart: oldWindow,
          windowSeconds: 60,
          requestCount: 1,
          createdAt: oldWindow,
          updatedAt: oldWindow,
        })),
      );
      const deleted = await db.transaction((tx) =>
        deleteExpiredQuoteRateLimitWindows(tx, {
          before: new Date("2026-08-29T12:00:00.000Z"),
          limit: 1,
        }),
      );
      expect(deleted).toBe(1);
      const remaining = await db
        .select({ id: quotePublicRateLimits.id })
        .from(quotePublicRateLimits)
        .where(inArray(quotePublicRateLimits.scopeKeyHash, hashes));
      expect(remaining).toHaveLength(1);
    } finally {
      await db
        .delete(quotePublicRateLimits)
        .where(inArray(quotePublicRateLimits.scopeKeyHash, hashes));
    }
  });
});
