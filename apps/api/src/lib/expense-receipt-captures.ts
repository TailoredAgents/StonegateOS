import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  auditLogs,
  expenseReceiptCaptures,
  expenseVendorCategoryRules,
  expenses,
  getDb,
  outboxEvents,
  teamMembers,
  type DatabaseClient,
} from "@/db";
import {
  buildExpenseReceiptReview,
  detectExpenseReceiptDuplicates,
  normalizeReceiptVendor,
  parseStoredExpenseReceiptExtraction,
  selectExpenseCategory,
  type ExpenseReceiptExtraction,
  type ReceiptDuplicateCandidate,
} from "@/lib/expense-receipt-domain";
import { isExpenseReceiptCaptureEnabled } from "@/lib/expense-feature-flags";
import {
  ExpenseReceiptAnalysisProviderError,
  extractExpenseReceiptWithOpenAi,
} from "@/lib/expense-receipt-openai";
import {
  buildExpenseReceiptObjectKeys,
  ExpenseReceiptUploadIntentSchema,
  normalizeDeclaredExpenseReceiptContentType,
  sanitizeExpenseReceiptFilename,
  storedExpenseReceiptContentTypeMatches,
  verifyAndNormalizeExpenseReceiptUpload,
  type ExpenseReceiptUploadIntentInput,
} from "@/lib/expense-receipt-storage";
import {
  createMediaReadUrl,
  createMediaUploadUrl,
  getMediaObject,
  getMediaStorageProvider,
  headMediaObject,
  putImmutableMediaObject,
} from "@/lib/media-storage";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/provider-health";
import { getOutboxRetryDelayMs } from "@/lib/outbox-finalization";

const UPLOAD_URL_LIFETIME_SECONDS = 5 * 60;
const ANALYSIS_LEASE_MS = 10 * 60 * 1_000;
const MAX_ANALYSIS_ATTEMPTS = 5;
const MAX_DUPLICATE_CANDIDATES = 10_000;
const DEFAULT_DUPLICATE_REVIEW_LIMIT = 25;
const MAX_DUPLICATE_REVIEW_LIMIT = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type CaptureRow = typeof expenseReceiptCaptures.$inferSelect;
type CaptureStatus = CaptureRow["status"];
type ReceiptCaptureTransaction = Parameters<
  DatabaseClient["transaction"]
>[0] extends (tx: infer Transaction) => Promise<unknown>
  ? Transaction
  : never;
type ReceiptCaptureDb = DatabaseClient | ReceiptCaptureTransaction;

export class ExpenseReceiptCaptureError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = "ExpenseReceiptCaptureError";
  }
}

function assertReceiptFeatureEnabled(): void {
  if (!isExpenseReceiptCaptureEnabled()) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_capture_disabled",
      503,
      "Receipt capture is temporarily unavailable.",
    );
  }
}

function isMissingObjectError(error: unknown): boolean {
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

function safeFailureMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/data:[^\s]+/giu, "[redacted-data]")
    .replace(/https?:\/\/\S+/giu, "[redacted-url]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function canAccessCapture(
  capture: Pick<CaptureRow, "submittedBy">,
  viewerId: string,
  canReviewAll: boolean,
): boolean {
  return canReviewAll || capture.submittedBy === viewerId;
}

async function findCapture(
  captureId: string,
  db: ReceiptCaptureDb = getDb(),
): Promise<CaptureRow | null> {
  const [capture] = await db
    .select()
    .from(expenseReceiptCaptures)
    .where(eq(expenseReceiptCaptures.id, captureId))
    .limit(1);
  return capture ?? null;
}

async function findCaptureForViewer(input: {
  captureId: string;
  viewerId: string;
  canReviewAll: boolean;
}): Promise<CaptureRow> {
  const capture = await findCapture(input.captureId);
  if (
    !capture ||
    !canAccessCapture(capture, input.viewerId, input.canReviewAll)
  ) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_capture_not_found",
      404,
    );
  }
  return capture;
}

function responseExtraction(
  capture: CaptureRow,
): Record<string, unknown> | null {
  return capture.extraction && typeof capture.extraction === "object"
    ? capture.extraction
    : null;
}

export type ExpenseReceiptCaptureStatusDto = {
  id: string;
  submittedBy: string;
  status: CaptureStatus;
  version: number;
  filename: string;
  contentType: string;
  byteLength: number | null;
  sha256: string | null;
  uploadedAt: string | null;
  analysisQueuedAt: string | null;
  analysisStartedAt: string | null;
  analysisCompletedAt: string | null;
  analysisAttemptCount: number;
  analysisNextAttemptAt: string | null;
  retryPending: boolean;
  analysisModel: string | null;
  extraction: Record<string, unknown> | null;
  exactDuplicateOfCaptureId: string | null;
  failure: { code: string; message: string | null } | null;
  contentPath: string | null;
  createdAt: string;
  updatedAt: string;
  requiresHumanConfirmation: true;
};

export function toExpenseReceiptCaptureStatusDto(
  capture: CaptureRow,
): ExpenseReceiptCaptureStatusDto {
  const hasUploadedEvidence = capture.uploadedAt !== null;
  return {
    id: capture.id,
    submittedBy: capture.submittedBy,
    status: capture.status,
    version: capture.version,
    filename: capture.filename,
    contentType: capture.verifiedContentType ?? capture.declaredContentType,
    byteLength: capture.byteLength,
    sha256: capture.sha256,
    uploadedAt: capture.uploadedAt?.toISOString() ?? null,
    analysisQueuedAt: capture.analysisQueuedAt?.toISOString() ?? null,
    analysisStartedAt: capture.analysisStartedAt?.toISOString() ?? null,
    analysisCompletedAt: capture.analysisCompletedAt?.toISOString() ?? null,
    analysisAttemptCount: capture.analysisAttemptCount,
    analysisNextAttemptAt: capture.analysisNextAttemptAt?.toISOString() ?? null,
    retryPending:
      capture.status === "queued" && capture.analysisNextAttemptAt !== null,
    analysisModel: capture.analysisModel,
    extraction: responseExtraction(capture),
    exactDuplicateOfCaptureId: capture.exactDuplicateOfCaptureId,
    failure: capture.failureCode
      ? { code: capture.failureCode, message: capture.failureMessage }
      : null,
    contentPath:
      hasUploadedEvidence && capture.status !== "discarded"
        ? `/api/admin/expenses/captures/${capture.id}/content`
        : null,
    createdAt: capture.createdAt.toISOString(),
    updatedAt: capture.updatedAt.toISOString(),
    requiresHumanConfirmation: true,
  };
}

export type ExactDuplicateCaptureReviewQuery = {
  limit: number;
  cursor: { updatedAt: Date; id: string } | null;
};

function encodeExactDuplicateReviewCursor(input: {
  updatedAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify([input.updatedAt.toISOString(), input.id]),
    "utf8",
  ).toString("base64url");
}

function decodeExactDuplicateReviewCursor(
  value: string,
): { updatedAt: Date; id: string } | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string" ||
      !UUID_PATTERN.test(decoded[1])
    ) {
      return null;
    }
    const updatedAt = new Date(decoded[0]);
    if (
      Number.isNaN(updatedAt.getTime()) ||
      updatedAt.toISOString() !== decoded[0]
    ) {
      return null;
    }
    return { updatedAt, id: decoded[1] };
  } catch {
    return null;
  }
}

export function parseExactDuplicateCaptureReviewQuery(
  searchParams: URLSearchParams,
): ExactDuplicateCaptureReviewQuery {
  const rawLimit = searchParams.get("limit")?.trim() ?? "";
  const limit = rawLimit ? Number(rawLimit) : DEFAULT_DUPLICATE_REVIEW_LIMIT;
  if (
    (rawLimit && !/^\d+$/u.test(rawLimit)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DUPLICATE_REVIEW_LIMIT
  ) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_review_limit_invalid",
      400,
      `Use a review queue limit from 1 through ${MAX_DUPLICATE_REVIEW_LIMIT}.`,
    );
  }
  const rawCursor = searchParams.get("cursor")?.trim() ?? "";
  const cursor =
    rawCursor && rawCursor.length <= 256
      ? decodeExactDuplicateReviewCursor(rawCursor)
      : null;
  if (rawCursor && !cursor) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_review_cursor_invalid",
      400,
      "Refresh the duplicate review queue and try again.",
    );
  }
  return { limit, cursor };
}

export type ExactDuplicateCaptureReviewItem = {
  capture: ExpenseReceiptCaptureStatusDto;
  submitter: { id: string; name: string };
  duplicate: {
    capture: {
      id: string;
      status: CaptureStatus;
      filename: string;
      submittedBy: string;
      submitterName: string;
      contentPath: string | null;
    };
    expense: {
      id: string;
      amountCents: number;
      currency: string;
      categoryId: string | null;
      category: string | null;
      vendor: string | null;
      paidAt: string;
      lifecycleStatus: string;
      reviewStatus: string;
    } | null;
  } | null;
};

/**
 * Owner review queue for analyzed exact duplicates that crew cannot confirm.
 * This is deliberately not a general capture listing surface.
 */
export async function listExactDuplicateExpenseReceiptCaptures(
  query: ExactDuplicateCaptureReviewQuery,
): Promise<{
  captures: ExactDuplicateCaptureReviewItem[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
}> {
  assertReceiptFeatureEnabled();
  const cursorPredicate = query.cursor
    ? or(
        gt(expenseReceiptCaptures.updatedAt, query.cursor.updatedAt),
        and(
          eq(expenseReceiptCaptures.updatedAt, query.cursor.updatedAt),
          gt(expenseReceiptCaptures.id, query.cursor.id),
        ),
      )
    : undefined;
  const rows = await getDb()
    .select()
    .from(expenseReceiptCaptures)
    .where(
      and(
        eq(expenseReceiptCaptures.status, "ready"),
        isNotNull(expenseReceiptCaptures.exactDuplicateOfCaptureId),
        cursorPredicate,
      ),
    )
    .orderBy(
      asc(expenseReceiptCaptures.updatedAt),
      asc(expenseReceiptCaptures.id),
    )
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const captures = hasMore ? rows.slice(0, query.limit) : rows;
  const duplicateCaptureIds = Array.from(
    new Set(
      captures.flatMap((capture) =>
        capture.exactDuplicateOfCaptureId
          ? [capture.exactDuplicateOfCaptureId]
          : [],
      ),
    ),
  );
  const duplicateCaptures =
    duplicateCaptureIds.length > 0
      ? await getDb()
          .select()
          .from(expenseReceiptCaptures)
          .where(inArray(expenseReceiptCaptures.id, duplicateCaptureIds))
      : [];
  const submitterIds = Array.from(
    new Set([
      ...captures.map((capture) => capture.submittedBy),
      ...duplicateCaptures.map((capture) => capture.submittedBy),
    ]),
  );
  const submitters =
    submitterIds.length > 0
      ? await getDb()
          .select({ id: teamMembers.id, name: teamMembers.name })
          .from(teamMembers)
          .where(inArray(teamMembers.id, submitterIds))
      : [];
  const duplicateExpenses =
    duplicateCaptureIds.length > 0
      ? await getDb()
          .select({
            id: expenses.id,
            receiptCaptureId: expenses.receiptCaptureId,
            amountCents: expenses.amount,
            currency: expenses.currency,
            categoryId: expenses.categoryId,
            category: expenses.category,
            vendor: expenses.vendor,
            paidAt: expenses.paidAt,
            lifecycleStatus: expenses.lifecycleStatus,
            reviewStatus: expenses.reviewStatus,
          })
          .from(expenses)
          .where(inArray(expenses.receiptCaptureId, duplicateCaptureIds))
      : [];
  const captureById = new Map(
    duplicateCaptures.map((capture) => [capture.id, capture]),
  );
  const submitterNameById = new Map(
    submitters.map((submitter) => [submitter.id, submitter.name]),
  );
  const expenseByCaptureId = new Map(
    duplicateExpenses.flatMap((expense) =>
      expense.receiptCaptureId
        ? ([[expense.receiptCaptureId, expense]] as const)
        : [],
    ),
  );
  const lastCapture = captures.at(-1) ?? null;

  return {
    captures: captures.map((capture) => {
      const duplicateCaptureId = capture.exactDuplicateOfCaptureId;
      const duplicateCapture = duplicateCaptureId
        ? (captureById.get(duplicateCaptureId) ?? null)
        : null;
      const duplicateExpense = duplicateCaptureId
        ? (expenseByCaptureId.get(duplicateCaptureId) ?? null)
        : null;
      return {
        capture: toExpenseReceiptCaptureStatusDto(capture),
        submitter: {
          id: capture.submittedBy,
          name:
            submitterNameById.get(capture.submittedBy) ?? "Former team member",
        },
        duplicate: duplicateCapture
          ? {
              capture: {
                id: duplicateCapture.id,
                status: duplicateCapture.status,
                filename: duplicateCapture.filename,
                submittedBy: duplicateCapture.submittedBy,
                submitterName:
                  submitterNameById.get(duplicateCapture.submittedBy) ??
                  "Former team member",
                contentPath: duplicateCapture.uploadedAt
                  ? `/api/admin/expenses/captures/${duplicateCapture.id}/content`
                  : null,
              },
              expense: duplicateExpense
                ? {
                    id: duplicateExpense.id,
                    amountCents: duplicateExpense.amountCents,
                    currency: duplicateExpense.currency,
                    categoryId: duplicateExpense.categoryId,
                    category: duplicateExpense.category,
                    vendor: duplicateExpense.vendor,
                    paidAt: duplicateExpense.paidAt.toISOString(),
                    lifecycleStatus: duplicateExpense.lifecycleStatus,
                    reviewStatus: duplicateExpense.reviewStatus,
                  }
                : null,
            }
          : null,
      } satisfies ExactDuplicateCaptureReviewItem;
    }),
    page: {
      limit: query.limit,
      hasMore,
      nextCursor:
        hasMore && lastCapture
          ? encodeExactDuplicateReviewCursor({
              updatedAt: lastCapture.updatedAt,
              id: lastCapture.id,
            })
          : null,
    },
  };
}

export async function createExpenseReceiptUploadIntent(input: {
  submittedBy: string;
  upload: ExpenseReceiptUploadIntentInput;
}): Promise<{
  capture: ExpenseReceiptCaptureStatusDto;
  uploadUrl: string | null;
  uploadHeaders: Record<string, string>;
  uploadExpiresAt: string | null;
  alreadyExists: boolean;
}> {
  assertReceiptFeatureEnabled();
  const parsed = ExpenseReceiptUploadIntentSchema.safeParse(input.upload);
  if (!parsed.success) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_upload_intent_invalid",
      400,
      parsed.error.issues[0]?.message ??
        "Review the receipt upload and try again.",
    );
  }
  const upload = parsed.data;
  const filename = sanitizeExpenseReceiptFilename(upload.filename);
  const keys = buildExpenseReceiptObjectKeys({
    memberId: input.submittedBy,
    captureId: upload.clientCaptureId,
    contentType: upload.contentType,
  });
  const signed = await createMediaUploadUrl({
    key: keys.originalObjectKey,
    contentType: upload.contentType,
    byteLength: upload.byteLength,
    checksumSha256Hex: upload.checksumSha256,
    expiresInSeconds: UPLOAD_URL_LIFETIME_SECONDS,
    writeOnce: true,
  });
  const now = new Date();
  const [created] = await getDb()
    .insert(expenseReceiptCaptures)
    .values({
      id: upload.clientCaptureId,
      submittedBy: input.submittedBy,
      status: "pending_upload",
      storageProvider: getMediaStorageProvider(),
      originalObjectKey: keys.originalObjectKey,
      normalizedObjectKey: null,
      filename,
      declaredContentType: upload.contentType,
      byteLength: upload.byteLength,
      sha256: upload.checksumSha256,
      uploadExpiresAt: signed.expiresAt,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: expenseReceiptCaptures.id })
    .returning();

  if (created) {
    return {
      capture: toExpenseReceiptCaptureStatusDto(created),
      uploadUrl: signed.url,
      uploadHeaders: signed.headers,
      uploadExpiresAt: signed.expiresAt.toISOString(),
      alreadyExists: false,
    };
  }

  const existing = await findCapture(upload.clientCaptureId);
  if (
    !existing ||
    existing.submittedBy !== input.submittedBy ||
    existing.originalObjectKey !== keys.originalObjectKey ||
    existing.filename !== filename ||
    existing.declaredContentType !== upload.contentType ||
    existing.byteLength !== upload.byteLength ||
    (existing.sha256 !== null && existing.sha256 !== upload.checksumSha256)
  ) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_capture_id_conflict",
      409,
      "This offline capture ID is already associated with a different receipt.",
    );
  }
  if (existing.status !== "pending_upload") {
    return {
      capture: toExpenseReceiptCaptureStatusDto(existing),
      uploadUrl: null,
      uploadHeaders: {},
      uploadExpiresAt: null,
      alreadyExists: true,
    };
  }

  // The capture identity, submitter, size, MIME declaration, digest, and
  // write-once object key are already immutable. Refresh only the short-lived
  // transport authorization so offline and interrupted uploads can resume
  // without discarding their original evidence or changing its identity.
  const remainingSeconds = Math.floor(
    (existing.uploadExpiresAt.getTime() - Date.now()) / 1_000,
  );
  const retryLifetimeSeconds =
    remainingSeconds < 30
      ? UPLOAD_URL_LIFETIME_SECONDS
      : Math.min(remainingSeconds, UPLOAD_URL_LIFETIME_SECONDS);
  const retrySigned = await createMediaUploadUrl({
    key: existing.originalObjectKey,
    contentType: existing.declaredContentType,
    byteLength: existing.byteLength ?? upload.byteLength,
    checksumSha256Hex: existing.sha256,
    expiresInSeconds: retryLifetimeSeconds,
    writeOnce: true,
  });
  return {
    capture: toExpenseReceiptCaptureStatusDto(existing),
    uploadUrl: retrySigned.url,
    uploadHeaders: retrySigned.headers,
    uploadExpiresAt: retrySigned.expiresAt.toISOString(),
    alreadyExists: true,
  };
}

async function firstExactDuplicateCapture(input: {
  captureId: string;
  sha256: string;
}): Promise<string | null> {
  const [duplicate] = await getDb()
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
    .orderBy(
      asc(expenseReceiptCaptures.createdAt),
      asc(expenseReceiptCaptures.id),
    )
    .limit(1);
  return duplicate?.id ?? null;
}

async function enqueueUploadedCapture(captureId: string): Promise<CaptureRow> {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${captureId}, 0))`,
    );
    const [current] = await tx
      .select()
      .from(expenseReceiptCaptures)
      .where(eq(expenseReceiptCaptures.id, captureId))
      .limit(1);
    if (!current) {
      throw new ExpenseReceiptCaptureError(
        "expense_receipt_capture_not_found",
        404,
      );
    }
    if (current.status !== "uploaded") return current;

    const now = new Date();
    const [queued] = await tx
      .update(expenseReceiptCaptures)
      .set({
        status: "queued",
        analysisQueuedAt: now,
        failureCode: null,
        failureMessage: null,
        version: current.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(expenseReceiptCaptures.id, current.id),
          eq(expenseReceiptCaptures.status, "uploaded"),
          eq(expenseReceiptCaptures.version, current.version),
        ),
      )
      .returning();
    if (!queued) {
      throw new ExpenseReceiptCaptureError(
        "expense_receipt_capture_changed",
        409,
      );
    }
    await tx.insert(outboxEvents).values({
      type: "expense.receipt.analyze",
      payload: { captureId },
      attempts: 0,
      createdAt: now,
    });
    return queued;
  });
}

export async function finalizeExpenseReceiptUpload(input: {
  captureId: string;
  viewerId: string;
  canReviewAll: boolean;
  checksumSha256?: string | null;
}): Promise<ExpenseReceiptCaptureStatusDto> {
  assertReceiptFeatureEnabled();
  let capture = await findCaptureForViewer(input);
  if (["queued", "analyzing", "ready", "confirmed"].includes(capture.status)) {
    return toExpenseReceiptCaptureStatusDto(capture);
  }
  if (capture.status === "uploaded") {
    capture = await enqueueUploadedCapture(capture.id);
    return toExpenseReceiptCaptureStatusDto(capture);
  }
  if (capture.status !== "pending_upload") {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_capture_not_finalizable",
      409,
    );
  }

  const requestChecksum = input.checksumSha256?.trim().toLowerCase() ?? null;
  if (requestChecksum && !/^[a-f0-9]{64}$/u.test(requestChecksum)) {
    throw new ExpenseReceiptCaptureError("receipt_checksum_invalid", 400);
  }
  if (capture.sha256 && requestChecksum && capture.sha256 !== requestChecksum) {
    throw new ExpenseReceiptCaptureError("receipt_checksum_mismatch", 400);
  }

  let head;
  try {
    head = await headMediaObject(capture.originalObjectKey);
  } catch (error) {
    if (isMissingObjectError(error)) {
      throw new ExpenseReceiptCaptureError(
        "expense_receipt_upload_not_found",
        409,
      );
    }
    throw error;
  }
  if (
    head.byteLength === null ||
    capture.byteLength === null ||
    head.byteLength !== capture.byteLength
  ) {
    throw new ExpenseReceiptCaptureError("receipt_upload_size_mismatch", 400);
  }

  const declaredContentType = normalizeDeclaredExpenseReceiptContentType(
    capture.declaredContentType,
  );
  if (
    head.contentType &&
    !storedExpenseReceiptContentTypeMatches(
      declaredContentType,
      head.contentType,
    )
  ) {
    throw new ExpenseReceiptCaptureError("receipt_upload_type_mismatch", 400);
  }

  const bytes = await getMediaObject(capture.originalObjectKey);
  let verified;
  try {
    verified = await verifyAndNormalizeExpenseReceiptUpload({
      bytes,
      declaredContentType,
      declaredByteLength: capture.byteLength,
      expectedSha256: requestChecksum ?? capture.sha256,
    });
  } catch (error) {
    const detail = safeFailureMessage(error);
    const code = /^receipt_[a-z0-9_]{1,140}$/u.test(detail)
      ? detail
      : "expense_receipt_upload_invalid";
    throw new ExpenseReceiptCaptureError(
      code,
      400,
      "The receipt bytes could not be verified. Retake the photo or choose a different file.",
    );
  }

  const keys = buildExpenseReceiptObjectKeys({
    memberId: capture.submittedBy,
    captureId: capture.id,
    contentType: declaredContentType,
  });
  let normalizedObjectKey: string | null = null;
  if (verified.normalized && keys.normalizedObjectKey) {
    normalizedObjectKey = keys.normalizedObjectKey;
    await putImmutableMediaObject({
      key: normalizedObjectKey,
      body: verified.normalized.bytes,
      contentType: verified.normalized.contentType,
    });
  }

  const exactDuplicateOfCaptureId = await firstExactDuplicateCapture({
    captureId: capture.id,
    sha256: verified.sha256,
  });
  const now = new Date();
  const [uploaded] = await getDb()
    .update(expenseReceiptCaptures)
    .set({
      status: "uploaded",
      normalizedObjectKey,
      verifiedContentType: verified.verifiedContentType,
      byteLength: verified.byteLength,
      sha256: verified.sha256,
      uploadedAt: now,
      exactDuplicateOfCaptureId,
      failureCode: null,
      failureMessage: null,
      version: capture.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(expenseReceiptCaptures.id, capture.id),
        eq(expenseReceiptCaptures.status, "pending_upload"),
        eq(expenseReceiptCaptures.version, capture.version),
      ),
    )
    .returning();

  if (!uploaded) {
    const current = await findCaptureForViewer(input);
    if (
      ["uploaded", "queued", "analyzing", "ready", "confirmed"].includes(
        current.status,
      )
    ) {
      capture = current;
    } else {
      throw new ExpenseReceiptCaptureError(
        "expense_receipt_capture_changed",
        409,
      );
    }
  } else {
    capture = uploaded;
  }

  if (capture.status === "uploaded") {
    capture = await enqueueUploadedCapture(capture.id);
  }
  return toExpenseReceiptCaptureStatusDto(capture);
}

export async function getExpenseReceiptCaptureStatus(input: {
  captureId: string;
  viewerId: string;
  canReviewAll: boolean;
}): Promise<ExpenseReceiptCaptureStatusDto> {
  const capture = await findCaptureForViewer(input);
  const status = toExpenseReceiptCaptureStatusDto(capture);
  return input.canReviewAll && capture.uploadedAt && status.contentPath === null
    ? {
        ...status,
        contentPath: `/api/admin/expenses/captures/${capture.id}/content`,
      }
    : status;
}

export async function discardExpenseReceiptCapture(input: {
  captureId: string;
  viewerId: string;
  canReviewAll: boolean;
}): Promise<ExpenseReceiptCaptureStatusDto> {
  const capture = await findCaptureForViewer(input);
  if (capture.status === "discarded") {
    return toExpenseReceiptCaptureStatusDto(capture);
  }
  if (capture.status === "confirmed") {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_evidence_is_immutable",
      409,
    );
  }
  if (capture.status === "analyzing") {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_analysis_in_progress",
      409,
    );
  }
  const now = new Date();
  const [discarded] = await getDb()
    .update(expenseReceiptCaptures)
    .set({
      status: "discarded",
      discardedAt: now,
      version: capture.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(expenseReceiptCaptures.id, capture.id),
        eq(expenseReceiptCaptures.status, capture.status),
        eq(expenseReceiptCaptures.version, capture.version),
      ),
    )
    .returning();
  if (!discarded) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_capture_changed",
      409,
    );
  }

  return toExpenseReceiptCaptureStatusDto(discarded);
}

export async function getExpenseReceiptCaptureContentUrl(input: {
  captureId: string;
  viewerId: string;
  canReviewAll: boolean;
  variant: "original" | "normalized";
}): Promise<string> {
  const capture = await findCaptureForViewer(input);
  if (
    !capture.uploadedAt ||
    (capture.status === "discarded" && !input.canReviewAll)
  ) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_content_unavailable",
      409,
    );
  }
  const key =
    input.variant === "normalized"
      ? capture.normalizedObjectKey
      : capture.originalObjectKey;
  if (!key) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_variant_unavailable",
      404,
    );
  }
  return createMediaReadUrl(key, 60);
}

type StoredExtraction = {
  schemaVersion: 2;
  raw: ExpenseReceiptExtraction;
  review: ReturnType<typeof buildExpenseReceiptReview>;
  categorySuggestion: ReturnType<typeof selectExpenseCategory>;
  duplicates: ReturnType<typeof detectExpenseReceiptDuplicates>;
};

function readStoredRawExtraction(
  value: unknown,
): ExpenseReceiptExtraction | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate = "raw" in record ? record["raw"] : value;
  return parseStoredExpenseReceiptExtraction(candidate);
}

async function duplicateCandidatesForCapture(
  capture: CaptureRow,
  db: ReceiptCaptureDb = getDb(),
): Promise<ReceiptDuplicateCandidate[]> {
  const rows = await db
    .select({
      id: expenseReceiptCaptures.id,
      sha256: expenseReceiptCaptures.sha256,
      extraction: expenseReceiptCaptures.extraction,
    })
    .from(expenseReceiptCaptures)
    .where(
      and(
        ne(expenseReceiptCaptures.id, capture.id),
        inArray(expenseReceiptCaptures.status, [
          "uploaded",
          "queued",
          "analyzing",
          "ready",
          "confirmed",
        ]),
      ),
    )
    .orderBy(desc(expenseReceiptCaptures.createdAt))
    .limit(MAX_DUPLICATE_CANDIDATES);
  return rows.map((row) => {
    const extraction = readStoredRawExtraction(row.extraction);
    return {
      id: row.id,
      sha256: row.sha256,
      vendor: extraction?.vendor ?? null,
      totalCents: extraction?.totalCents ?? null,
      transactionDate: extraction?.transactionDate ?? null,
    };
  });
}

async function categorySuggestionForExtraction(
  extraction: ExpenseReceiptExtraction,
  db: ReceiptCaptureDb = getDb(),
): Promise<ReturnType<typeof selectExpenseCategory>> {
  const normalizedVendor = normalizeReceiptVendor(extraction.vendor);
  if (!normalizedVendor) {
    return selectExpenseCategory({
      vendor: extraction.vendor,
      rules: [],
      aiSuggestedCategoryId: extraction.suggestedCategoryId,
    });
  }
  const rows = await db
    .select()
    .from(expenseVendorCategoryRules)
    .where(eq(expenseVendorCategoryRules.normalizedVendor, normalizedVendor));
  const vendorConfirmationCount = rows.reduce(
    (sum, row) => sum + row.confirmationCount,
    0,
  );
  return selectExpenseCategory({
    vendor: extraction.vendor,
    rules: rows.map((row) => ({
      ruleId: row.id,
      vendor: normalizedVendor,
      categoryId: row.categoryId,
      ownerLocked: row.ownerLocked,
      categoryConfirmationCount: row.confirmationCount,
      vendorConfirmationCount,
    })),
    aiSuggestedCategoryId: extraction.suggestedCategoryId,
  });
}

async function markCaptureAnalysisFailed(
  db: ReceiptCaptureDb,
  input: {
    capture: CaptureRow;
    code: string;
    message: string;
    now: Date;
  },
): Promise<CaptureRow | null> {
  const [failed] = await db
    .update(expenseReceiptCaptures)
    .set({
      status: "failed",
      failureCode: input.code.slice(0, 160),
      failureMessage: input.message.slice(0, 500),
      analysisCompletedAt: input.now,
      analysisNextAttemptAt: null,
      version: input.capture.version + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(expenseReceiptCaptures.id, input.capture.id),
        eq(expenseReceiptCaptures.status, "analyzing"),
        eq(expenseReceiptCaptures.version, input.capture.version),
      ),
    )
    .returning();
  return failed ?? null;
}

async function requeueCaptureAfterRetryableFailure(
  db: ReceiptCaptureDb,
  input: {
    capture: CaptureRow;
    code: string;
    message: string;
    retryAt: Date;
    now: Date;
  },
): Promise<CaptureRow | null> {
  const [queued] = await db
    .update(expenseReceiptCaptures)
    .set({
      status: "queued",
      failureCode: input.code.slice(0, 160),
      failureMessage: input.message.slice(0, 500),
      analysisQueuedAt: input.now,
      analysisStartedAt: null,
      analysisCompletedAt: null,
      analysisNextAttemptAt: input.retryAt,
      version: input.capture.version + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(expenseReceiptCaptures.id, input.capture.id),
        eq(expenseReceiptCaptures.status, "analyzing"),
        eq(expenseReceiptCaptures.version, input.capture.version),
      ),
    )
    .returning();
  return queued ?? null;
}

async function claimCaptureForAnalysis(
  db: ReceiptCaptureDb,
  captureId: string,
  now: Date,
): Promise<
  | { kind: "claimed"; capture: CaptureRow }
  | { kind: "complete" }
  | { kind: "retry"; at: Date; error: string }
> {
  let capture = await findCapture(captureId, db);
  if (
    !capture ||
    ["ready", "failed", "confirmed", "discarded"].includes(capture.status)
  ) {
    return { kind: "complete" };
  }
  if (capture.status === "analyzing") {
    const leaseStarted = capture.analysisStartedAt?.getTime() ?? now.getTime();
    const leaseExpiresAt = new Date(leaseStarted + ANALYSIS_LEASE_MS);
    if (leaseExpiresAt.getTime() > now.getTime()) {
      return {
        kind: "retry",
        at: leaseExpiresAt,
        error: "expense_receipt_analysis_in_flight",
      };
    }
    const leaseFailure = {
      capture,
      code: "expense_receipt_analysis_lease_expired",
      message:
        "The previous analysis worker did not finish before its lease expired.",
      now,
    };
    if (capture.analysisAttemptCount >= MAX_ANALYSIS_ATTEMPTS) {
      const failed = await markCaptureAnalysisFailed(db, leaseFailure);
      return failed
        ? { kind: "complete" }
        : {
            kind: "retry",
            at: new Date(now.getTime() + 30_000),
            error: "expense_receipt_analysis_claim_changed",
          };
    }
    const queued = await requeueCaptureAfterRetryableFailure(db, {
      ...leaseFailure,
      retryAt: now,
    });
    if (!queued) {
      return {
        kind: "retry",
        at: new Date(now.getTime() + 30_000),
        error: "expense_receipt_analysis_claim_changed",
      };
    }
    capture = queued;
  }
  if (capture.status !== "queued") {
    return { kind: "complete" };
  }
  if (
    capture.analysisNextAttemptAt &&
    capture.analysisNextAttemptAt.getTime() > now.getTime()
  ) {
    return {
      kind: "retry",
      at: capture.analysisNextAttemptAt,
      error: capture.failureCode ?? "expense_receipt_analysis_retry_scheduled",
    };
  }

  const [claimed] = await db
    .update(expenseReceiptCaptures)
    .set({
      status: "analyzing",
      analysisStartedAt: now,
      analysisCompletedAt: null,
      analysisAttemptCount: capture.analysisAttemptCount + 1,
      analysisNextAttemptAt: null,
      failureCode: null,
      failureMessage: null,
      version: capture.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(expenseReceiptCaptures.id, capture.id),
        eq(expenseReceiptCaptures.status, "queued"),
        eq(expenseReceiptCaptures.version, capture.version),
      ),
    )
    .returning();
  return claimed
    ? { kind: "claimed", capture: claimed }
    : {
        kind: "retry",
        at: new Date(Date.now() + 30_000),
        error: "expense_receipt_analysis_claim_changed",
      };
}

async function recordExpenseOpenAiSuccess(): Promise<void> {
  try {
    await recordProviderSuccess("openai_expense_receipts");
  } catch (error) {
    console.warn("[expense.receipt] provider_health_success_failed", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

async function recordExpenseOpenAiFailure(detail: string): Promise<void> {
  try {
    await recordProviderFailure(
      "openai_expense_receipts",
      detail.slice(0, 500),
    );
  } catch (error) {
    console.warn("[expense.receipt] provider_health_failure_failed", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export type ExpenseReceiptAnalysisOutboxOutcome = {
  status: "processed" | "retry";
  error?: string;
  nextAttemptAt?: Date;
};

/**
 * Worker entry point. Retryable failures return the capture to `queued` so
 * clients keep polling; only permanent or exhausted analysis becomes failed.
 */
export async function processExpenseReceiptAnalysisOutbox(
  input: {
    captureId: string;
    priorAttempts: number;
  },
  dependencies: {
    db?: ReceiptCaptureDb;
    now?: () => Date;
  } = {},
): Promise<ExpenseReceiptAnalysisOutboxOutcome> {
  const now = dependencies.now ?? (() => new Date());
  if (!isExpenseReceiptCaptureEnabled()) {
    return {
      status: "retry",
      error: "expense_receipt_capture_disabled",
      nextAttemptAt: new Date(now().getTime() + 15 * 60_000),
    };
  }
  const db = dependencies.db ?? getDb();
  const claim = await claimCaptureForAnalysis(db, input.captureId, now());
  if (claim.kind === "complete") return { status: "processed" };
  if (claim.kind === "retry") {
    return {
      status: "retry",
      error: claim.error,
      nextAttemptAt: claim.at,
    };
  }

  const capture = claim.capture;
  try {
    if (!capture.sha256) {
      throw new Error("expense_receipt_sha256_missing");
    }
    const objectKey = capture.normalizedObjectKey ?? capture.originalObjectKey;
    const contentType = capture.normalizedObjectKey
      ? "image/jpeg"
      : normalizeDeclaredExpenseReceiptContentType(
          capture.verifiedContentType ?? capture.declaredContentType,
        );
    const bytes = await getMediaObject(objectKey);
    const analyzed = await extractExpenseReceiptWithOpenAi({
      filename: capture.filename,
      contentType,
      bytes,
    });
    await recordExpenseOpenAiSuccess();

    const candidates = await duplicateCandidatesForCapture(capture, db);
    const duplicates = detectExpenseReceiptDuplicates(
      {
        sha256: capture.sha256,
        vendor: analyzed.extraction.vendor,
        totalCents: analyzed.extraction.totalCents,
        transactionDate: analyzed.extraction.transactionDate,
      },
      candidates,
    );
    const review = buildExpenseReceiptReview(analyzed.extraction);
    const categorySuggestion = await categorySuggestionForExtraction(
      analyzed.extraction,
      db,
    );
    const storedExtraction: StoredExtraction = {
      schemaVersion: 2,
      raw: analyzed.extraction,
      review,
      categorySuggestion,
      duplicates,
    };
    const exactDuplicateOfCaptureId =
      capture.exactDuplicateOfCaptureId ??
      duplicates.exactMatches[0]?.candidateId ??
      null;
    const completedAt = now();
    const [ready] = await db
      .update(expenseReceiptCaptures)
      .set({
        status: "ready",
        analysisModel: analyzed.model,
        extraction: storedExtraction,
        analysisWarnings: analyzed.extraction.warnings,
        exactDuplicateOfCaptureId,
        analysisCompletedAt: completedAt,
        analysisNextAttemptAt: null,
        failureCode: null,
        failureMessage: null,
        version: capture.version + 1,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(expenseReceiptCaptures.id, capture.id),
          eq(expenseReceiptCaptures.status, "analyzing"),
          eq(expenseReceiptCaptures.version, capture.version),
        ),
      )
      .returning({ id: expenseReceiptCaptures.id });
    if (!ready) throw new Error("expense_receipt_analysis_finalize_changed");

    await db.insert(auditLogs).values({
      actorType: "worker",
      actorId: null,
      actorRole: null,
      actorLabel: "outbox",
      action: "expense.receipt.analysis_ready",
      entityType: "expense_receipt_capture",
      entityId: capture.id,
      meta: {
        model: analyzed.model,
        fieldsToCheck: review.fieldsToCheck,
        duplicateRisk: duplicates.highestRisk,
        categorySuggestionSource: categorySuggestion.source,
        documentType: analyzed.extraction.documentType,
        dumpWeightNeedsReview: review.fieldsToCheck.includes(
          "dumpTicket.netWeightPounds",
        ),
        humanConfirmationRequired: true,
      },
      createdAt: completedAt,
    });
    console.info("[expense.receipt] analysis_ready", {
      captureId: capture.id,
      model: analyzed.model,
      fieldsToCheck: review.fieldsToCheck.length,
      duplicateRisk: duplicates.highestRisk,
      documentType: analyzed.extraction.documentType,
    });
    return { status: "processed" };
  } catch (error) {
    const providerError =
      error instanceof ExpenseReceiptAnalysisProviderError ? error : null;
    const code = providerError?.code ?? "expense_receipt_analysis_failed";
    const detail = safeFailureMessage(error) || code;
    if (providerError) {
      await recordExpenseOpenAiFailure(`${code}:${detail}`);
    }
    const attemptNumber = capture.analysisAttemptCount;
    const retryable = providerError?.retryable ?? true;
    const shouldRetry = retryable && attemptNumber < MAX_ANALYSIS_ATTEMPTS;
    const failedAt = now();
    if (shouldRetry) {
      const retryAt = new Date(
        failedAt.getTime() + getOutboxRetryDelayMs(Math.max(1, attemptNumber)),
      );
      const queued = await requeueCaptureAfterRetryableFailure(db, {
        capture,
        code,
        message: detail,
        retryAt,
        now: failedAt,
      });
      if (!queued) {
        throw new Error("expense_receipt_analysis_retry_finalize_changed");
      }
      console.warn("[expense.receipt] analysis_failed", {
        captureId: capture.id,
        code,
        attemptNumber,
        retryable,
        terminal: false,
      });
      return { status: "retry", error: code, nextAttemptAt: retryAt };
    }

    const failed = await markCaptureAnalysisFailed(db, {
      capture,
      code,
      message: detail,
      now: failedAt,
    });
    if (!failed) {
      throw new Error("expense_receipt_analysis_failure_finalize_changed");
    }
    console.warn("[expense.receipt] analysis_failed", {
      captureId: capture.id,
      code,
      attemptNumber,
      retryable,
      terminal: true,
    });
    return { status: "processed", error: code };
  }
}
