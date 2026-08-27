import "dotenv/config";
import { and, asc, eq, gt, isNotNull, isNull, like, sql } from "drizzle-orm";
import { expenseReceiptCaptures, expenses, getDb } from "../src/db";
import {
  getMediaObject,
  getMediaStorageProvider,
  headMediaObject,
  putMediaObject,
} from "../src/lib/media-storage";
import {
  LegacyReceiptBackfillError,
  parseLegacyReceiptBackfillArgs,
  runLegacyReceiptBackfill,
  safeLegacyReceiptErrorCode,
  type LegacyExpenseReceiptCapture,
  type LegacyReceiptObjectStorage,
  type LegacyReceiptRepository,
  type NewLegacyExpenseReceiptCapture,
} from "./legacy-expense-receipt-backfill-core";

/**
 * Production runbook (aggregate output only):
 *
 *   tsx apps/api/scripts/legacy-expense-receipt-backfill.ts --limit=10
 *   tsx apps/api/scripts/legacy-expense-receipt-backfill.ts --execute --limit=10
 *   tsx apps/api/scripts/legacy-expense-receipt-backfill.ts --cleanup --limit=10
 *   tsx apps/api/scripts/legacy-expense-receipt-backfill.ts --cleanup --execute \
 *     --confirm-verified-cleanup=CLEAR_VERIFIED_LEGACY_RECEIPTS --limit=10
 *
 * Use the returned opaque nextCursor as --after=<cursor>. Migration never
 * clears receipt_url. Cleanup is separate, hash-verifies an R2 re-read, and
 * only clears linked drafts because posted ledger evidence is immutable.
 */

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    value.name === "NotFound" ||
    value.name === "NoSuchKey" ||
    value.$metadata?.httpStatusCode === 404
  );
}

function toCapture(
  row: typeof expenseReceiptCaptures.$inferSelect,
): LegacyExpenseReceiptCapture {
  return {
    id: row.id,
    submittedBy: row.submittedBy,
    status: row.status,
    storageProvider: row.storageProvider,
    originalObjectKey: row.originalObjectKey,
    normalizedObjectKey: row.normalizedObjectKey,
    filename: row.filename,
    declaredContentType: row.declaredContentType,
    verifiedContentType: row.verifiedContentType,
    byteLength: row.byteLength,
    sha256: row.sha256,
  };
}

function createRepository(): LegacyReceiptRepository {
  const db = getDb();
  return {
    async listCandidates(input) {
      const scope =
        input.operation === "migrate"
          ? isNull(expenses.receiptCaptureId)
          : isNotNull(expenses.receiptCaptureId);
      return db
        .select({
          expenseId: expenses.id,
          submittedBy: expenses.submittedBy,
          lifecycleStatus: expenses.lifecycleStatus,
          version: expenses.version,
          receiptCaptureId: expenses.receiptCaptureId,
          receiptUrl: sql<string>`${expenses.receiptUrl}`,
          receiptFilename: expenses.receiptFilename,
          receiptContentType: expenses.receiptContentType,
        })
        .from(expenses)
        .where(
          and(
            like(expenses.receiptUrl, "data:%"),
            scope,
            input.afterExpenseId
              ? gt(expenses.id, input.afterExpenseId)
              : undefined,
          ),
        )
        .orderBy(asc(expenses.id))
        .limit(input.limit);
    },

    async findCapture(captureId) {
      const [row] = await db
        .select()
        .from(expenseReceiptCaptures)
        .where(eq(expenseReceiptCaptures.id, captureId))
        .limit(1);
      return row ? toCapture(row) : null;
    },

    async insertCapture(capture: NewLegacyExpenseReceiptCapture) {
      await db
        .insert(expenseReceiptCaptures)
        .values(capture)
        .onConflictDoNothing({ target: expenseReceiptCaptures.id });
      const [stored] = await db
        .select()
        .from(expenseReceiptCaptures)
        .where(eq(expenseReceiptCaptures.id, capture.id))
        .limit(1);
      if (!stored) {
        throw new LegacyReceiptBackfillError("receipt_capture_insert_failed");
      }
      return toCapture(stored);
    },

    async attachCaptureToDraft(input) {
      const updated = await db
        .update(expenses)
        .set({
          receiptCaptureId: input.captureId,
          version: sql`${expenses.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(expenses.id, input.expenseId),
            eq(expenses.version, input.expectedVersion),
            eq(expenses.lifecycleStatus, "draft"),
            isNull(expenses.receiptCaptureId),
          ),
        )
        .returning({ id: expenses.id });
      if (updated.length === 1) return true;
      const [current] = await db
        .select({ receiptCaptureId: expenses.receiptCaptureId })
        .from(expenses)
        .where(eq(expenses.id, input.expenseId))
        .limit(1);
      return current?.receiptCaptureId === input.captureId;
    },

    async clearLegacyDataUrlFromDraft(input) {
      const updated = await db
        .update(expenses)
        .set({
          receiptUrl: null,
          version: sql`${expenses.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(expenses.id, input.expenseId),
            eq(expenses.version, input.expectedVersion),
            eq(expenses.lifecycleStatus, "draft"),
            eq(expenses.receiptCaptureId, input.captureId),
            eq(expenses.receiptUrl, input.expectedReceiptUrl),
          ),
        )
        .returning({ id: expenses.id });
      return updated.length === 1;
    },
  };
}

function createStorage(provider: "r2" | "s3"): LegacyReceiptObjectStorage {
  return {
    provider,
    async read(key) {
      try {
        return await getMediaObject(key);
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
    },
    async head(key) {
      try {
        return await headMediaObject(key);
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
    },
    async write(input) {
      await putMediaObject(input);
    },
  };
}

async function main(): Promise<void> {
  const options = parseLegacyReceiptBackfillArgs(process.argv.slice(2));
  // A migration-only dry run does not initialize object storage unless it
  // encounters a deterministic capture that must be re-verified. Cleanup and
  // execute modes always resolve and exercise the configured provider.
  const provider =
    options.mode === "execute" || options.operation === "cleanup"
      ? getMediaStorageProvider()
      : "r2";
  const report = await runLegacyReceiptBackfill(options, {
    repository: createRepository(),
    storage: createStorage(provider),
  });
  // The report is aggregate-only: it intentionally contains no receipt data,
  // filenames, vendors, submitters, members, or object keys.
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, error: safeLegacyReceiptErrorCode(error) }),
  );
  process.exitCode = 1;
});
