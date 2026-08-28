import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  expenseDumpDetails,
  expenseReceiptCaptures,
  expenses,
  type DatabaseClient,
} from "@/db";
import { normalizeReceiptVendor } from "@/lib/expense-receipt-domain";
import type { ExpenseReceipt } from "@/lib/expense-lifecycle";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import {
  deleteMediaObject,
  getMediaStorageProvider,
  putImmutableMediaObject,
} from "@/lib/media-storage";
import {
  buildExpenseReceiptObjectKeys,
  verifyAndNormalizeExpenseReceiptUpload,
} from "@/lib/expense-receipt-storage";

export type StagedExpenseReceiptEvidence = {
  capture: typeof expenseReceiptCaptures.$inferInsert;
  objectKeys: string[];
};

/**
 * Store a server-received manual receipt using the same immutable-original and
 * normalized-derivative rules as mobile capture. The caller co-commits the
 * returned capture row with its expense and cleans the staged objects if that
 * database transaction fails.
 */
export async function stageExpenseReceiptEvidence(input: {
  captureId: string;
  submittedBy: string;
  receipt: ExpenseReceipt;
  now?: Date;
}): Promise<StagedExpenseReceiptEvidence> {
  const now = input.now ?? new Date();
  const verified = await verifyAndNormalizeExpenseReceiptUpload({
    bytes: input.receipt.bytes,
    declaredContentType: input.receipt.contentType,
    declaredByteLength: input.receipt.byteLength,
    expectedSha256: input.receipt.sha256,
  });
  const keys = buildExpenseReceiptObjectKeys({
    memberId: input.submittedBy,
    captureId: input.captureId,
    contentType: verified.verifiedContentType,
  });
  const uploadedKeys: string[] = [];

  try {
    const originalWrite = await putImmutableMediaObject({
      key: keys.originalObjectKey,
      body: verified.originalBytes,
      contentType: verified.verifiedContentType,
    });
    if (originalWrite === "created") uploadedKeys.push(keys.originalObjectKey);

    let normalizedObjectKey: string | null = null;
    if (verified.normalized && keys.normalizedObjectKey) {
      normalizedObjectKey = keys.normalizedObjectKey;
      const normalizedWrite = await putImmutableMediaObject({
        key: normalizedObjectKey,
        body: verified.normalized.bytes,
        contentType: verified.normalized.contentType,
      });
      if (normalizedWrite === "created") uploadedKeys.push(normalizedObjectKey);
    }

    return {
      capture: {
        id: input.captureId,
        submittedBy: input.submittedBy,
        status: "confirmed",
        storageProvider: getMediaStorageProvider(),
        originalObjectKey: keys.originalObjectKey,
        normalizedObjectKey,
        filename: input.receipt.filename,
        declaredContentType: input.receipt.contentType,
        verifiedContentType: verified.verifiedContentType,
        byteLength: verified.byteLength,
        sha256: verified.sha256,
        uploadExpiresAt: now,
        uploadedAt: now,
        analysisAttemptCount: 0,
        confirmedAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      objectKeys: uploadedKeys,
    };
  } catch (error) {
    await Promise.allSettled(
      [...uploadedKeys].reverse().map((key) => deleteMediaObject(key)),
    );
    throw error;
  }
}

export async function cleanupStagedExpenseReceiptEvidence(
  evidence: StagedExpenseReceiptEvidence,
): Promise<void> {
  await Promise.allSettled(
    [...evidence.objectKeys].reverse().map((key) => deleteMediaObject(key)),
  );
}

/**
 * A database COMMIT can succeed even when its acknowledgement is lost. Never
 * delete staged evidence after an ambiguous transaction result unless a fresh
 * primary-database read proves that the capture row did not commit. If that
 * read is unavailable, retaining an orphan for reconciliation is safer than
 * destroying evidence referenced by a committed ledger row.
 */
export async function cleanupStagedExpenseReceiptEvidenceIfUncommitted(
  db: DatabaseClient,
  evidence: StagedExpenseReceiptEvidence,
): Promise<"cleaned" | "retained_committed" | "retained_unverified"> {
  let committed = false;
  try {
    const [capture] = await db
      .select({ id: expenseReceiptCaptures.id })
      .from(expenseReceiptCaptures)
      .where(eq(expenseReceiptCaptures.id, evidence.capture.id as string))
      .limit(1);
    committed = Boolean(capture);
  } catch {
    return "retained_unverified";
  }
  if (committed) return "retained_committed";
  await cleanupStagedExpenseReceiptEvidence(evidence);
  return "cleaned";
}

/** Serialize posting by digest so two concurrently analyzed/uploaded copies
 * cannot both cross into the ledger without an explicit duplicate decision. */
export async function findExactExpenseReceiptDuplicateForPosting(
  tx: TeamMutationTransaction,
  input: { captureId: string; sha256: string | null },
): Promise<string | null> {
  if (!input.sha256) return null;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`expense-receipt-sha:${input.sha256}`}, 0))`,
  );
  const [duplicate] = await tx
    .select({ id: expenseReceiptCaptures.id })
    .from(expenseReceiptCaptures)
    .where(
      and(
        ne(expenseReceiptCaptures.id, input.captureId),
        eq(expenseReceiptCaptures.sha256, input.sha256),
        inArray(expenseReceiptCaptures.status, [
          "uploaded",
          "queued",
          "analyzing",
          "ready",
          "confirmed",
        ]),
      ),
    )
    .limit(1);
  return duplicate?.id ?? null;
}

export function normalizeScaleTicketDuplicateIdentity(input: {
  facilityName: string | null;
  ticketNumber: string | null;
}): { facilityName: string; ticketNumber: string } | null {
  const facilityName = normalizeReceiptVendor(input.facilityName);
  const ticketNumber = normalizeReceiptVendor(input.ticketNumber);
  return facilityName && ticketNumber ? { facilityName, ticketNumber } : null;
}

/**
 * A second photograph has a different SHA, so serialize and compare the two
 * stable human-reviewed scale-ticket identifiers before ledger posting.
 */
export async function findScaleTicketDuplicateForPosting(
  tx: TeamMutationTransaction,
  input: {
    facilityName: string | null;
    ticketNumber: string | null;
    excludeExpenseIds?: readonly string[];
  },
): Promise<string | null> {
  const normalized = normalizeScaleTicketDuplicateIdentity(input);
  if (!normalized) return null;
  const lockKey = `expense-scale-ticket:${normalized.facilityName}:${normalized.ticketNumber}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );

  const candidates = await tx
    .select({
      expenseId: expenseDumpDetails.expenseId,
      facilityName: expenseDumpDetails.facilityName,
      ticketNumber: expenseDumpDetails.ticketNumber,
    })
    .from(expenseDumpDetails)
    .innerJoin(expenses, eq(expenses.id, expenseDumpDetails.expenseId))
    .where(
      and(
        inArray(expenses.lifecycleStatus, ["draft", "posted"]),
        or(
          isNull(expenses.reviewStatus),
          ne(expenses.reviewStatus, "rejected"),
        ),
        sql`${expenseDumpDetails.facilityName} IS NOT NULL`,
        sql`${expenseDumpDetails.ticketNumber} IS NOT NULL`,
      ),
    )
    .orderBy(
      asc(expenseDumpDetails.createdAt),
      asc(expenseDumpDetails.expenseId),
    );
  return (
    candidates.find((candidate) => {
      if (input.excludeExpenseIds?.includes(candidate.expenseId)) return false;
      const candidateIdentity = normalizeScaleTicketDuplicateIdentity({
        facilityName: candidate.facilityName,
        ticketNumber: candidate.ticketNumber,
      });
      return (
        candidateIdentity?.facilityName === normalized.facilityName &&
        candidateIdentity.ticketNumber === normalized.ticketNumber
      );
    })?.expenseId ?? null
  );
}
