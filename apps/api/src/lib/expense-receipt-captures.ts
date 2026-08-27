import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  auditLogs,
  expenseReceiptCaptures,
  expenseVendorCategoryRules,
  getDb,
  outboxEvents,
} from "@/db";
import {
  buildExpenseReceiptReview,
  detectExpenseReceiptDuplicates,
  ExpenseReceiptExtractionSchema,
  normalizeReceiptVendor,
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
  expenseReceiptContentTypesMatch,
  ExpenseReceiptUploadIntentSchema,
  normalizeDeclaredExpenseReceiptContentType,
  sanitizeExpenseReceiptFilename,
  verifyAndNormalizeExpenseReceiptUpload,
  type ExpenseReceiptContentType,
  type ExpenseReceiptUploadIntentInput,
} from "@/lib/expense-receipt-storage";
import {
  createMediaReadUrl,
  createMediaUploadUrl,
  getMediaObject,
  getMediaStorageProvider,
  headMediaObject,
  putMediaObject,
} from "@/lib/media-storage";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/provider-health";

const UPLOAD_URL_LIFETIME_SECONDS = 5 * 60;
const ANALYSIS_LEASE_MS = 10 * 60 * 1_000;
const MAX_ANALYSIS_ATTEMPTS = 5;
const MAX_DUPLICATE_CANDIDATES = 10_000;

type CaptureRow = typeof expenseReceiptCaptures.$inferSelect;
type CaptureStatus = CaptureRow["status"];

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

async function findCapture(captureId: string): Promise<CaptureRow | null> {
  const [capture] = await getDb()
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
  analysisModel: string | null;
  extraction: Record<string, unknown> | null;
  exactDuplicateOfCaptureId: string | null;
  failure: { code: string; message: string | null } | null;
  contentPath: string | null;
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
    requiresHumanConfirmation: true,
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

  const remainingSeconds = Math.floor(
    (existing.uploadExpiresAt.getTime() - Date.now()) / 1_000,
  );
  if (remainingSeconds < 30) {
    throw new ExpenseReceiptCaptureError(
      "expense_receipt_upload_intent_expired",
      409,
      "Create a new receipt capture before retrying this upload.",
    );
  }
  const retrySigned = await createMediaUploadUrl({
    key: existing.originalObjectKey,
    contentType: existing.declaredContentType,
    byteLength: existing.byteLength ?? upload.byteLength,
    checksumSha256Hex: existing.sha256,
    expiresInSeconds: Math.min(remainingSeconds, UPLOAD_URL_LIFETIME_SECONDS),
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
  if (head.contentType) {
    let storedContentType: ExpenseReceiptContentType;
    try {
      storedContentType = normalizeDeclaredExpenseReceiptContentType(
        head.contentType,
      );
    } catch {
      throw new ExpenseReceiptCaptureError("receipt_upload_type_mismatch", 400);
    }
    if (
      !expenseReceiptContentTypesMatch(declaredContentType, storedContentType)
    ) {
      throw new ExpenseReceiptCaptureError("receipt_upload_type_mismatch", 400);
    }
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
    await putMediaObject({
      key: normalizedObjectKey,
      body: verified.normalized.bytes,
      contentType: verified.normalized.contentType,
    });
    const normalizedHead = await headMediaObject(normalizedObjectKey);
    if (normalizedHead.byteLength !== verified.normalized.bytes.byteLength) {
      throw new ExpenseReceiptCaptureError(
        "expense_receipt_storage_verification_failed",
        502,
      );
    }
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
  assertReceiptFeatureEnabled();
  return toExpenseReceiptCaptureStatusDto(await findCaptureForViewer(input));
}

export async function discardExpenseReceiptCapture(input: {
  captureId: string;
  viewerId: string;
  canReviewAll: boolean;
}): Promise<ExpenseReceiptCaptureStatusDto> {
  assertReceiptFeatureEnabled();
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
  assertReceiptFeatureEnabled();
  const capture = await findCaptureForViewer(input);
  if (!capture.uploadedAt || capture.status === "discarded") {
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
  schemaVersion: 1;
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
  const parsed = ExpenseReceiptExtractionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

async function duplicateCandidatesForCapture(
  capture: CaptureRow,
): Promise<ReceiptDuplicateCandidate[]> {
  const rows = await getDb()
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
): Promise<ReturnType<typeof selectExpenseCategory>> {
  const normalizedVendor = normalizeReceiptVendor(extraction.vendor);
  if (!normalizedVendor) {
    return selectExpenseCategory({
      vendor: extraction.vendor,
      rules: [],
      aiSuggestedCategoryId: extraction.suggestedCategoryId,
    });
  }
  const rows = await getDb()
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

async function markCaptureAnalysisFailed(input: {
  capture: CaptureRow;
  code: string;
  message: string;
}): Promise<CaptureRow | null> {
  const now = new Date();
  const [failed] = await getDb()
    .update(expenseReceiptCaptures)
    .set({
      status: "failed",
      failureCode: input.code.slice(0, 160),
      failureMessage: input.message.slice(0, 500),
      analysisCompletedAt: now,
      version: input.capture.version + 1,
      updatedAt: now,
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

async function resetFailedCaptureToQueued(
  capture: CaptureRow,
): Promise<CaptureRow> {
  const now = new Date();
  const [queued] = await getDb()
    .update(expenseReceiptCaptures)
    .set({
      status: "queued",
      analysisQueuedAt: now,
      analysisStartedAt: null,
      analysisCompletedAt: null,
      failureCode: null,
      failureMessage: null,
      version: capture.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(expenseReceiptCaptures.id, capture.id),
        eq(expenseReceiptCaptures.status, "failed"),
        eq(expenseReceiptCaptures.version, capture.version),
      ),
    )
    .returning();
  if (!queued) {
    throw new Error("expense_receipt_retry_claim_failed");
  }
  return queued;
}

async function claimCaptureForAnalysis(
  captureId: string,
): Promise<
  | { kind: "claimed"; capture: CaptureRow }
  | { kind: "complete" }
  | { kind: "retry"; at: Date; error: string }
> {
  let capture = await findCapture(captureId);
  if (
    !capture ||
    ["ready", "confirmed", "discarded"].includes(capture.status)
  ) {
    return { kind: "complete" };
  }
  if (capture.status === "analyzing") {
    const leaseStarted = capture.analysisStartedAt?.getTime() ?? Date.now();
    const leaseExpiresAt = new Date(leaseStarted + ANALYSIS_LEASE_MS);
    if (leaseExpiresAt.getTime() > Date.now()) {
      return {
        kind: "retry",
        at: leaseExpiresAt,
        error: "expense_receipt_analysis_in_flight",
      };
    }
    const failed = await markCaptureAnalysisFailed({
      capture,
      code: "expense_receipt_analysis_lease_expired",
      message:
        "The previous analysis worker did not finish before its lease expired.",
    });
    if (!failed) {
      return {
        kind: "retry",
        at: new Date(Date.now() + 30_000),
        error: "expense_receipt_analysis_claim_changed",
      };
    }
    capture = failed;
  }
  if (capture.status === "failed") {
    capture = await resetFailedCaptureToQueued(capture);
  }
  if (capture.status !== "queued") {
    return { kind: "complete" };
  }

  const now = new Date();
  const [claimed] = await getDb()
    .update(expenseReceiptCaptures)
    .set({
      status: "analyzing",
      analysisStartedAt: now,
      analysisCompletedAt: null,
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

/** Worker entry point. It can only move a capture to review-ready or failed. */
export async function processExpenseReceiptAnalysisOutbox(input: {
  captureId: string;
  priorAttempts: number;
}): Promise<ExpenseReceiptAnalysisOutboxOutcome> {
  if (!isExpenseReceiptCaptureEnabled()) {
    return {
      status: "retry",
      error: "expense_receipt_capture_disabled",
      nextAttemptAt: new Date(Date.now() + 15 * 60_000),
    };
  }
  const claim = await claimCaptureForAnalysis(input.captureId);
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

    const candidates = await duplicateCandidatesForCapture(capture);
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
    );
    const storedExtraction: StoredExtraction = {
      schemaVersion: 1,
      raw: analyzed.extraction,
      review,
      categorySuggestion,
      duplicates,
    };
    const exactDuplicateOfCaptureId =
      capture.exactDuplicateOfCaptureId ??
      duplicates.exactMatches[0]?.candidateId ??
      null;
    const now = new Date();
    const [ready] = await getDb()
      .update(expenseReceiptCaptures)
      .set({
        status: "ready",
        analysisModel: analyzed.model,
        extraction: storedExtraction,
        analysisWarnings: analyzed.extraction.warnings,
        exactDuplicateOfCaptureId,
        analysisCompletedAt: now,
        failureCode: null,
        failureMessage: null,
        version: capture.version + 1,
        updatedAt: now,
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

    await getDb()
      .insert(auditLogs)
      .values({
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
          humanConfirmationRequired: true,
        },
        createdAt: now,
      });
    console.info("[expense.receipt] analysis_ready", {
      captureId: capture.id,
      model: analyzed.model,
      fieldsToCheck: review.fieldsToCheck.length,
      duplicateRisk: duplicates.highestRisk,
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
    await markCaptureAnalysisFailed({ capture, code, message: detail });
    const attemptNumber = input.priorAttempts + 1;
    const retryable = providerError?.retryable ?? true;
    console.warn("[expense.receipt] analysis_failed", {
      captureId: capture.id,
      code,
      attemptNumber,
      retryable,
    });
    return retryable && attemptNumber < MAX_ANALYSIS_ATTEMPTS
      ? { status: "retry", error: code }
      : { status: "processed", error: code };
  }
}
