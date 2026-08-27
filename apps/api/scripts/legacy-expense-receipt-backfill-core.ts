import { createHash } from "node:crypto";
import { deterministicLegacyReceiptCaptureId } from "../src/lib/expense-receipt-legacy-id";
import {
  buildExpenseReceiptObjectKeys,
  expenseReceiptContentTypesMatch,
  MAX_EXPENSE_RECEIPT_UPLOAD_BYTES,
  normalizeDeclaredExpenseReceiptContentType,
  sanitizeExpenseReceiptFilename,
  verifyAndNormalizeExpenseReceiptUpload,
  type ExpenseReceiptContentType,
  type VerifiedExpenseReceiptUpload,
} from "../src/lib/expense-receipt-storage";

// Each selected row can carry roughly 14 MiB of base64 text plus a 10 MiB
// decoded original. Keep the whole-query batch deliberately small so this
// maintenance task remains safe on production worker memory limits.
const DEFAULT_BATCH_LIMIT = 10;
const MAX_BATCH_LIMIT = 10;
const CLEANUP_CONFIRMATION = "CLEAR_VERIFIED_LEGACY_RECEIPTS";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,119}$/u;
const MAX_BASE64_LENGTH = Math.ceil(MAX_EXPENSE_RECEIPT_UPLOAD_BYTES / 3) * 4;

export type LegacyReceiptMode = "dry_run" | "execute";
export type LegacyReceiptOperation = "migrate" | "cleanup";

export type LegacyReceiptBackfillOptions = {
  mode: LegacyReceiptMode;
  operation: LegacyReceiptOperation;
  limit: number;
  afterExpenseId: string | null;
  cleanupConfirmed: boolean;
};

export type LegacyExpenseReceiptCandidate = {
  expenseId: string;
  submittedBy: string | null;
  lifecycleStatus: "draft" | "posted" | "voided" | "corrected";
  version: number;
  receiptCaptureId: string | null;
  receiptUrl: string;
  receiptFilename: string | null;
  receiptContentType: string | null;
};

export type LegacyExpenseReceiptCapture = {
  id: string;
  submittedBy: string;
  status:
    | "pending_upload"
    | "uploaded"
    | "queued"
    | "analyzing"
    | "ready"
    | "confirmed"
    | "failed"
    | "discarded";
  storageProvider: string;
  originalObjectKey: string;
  normalizedObjectKey: string | null;
  filename: string;
  declaredContentType: string;
  verifiedContentType: string | null;
  byteLength: number | null;
  sha256: string | null;
};

export type NewLegacyExpenseReceiptCapture = Omit<
  LegacyExpenseReceiptCapture,
  "status"
> & {
  status: "confirmed";
  uploadExpiresAt: Date;
  uploadedAt: Date;
  confirmedAt: Date;
  analysisAttemptCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LegacyReceiptRepository = {
  listCandidates(input: {
    operation: LegacyReceiptOperation;
    afterExpenseId: string | null;
    limit: number;
  }): Promise<LegacyExpenseReceiptCandidate[]>;
  findCapture(captureId: string): Promise<LegacyExpenseReceiptCapture | null>;
  insertCapture(
    capture: NewLegacyExpenseReceiptCapture,
  ): Promise<LegacyExpenseReceiptCapture>;
  attachCaptureToDraft(input: {
    expenseId: string;
    expectedVersion: number;
    captureId: string;
  }): Promise<boolean>;
  clearLegacyDataUrlFromDraft(input: {
    expenseId: string;
    expectedVersion: number;
    captureId: string;
    expectedReceiptUrl: string;
  }): Promise<boolean>;
};

export type LegacyReceiptObjectHead = {
  byteLength: number | null;
  contentType: string | null;
};

export type LegacyReceiptObjectStorage = {
  provider: "r2" | "s3";
  read(key: string): Promise<Buffer | null>;
  head(key: string): Promise<LegacyReceiptObjectHead | null>;
  write(input: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<void>;
};

export type LegacyReceiptBackfillDependencies = {
  repository: LegacyReceiptRepository;
  storage: LegacyReceiptObjectStorage;
  now?: () => Date;
};

export type LegacyReceiptBackfillReport = {
  ok: boolean;
  mode: LegacyReceiptMode;
  operation: LegacyReceiptOperation;
  limit: number;
  scanned: number;
  eligible: number;
  migrated: number;
  alreadyMigrated: number;
  linkedDrafts: number;
  retainedLegacyFallback: number;
  cleanupEligible: number;
  cleaned: number;
  protectedByImmutableLedger: number;
  skipped: Record<string, number>;
  failed: Record<string, number>;
  maybeHasMore: boolean;
  nextCursor: string | null;
};

export class LegacyReceiptBackfillError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LegacyReceiptBackfillError";
  }
}

export { deterministicLegacyReceiptCaptureId };

function exactArgumentValue(args: string[], name: string): string | null {
  const prefix = `${name}=`;
  const matches = args.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) {
    throw new LegacyReceiptBackfillError("duplicate_argument");
  }
  return matches[0]?.slice(prefix.length) ?? null;
}

export function encodeLegacyReceiptCursor(expenseId: string): string {
  if (!UUID_PATTERN.test(expenseId)) {
    throw new LegacyReceiptBackfillError("cursor_expense_id_invalid");
  }
  return Buffer.from(expenseId.toLowerCase(), "utf8").toString("base64url");
}

export function decodeLegacyReceiptCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(cursor)) {
    throw new LegacyReceiptBackfillError("cursor_invalid");
  }
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new LegacyReceiptBackfillError("cursor_invalid");
  }
  if (
    !UUID_PATTERN.test(decoded) ||
    encodeLegacyReceiptCursor(decoded) !== cursor
  ) {
    throw new LegacyReceiptBackfillError("cursor_invalid");
  }
  return decoded.toLowerCase();
}

export function parseLegacyReceiptBackfillArgs(
  args: string[],
): LegacyReceiptBackfillOptions {
  const knownBareArguments = new Set(["--dry-run", "--execute", "--cleanup"]);
  for (const argument of args) {
    if (
      !knownBareArguments.has(argument) &&
      !argument.startsWith("--limit=") &&
      !argument.startsWith("--after=") &&
      !argument.startsWith("--confirm-verified-cleanup=")
    ) {
      throw new LegacyReceiptBackfillError("argument_unknown");
    }
  }

  const execute = args.includes("--execute");
  const dryRun = args.includes("--dry-run");
  if (execute && dryRun) {
    throw new LegacyReceiptBackfillError("mode_conflict");
  }

  const rawLimit = exactArgumentValue(args, "--limit");
  const limit = rawLimit === null ? DEFAULT_BATCH_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_LIMIT) {
    throw new LegacyReceiptBackfillError("limit_invalid");
  }

  const rawCursor = exactArgumentValue(args, "--after");
  if (rawCursor === "") {
    throw new LegacyReceiptBackfillError("cursor_invalid");
  }
  const afterExpenseId = rawCursor
    ? decodeLegacyReceiptCursor(rawCursor)
    : null;
  const operation: LegacyReceiptOperation = args.includes("--cleanup")
    ? "cleanup"
    : "migrate";
  const confirmation = exactArgumentValue(args, "--confirm-verified-cleanup");
  if (confirmation !== null && operation !== "cleanup") {
    throw new LegacyReceiptBackfillError("cleanup_confirmation_unexpected");
  }
  const cleanupConfirmed = confirmation === CLEANUP_CONFIRMATION;
  if (operation === "cleanup" && execute && !cleanupConfirmed) {
    throw new LegacyReceiptBackfillError("cleanup_confirmation_required");
  }
  if (
    operation === "cleanup" &&
    confirmation !== null &&
    confirmation !== CLEANUP_CONFIRMATION
  ) {
    throw new LegacyReceiptBackfillError("cleanup_confirmation_invalid");
  }

  return {
    mode: execute ? "execute" : "dry_run",
    operation,
    limit,
    afterExpenseId,
    cleanupConfirmed,
  };
}

export function safeLegacyReceiptErrorCode(error: unknown): string {
  if (error instanceof LegacyReceiptBackfillError) return error.code;
  const message = error instanceof Error ? error.message : "";
  return SAFE_ERROR_CODE_PATTERN.test(message) ? message : "unexpected_failure";
}

function fallbackFilename(contentType: ExpenseReceiptContentType): string {
  const extension =
    contentType === "application/pdf"
      ? "pdf"
      : contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
          ? "webp"
          : contentType === "image/heic" || contentType === "image/heif"
            ? "heic"
            : "jpg";
  return `legacy-receipt.${extension}`;
}

function decodeCanonicalBoundedBase64(encoded: string): Buffer {
  if (encoded.length === 0 || encoded.length % 4 !== 0) {
    throw new LegacyReceiptBackfillError("legacy_receipt_base64_invalid");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (
    encoded.length > MAX_BASE64_LENGTH ||
    decodedLength > MAX_EXPENSE_RECEIPT_UPLOAD_BYTES
  ) {
    throw new LegacyReceiptBackfillError("legacy_receipt_size_invalid");
  }
  const contentLength = encoded.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = encoded.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) {
      throw new LegacyReceiptBackfillError("legacy_receipt_base64_invalid");
    }
  }
  for (let index = contentLength; index < encoded.length; index += 1) {
    if (encoded.charCodeAt(index) !== 61) {
      throw new LegacyReceiptBackfillError("legacy_receipt_base64_invalid");
    }
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.byteLength !== decodedLength ||
    bytes.toString("base64") !== encoded
  ) {
    throw new LegacyReceiptBackfillError("legacy_receipt_base64_invalid");
  }
  return bytes;
}

export function parseLegacyExpenseReceiptDataUrl(input: {
  value: string;
  persistedContentType: string | null;
}): { bytes: Buffer; declaredContentType: ExpenseReceiptContentType } {
  if (input.value.length < 16 || !input.value.startsWith("data:")) {
    throw new LegacyReceiptBackfillError("legacy_receipt_data_url_invalid");
  }
  const comma = input.value.indexOf(",");
  if (comma < 0 || input.value.indexOf(",", comma + 1) >= 0) {
    throw new LegacyReceiptBackfillError("legacy_receipt_data_url_invalid");
  }
  const metadata = input.value.slice(5, comma);
  const metadataMatch = /^([^;,\s]+);base64$/iu.exec(metadata);
  if (!metadataMatch?.[1]) {
    throw new LegacyReceiptBackfillError("legacy_receipt_encoding_invalid");
  }
  let declaredContentType: ExpenseReceiptContentType;
  try {
    declaredContentType = normalizeDeclaredExpenseReceiptContentType(
      metadataMatch[1],
    );
  } catch {
    throw new LegacyReceiptBackfillError("legacy_receipt_content_type_invalid");
  }

  if (input.persistedContentType?.trim()) {
    let persisted: ExpenseReceiptContentType;
    try {
      persisted = normalizeDeclaredExpenseReceiptContentType(
        input.persistedContentType,
      );
    } catch {
      throw new LegacyReceiptBackfillError(
        "legacy_receipt_persisted_type_invalid",
      );
    }
    if (!expenseReceiptContentTypesMatch(persisted, declaredContentType)) {
      throw new LegacyReceiptBackfillError(
        "legacy_receipt_persisted_type_mismatch",
      );
    }
  }

  const encoded = input.value.slice(comma + 1);
  const bytes = decodeCanonicalBoundedBase64(encoded);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_EXPENSE_RECEIPT_UPLOAD_BYTES
  ) {
    throw new LegacyReceiptBackfillError("legacy_receipt_size_invalid");
  }
  return { bytes, declaredContentType };
}

async function verifyLegacyReceipt(
  candidate: LegacyExpenseReceiptCandidate,
): Promise<{
  declaredContentType: ExpenseReceiptContentType;
  verified: VerifiedExpenseReceiptUpload;
}> {
  const parsed = parseLegacyExpenseReceiptDataUrl({
    value: candidate.receiptUrl,
    persistedContentType: candidate.receiptContentType,
  });
  try {
    const verified = await verifyAndNormalizeExpenseReceiptUpload({
      bytes: parsed.bytes,
      declaredContentType: parsed.declaredContentType,
      declaredByteLength: parsed.bytes.byteLength,
    });
    return {
      declaredContentType: parsed.declaredContentType,
      verified,
    };
  } catch (error) {
    throw new LegacyReceiptBackfillError(safeLegacyReceiptErrorCode(error));
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyStoredObject(input: {
  storage: LegacyReceiptObjectStorage;
  key: string;
  expectedBytes: Buffer;
  expectedContentType: ExpenseReceiptContentType | "image/jpeg";
  allowCreate: boolean;
}): Promise<void> {
  let stored = await input.storage.read(input.key);
  if (stored === null) {
    if (!input.allowCreate) {
      throw new LegacyReceiptBackfillError("receipt_object_missing");
    }
    await input.storage.write({
      key: input.key,
      body: input.expectedBytes,
      contentType: input.expectedContentType,
    });
    stored = await input.storage.read(input.key);
  }
  if (stored === null) {
    throw new LegacyReceiptBackfillError("receipt_object_reread_missing");
  }
  if (
    stored.byteLength !== input.expectedBytes.byteLength ||
    sha256(stored) !== sha256(input.expectedBytes)
  ) {
    throw new LegacyReceiptBackfillError("receipt_object_hash_mismatch");
  }
  const head = await input.storage.head(input.key);
  if (!head || head.byteLength !== input.expectedBytes.byteLength) {
    throw new LegacyReceiptBackfillError("receipt_object_head_mismatch");
  }
  if (!head.contentType) {
    throw new LegacyReceiptBackfillError("receipt_object_content_type_missing");
  }
  let storedContentType: ExpenseReceiptContentType;
  try {
    storedContentType = normalizeDeclaredExpenseReceiptContentType(
      head.contentType,
    );
  } catch {
    throw new LegacyReceiptBackfillError("receipt_object_content_type_invalid");
  }
  if (
    !expenseReceiptContentTypesMatch(
      input.expectedContentType,
      storedContentType,
    )
  ) {
    throw new LegacyReceiptBackfillError(
      "receipt_object_content_type_mismatch",
    );
  }
}

function assertExistingCaptureMatches(input: {
  capture: LegacyExpenseReceiptCapture;
  expected: NewLegacyExpenseReceiptCapture;
}): void {
  const { capture, expected } = input;
  if (
    capture.id !== expected.id ||
    capture.submittedBy !== expected.submittedBy ||
    capture.status !== "confirmed" ||
    capture.storageProvider !== expected.storageProvider ||
    capture.originalObjectKey !== expected.originalObjectKey ||
    capture.normalizedObjectKey !== expected.normalizedObjectKey ||
    capture.filename !== expected.filename ||
    capture.declaredContentType !== expected.declaredContentType ||
    capture.verifiedContentType !== expected.verifiedContentType ||
    capture.byteLength !== expected.byteLength ||
    capture.sha256 !== expected.sha256
  ) {
    throw new LegacyReceiptBackfillError("receipt_capture_conflict");
  }
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

async function migrateCandidate(input: {
  candidate: LegacyExpenseReceiptCandidate;
  options: LegacyReceiptBackfillOptions;
  dependencies: LegacyReceiptBackfillDependencies;
}): Promise<"migrated" | "already_migrated" | "eligible"> {
  const { candidate, options, dependencies } = input;
  if (!candidate.submittedBy || !UUID_PATTERN.test(candidate.submittedBy)) {
    throw new LegacyReceiptBackfillError("receipt_submitter_missing");
  }
  if (candidate.receiptCaptureId) {
    throw new LegacyReceiptBackfillError("receipt_capture_already_linked");
  }
  const receipt = await verifyLegacyReceipt(candidate);
  const { verified } = receipt;
  const captureId = deterministicLegacyReceiptCaptureId(candidate.expenseId);
  const keys = buildExpenseReceiptObjectKeys({
    memberId: candidate.submittedBy,
    captureId,
    contentType: verified.verifiedContentType,
  });
  const now = dependencies.now?.() ?? new Date();
  const expectedCapture: NewLegacyExpenseReceiptCapture = {
    id: captureId,
    submittedBy: candidate.submittedBy,
    status: "confirmed",
    storageProvider: dependencies.storage.provider,
    originalObjectKey: keys.originalObjectKey,
    normalizedObjectKey: verified.normalized ? keys.normalizedObjectKey : null,
    filename: sanitizeExpenseReceiptFilename(
      candidate.receiptFilename ??
        fallbackFilename(verified.verifiedContentType),
    ),
    declaredContentType: receipt.declaredContentType,
    verifiedContentType: verified.verifiedContentType,
    byteLength: verified.byteLength,
    sha256: verified.sha256,
    uploadExpiresAt: now,
    uploadedAt: now,
    confirmedAt: now,
    analysisAttemptCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  const existing = await dependencies.repository.findCapture(captureId);
  if (options.mode === "dry_run") {
    if (existing) {
      assertExistingCaptureMatches({
        capture: existing,
        expected: expectedCapture,
      });
      await verifyStoredObject({
        storage: dependencies.storage,
        key: keys.originalObjectKey,
        expectedBytes: verified.originalBytes,
        expectedContentType: verified.verifiedContentType,
        allowCreate: false,
      });
      if (verified.normalized && keys.normalizedObjectKey) {
        await verifyStoredObject({
          storage: dependencies.storage,
          key: keys.normalizedObjectKey,
          expectedBytes: verified.normalized.bytes,
          expectedContentType: verified.normalized.contentType,
          allowCreate: false,
        });
      }
    }
    return existing ? "already_migrated" : "eligible";
  }

  await verifyStoredObject({
    storage: dependencies.storage,
    key: keys.originalObjectKey,
    expectedBytes: verified.originalBytes,
    expectedContentType: verified.verifiedContentType,
    allowCreate: true,
  });
  if (verified.normalized && keys.normalizedObjectKey) {
    await verifyStoredObject({
      storage: dependencies.storage,
      key: keys.normalizedObjectKey,
      expectedBytes: verified.normalized.bytes,
      expectedContentType: verified.normalized.contentType,
      allowCreate: true,
    });
  }

  const capture = existing
    ? existing
    : await dependencies.repository.insertCapture(expectedCapture);
  assertExistingCaptureMatches({ capture, expected: expectedCapture });
  if (candidate.lifecycleStatus === "draft") {
    const attached = await dependencies.repository.attachCaptureToDraft({
      expenseId: candidate.expenseId,
      expectedVersion: candidate.version,
      captureId,
    });
    if (!attached) {
      throw new LegacyReceiptBackfillError("expense_capture_link_conflict");
    }
  }
  return existing ? "already_migrated" : "migrated";
}

async function verifyCleanupCandidate(input: {
  candidate: LegacyExpenseReceiptCandidate;
  dependencies: LegacyReceiptBackfillDependencies;
}): Promise<void> {
  const { candidate, dependencies } = input;
  if (!candidate.receiptCaptureId) {
    throw new LegacyReceiptBackfillError("receipt_capture_not_linked");
  }
  const receipt = await verifyLegacyReceipt(candidate);
  const { verified } = receipt;
  const capture = await dependencies.repository.findCapture(
    candidate.receiptCaptureId,
  );
  if (!capture || capture.status !== "confirmed") {
    throw new LegacyReceiptBackfillError("receipt_capture_not_confirmed");
  }
  let captureDeclaredContentType: ExpenseReceiptContentType;
  try {
    captureDeclaredContentType = normalizeDeclaredExpenseReceiptContentType(
      capture.declaredContentType,
    );
  } catch {
    throw new LegacyReceiptBackfillError(
      "receipt_capture_content_type_invalid",
    );
  }
  if (
    capture.storageProvider !== dependencies.storage.provider ||
    !expenseReceiptContentTypesMatch(
      receipt.declaredContentType,
      captureDeclaredContentType,
    ) ||
    capture.sha256 !== verified.sha256 ||
    capture.byteLength !== verified.byteLength ||
    capture.verifiedContentType !== verified.verifiedContentType
  ) {
    throw new LegacyReceiptBackfillError("receipt_capture_hash_mismatch");
  }
  await verifyStoredObject({
    storage: dependencies.storage,
    key: capture.originalObjectKey,
    expectedBytes: verified.originalBytes,
    expectedContentType: verified.verifiedContentType,
    allowCreate: false,
  });
}

export async function runLegacyReceiptBackfill(
  options: LegacyReceiptBackfillOptions,
  dependencies: LegacyReceiptBackfillDependencies,
): Promise<LegacyReceiptBackfillReport> {
  if (
    options.operation === "cleanup" &&
    options.mode === "execute" &&
    !options.cleanupConfirmed
  ) {
    throw new LegacyReceiptBackfillError("cleanup_confirmation_required");
  }
  const candidates = await dependencies.repository.listCandidates({
    operation: options.operation,
    afterExpenseId: options.afterExpenseId,
    limit: options.limit,
  });
  if (candidates.length > options.limit) {
    throw new LegacyReceiptBackfillError("repository_limit_violated");
  }
  const report: LegacyReceiptBackfillReport = {
    ok: true,
    mode: options.mode,
    operation: options.operation,
    limit: options.limit,
    scanned: candidates.length,
    eligible: 0,
    migrated: 0,
    alreadyMigrated: 0,
    linkedDrafts: 0,
    retainedLegacyFallback: 0,
    cleanupEligible: 0,
    cleaned: 0,
    protectedByImmutableLedger: 0,
    skipped: {},
    failed: {},
    maybeHasMore: candidates.length === options.limit,
    nextCursor:
      candidates.length === options.limit
        ? encodeLegacyReceiptCursor(
            candidates[candidates.length - 1]!.expenseId,
          )
        : null,
  };

  for (const candidate of candidates) {
    try {
      if (options.operation === "migrate") {
        const result = await migrateCandidate({
          candidate,
          options,
          dependencies,
        });
        if (result === "eligible") report.eligible += 1;
        if (result === "migrated") report.migrated += 1;
        if (result === "already_migrated") report.alreadyMigrated += 1;
        if (
          candidate.lifecycleStatus === "draft" &&
          options.mode === "execute"
        ) {
          report.linkedDrafts += 1;
        }
        // Migration deliberately leaves the data URL untouched. Posted rows
        // remain protected by the immutable ledger and retain this fallback.
        report.retainedLegacyFallback += 1;
        continue;
      }

      await verifyCleanupCandidate({ candidate, dependencies });
      report.cleanupEligible += 1;
      if (candidate.lifecycleStatus !== "draft") {
        report.protectedByImmutableLedger += 1;
        continue;
      }
      if (options.mode === "execute") {
        const cleared =
          await dependencies.repository.clearLegacyDataUrlFromDraft({
            expenseId: candidate.expenseId,
            expectedVersion: candidate.version,
            captureId: candidate.receiptCaptureId!,
            expectedReceiptUrl: candidate.receiptUrl,
          });
        if (!cleared) {
          throw new LegacyReceiptBackfillError("expense_cleanup_conflict");
        }
        report.cleaned += 1;
      }
    } catch (error) {
      const code = safeLegacyReceiptErrorCode(error);
      increment(report.failed, code);
      report.ok = false;
    }
  }

  return report;
}
