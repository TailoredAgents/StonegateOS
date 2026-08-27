import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  decodeLegacyReceiptCursor,
  deterministicLegacyReceiptCaptureId,
  encodeLegacyReceiptCursor,
  LegacyReceiptBackfillError,
  parseLegacyExpenseReceiptDataUrl,
  parseLegacyReceiptBackfillArgs,
  runLegacyReceiptBackfill,
  safeLegacyReceiptErrorCode,
  type LegacyExpenseReceiptCandidate,
  type LegacyExpenseReceiptCapture,
  type LegacyReceiptObjectStorage,
  type LegacyReceiptRepository,
  type NewLegacyExpenseReceiptCapture,
} from "../../scripts/legacy-expense-receipt-backfill-core";

const EXPENSE_ID = "10000000-0000-4000-8000-000000000001";
const MEMBER_ID = "20000000-0000-4000-8000-000000000002";
const PDF = Buffer.from("%PDF-1.7\nlegacy receipt\n%%EOF", "ascii");

function dataUrl(bytes: Buffer, contentType = "application/pdf"): string {
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

function candidate(
  overrides: Partial<LegacyExpenseReceiptCandidate> = {},
): LegacyExpenseReceiptCandidate {
  return {
    expenseId: EXPENSE_ID,
    submittedBy: MEMBER_ID,
    lifecycleStatus: "posted",
    version: 1,
    receiptCaptureId: null,
    receiptUrl: dataUrl(PDF),
    receiptFilename: "legacy.pdf",
    receiptContentType: "application/pdf",
    ...overrides,
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function memoryHarness(
  initial: {
    candidates?: LegacyExpenseReceiptCandidate[];
    captures?: LegacyExpenseReceiptCapture[];
    objects?: Map<string, { bytes: Buffer; contentType: string }>;
  } = {},
) {
  const candidates = initial.candidates ?? [candidate()];
  const captures = new Map(
    (initial.captures ?? []).map((capture) => [capture.id, capture]),
  );
  const objects =
    initial.objects ??
    new Map<string, { bytes: Buffer; contentType: string }>();
  const events: string[] = [];
  let writes = 0;
  let inserts = 0;
  let attaches = 0;
  let clears = 0;

  const repository: LegacyReceiptRepository = {
    listCandidates(input) {
      events.push(`list:${input.operation}`);
      return Promise.resolve(candidates.slice(0, input.limit));
    },
    findCapture(captureId) {
      events.push("find_capture");
      return Promise.resolve(captures.get(captureId) ?? null);
    },
    insertCapture(capture: NewLegacyExpenseReceiptCapture) {
      events.push("insert_capture");
      inserts += 1;
      const existing = captures.get(capture.id);
      if (existing) return Promise.resolve(existing);
      captures.set(capture.id, capture);
      return Promise.resolve(capture);
    },
    attachCaptureToDraft() {
      events.push("attach");
      attaches += 1;
      return Promise.resolve(true);
    },
    clearLegacyDataUrlFromDraft() {
      events.push("clear");
      clears += 1;
      return Promise.resolve(true);
    },
  };
  const storage: LegacyReceiptObjectStorage = {
    provider: "r2",
    read(key) {
      events.push("read");
      return Promise.resolve(objects.get(key)?.bytes ?? null);
    },
    head(key) {
      events.push("head");
      const object = objects.get(key);
      return Promise.resolve(
        object
          ? {
              byteLength: object.bytes.byteLength,
              contentType: object.contentType,
            }
          : null,
      );
    },
    write(input) {
      events.push("write");
      writes += 1;
      if (!objects.has(input.key)) {
        objects.set(input.key, {
          bytes: Buffer.from(input.body),
          contentType: input.contentType,
        });
      }
      return Promise.resolve();
    },
  };

  return {
    repository,
    storage,
    captures,
    objects,
    events,
    counts: () => ({ writes, inserts, attaches, clears }),
  };
}

describe("legacy expense receipt backfill", () => {
  it("defaults to a bounded dry run and gates destructive cleanup", () => {
    expect(parseLegacyReceiptBackfillArgs([])).toEqual({
      mode: "dry_run",
      operation: "migrate",
      limit: 10,
      afterExpenseId: null,
      cleanupConfirmed: false,
    });
    expect(
      parseLegacyReceiptBackfillArgs(["--execute", "--limit=10"]),
    ).toMatchObject({ mode: "execute", operation: "migrate", limit: 10 });
    expect(() =>
      parseLegacyReceiptBackfillArgs(["--execute", "--cleanup"]),
    ).toThrow("cleanup_confirmation_required");
    expect(() =>
      parseLegacyReceiptBackfillArgs([
        "--execute",
        "--cleanup",
        "--confirm-verified-cleanup=almost",
      ]),
    ).toThrow("cleanup_confirmation_required");
    expect(
      parseLegacyReceiptBackfillArgs([
        "--execute",
        "--cleanup",
        "--confirm-verified-cleanup=CLEAR_VERIFIED_LEGACY_RECEIPTS",
      ]),
    ).toMatchObject({
      mode: "execute",
      operation: "cleanup",
      cleanupConfirmed: true,
    });
    expect(() => parseLegacyReceiptBackfillArgs(["--limit=11"])).toThrow(
      "limit_invalid",
    );
    expect(() => parseLegacyReceiptBackfillArgs(["--surprise"])).toThrow(
      "argument_unknown",
    );
  });

  it("uses canonical opaque cursors and deterministic retry IDs", () => {
    const cursor = encodeLegacyReceiptCursor(EXPENSE_ID);
    expect(decodeLegacyReceiptCursor(cursor)).toBe(EXPENSE_ID);
    expect(
      parseLegacyReceiptBackfillArgs([`--after=${cursor}`]).afterExpenseId,
    ).toBe(EXPENSE_ID);
    expect(() => decodeLegacyReceiptCursor(`${cursor}x`)).toThrow(
      "cursor_invalid",
    );
    expect(deterministicLegacyReceiptCaptureId(EXPENSE_ID)).toBe(
      deterministicLegacyReceiptCaptureId(EXPENSE_ID),
    );
    expect(deterministicLegacyReceiptCaptureId(EXPENSE_ID)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("strictly verifies canonical data URLs, persisted types, and actual bytes", async () => {
    expect(
      parseLegacyExpenseReceiptDataUrl({
        value: dataUrl(PDF),
        persistedContentType: "APPLICATION/PDF; charset=binary",
      }).bytes,
    ).toEqual(PDF);
    expect(() =>
      parseLegacyExpenseReceiptDataUrl({
        value: "data:application/pdf;base64,%%%%",
        persistedContentType: "application/pdf",
      }),
    ).toThrow("legacy_receipt_base64_invalid");
    expect(() =>
      parseLegacyExpenseReceiptDataUrl({
        value: dataUrl(PDF),
        persistedContentType: "image/png",
      }),
    ).toThrow("legacy_receipt_persisted_type_mismatch");
    expect(() =>
      parseLegacyExpenseReceiptDataUrl({
        value: `data:application/pdf;charset=utf-8;base64,${PDF.toString("base64")}`,
        persistedContentType: "application/pdf",
      }),
    ).toThrow("legacy_receipt_encoding_invalid");
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    expect(() =>
      parseLegacyExpenseReceiptDataUrl({
        value: dataUrl(oversized),
        persistedContentType: "application/pdf",
      }),
    ).toThrow("legacy_receipt_size_invalid");

    const harness = memoryHarness({
      candidates: [
        candidate({
          receiptUrl: dataUrl(PDF, "image/png"),
          receiptContentType: "image/png",
        }),
      ],
    });
    const report = await runLegacyReceiptBackfill(
      parseLegacyReceiptBackfillArgs([]),
      harness,
    );
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual({ receipt_upload_type_mismatch: 1 });
    expect(harness.counts()).toEqual({
      writes: 0,
      inserts: 0,
      attaches: 0,
      clears: 0,
    });
  });

  it("dry-runs without storage or database writes", async () => {
    const harness = memoryHarness();
    const report = await runLegacyReceiptBackfill(
      parseLegacyReceiptBackfillArgs(["--limit=1"]),
      harness,
    );
    expect(report).toMatchObject({
      ok: true,
      mode: "dry_run",
      operation: "migrate",
      scanned: 1,
      eligible: 1,
      migrated: 0,
      retainedLegacyFallback: 1,
      maybeHasMore: true,
    });
    expect(report.nextCursor).not.toBeNull();
    expect(harness.counts()).toEqual({
      writes: 0,
      inserts: 0,
      attaches: 0,
      clears: 0,
    });
    expect(JSON.stringify(report)).not.toContain("legacy.pdf");
    expect(JSON.stringify(report)).not.toContain(MEMBER_ID);
    expect(JSON.stringify(report)).not.toContain(PDF.toString("base64"));
  });

  it("stores an immutable original, re-reads it, and retains the legacy fallback", async () => {
    const harness = memoryHarness();
    const options = parseLegacyReceiptBackfillArgs(["--execute"]);
    const first = await runLegacyReceiptBackfill(options, harness);
    expect(first).toMatchObject({
      ok: true,
      migrated: 1,
      retainedLegacyFallback: 1,
      linkedDrafts: 0,
    });
    expect(harness.counts()).toEqual({
      writes: 1,
      inserts: 1,
      attaches: 0,
      clears: 0,
    });
    const capture = harness.captures.get(
      deterministicLegacyReceiptCaptureId(EXPENSE_ID),
    );
    expect(capture).toMatchObject({
      status: "confirmed",
      storageProvider: "r2",
      sha256: sha256(PDF),
      byteLength: PDF.byteLength,
    });
    expect(harness.events).toEqual(
      expect.arrayContaining(["write", "read", "head", "insert_capture"]),
    );

    const second = await runLegacyReceiptBackfill(options, harness);
    expect(second).toMatchObject({ ok: true, alreadyMigrated: 1 });
    expect(harness.counts()).toEqual({
      writes: 1,
      inserts: 1,
      attaches: 0,
      clears: 0,
    });
  });

  it("creates a normalized image derivative with the existing receipt utility", async () => {
    const png = await sharp({
      create: {
        width: 12,
        height: 8,
        channels: 3,
        background: "#ffffff",
      },
    })
      .png()
      .toBuffer();
    const harness = memoryHarness({
      candidates: [
        candidate({
          receiptUrl: dataUrl(png, "image/png"),
          receiptFilename: "legacy.png",
          receiptContentType: "image/png",
        }),
      ],
    });
    const report = await runLegacyReceiptBackfill(
      parseLegacyReceiptBackfillArgs(["--execute"]),
      harness,
    );
    expect(report.ok).toBe(true);
    expect(harness.counts().writes).toBe(2);
    const capture = harness.captures.get(
      deterministicLegacyReceiptCaptureId(EXPENSE_ID),
    );
    expect(capture?.normalizedObjectKey).toMatch(/\/normalized\.jpg$/u);
    expect(harness.objects.size).toBe(2);
  });

  it("never overwrites a conflicting object and never inserts its capture", async () => {
    const captureId = deterministicLegacyReceiptCaptureId(EXPENSE_ID);
    const originalKey = `expenses/receipts/${MEMBER_ID}/${captureId}/original.pdf`;
    const objects = new Map([
      [
        originalKey,
        { bytes: Buffer.from("different"), contentType: "application/pdf" },
      ],
    ]);
    const harness = memoryHarness({ objects });
    const report = await runLegacyReceiptBackfill(
      parseLegacyReceiptBackfillArgs(["--execute"]),
      harness,
    );
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual({ receipt_object_hash_mismatch: 1 });
    expect(objects.get(originalKey)?.bytes.toString()).toBe("different");
    expect(harness.counts()).toMatchObject({ writes: 0, inserts: 0 });
  });

  it("links only drafts and cleanup re-reads the object before clearing", async () => {
    const draft = candidate({ lifecycleStatus: "draft" });
    const harness = memoryHarness({ candidates: [draft] });
    const migration = await runLegacyReceiptBackfill(
      parseLegacyReceiptBackfillArgs(["--execute"]),
      harness,
    );
    expect(migration).toMatchObject({ ok: true, linkedDrafts: 1 });
    expect(harness.counts().attaches).toBe(1);

    const captureId = deterministicLegacyReceiptCaptureId(EXPENSE_ID);
    draft.receiptCaptureId = captureId;
    draft.version = 2;
    const beforeCleanupEvents = harness.events.length;
    const cleanup = await runLegacyReceiptBackfill(
      parseLegacyReceiptBackfillArgs([
        "--cleanup",
        "--execute",
        "--confirm-verified-cleanup=CLEAR_VERIFIED_LEGACY_RECEIPTS",
      ]),
      harness,
    );
    expect(cleanup).toMatchObject({ ok: true, cleanupEligible: 1, cleaned: 1 });
    const cleanupEvents = harness.events.slice(beforeCleanupEvents);
    expect(cleanupEvents.indexOf("read")).toBeGreaterThanOrEqual(0);
    expect(cleanupEvents.indexOf("clear")).toBeGreaterThan(
      cleanupEvents.indexOf("read"),
    );
  });

  it("keeps posted legacy fallbacks even after successful object verification", async () => {
    const posted = candidate();
    const harness = memoryHarness({ candidates: [posted] });
    await runLegacyReceiptBackfill(
      parseLegacyReceiptBackfillArgs(["--execute"]),
      harness,
    );
    posted.receiptCaptureId = deterministicLegacyReceiptCaptureId(EXPENSE_ID);
    const cleanup = await runLegacyReceiptBackfill(
      parseLegacyReceiptBackfillArgs(["--cleanup"]),
      harness,
    );
    expect(cleanup).toMatchObject({
      ok: true,
      cleanupEligible: 1,
      cleaned: 0,
      protectedByImmutableLedger: 1,
    });
    expect(harness.counts().clears).toBe(0);
  });

  it("refuses cleanup when the R2 re-read hash differs", async () => {
    const draft = candidate({ lifecycleStatus: "draft" });
    const harness = memoryHarness({ candidates: [draft] });
    await runLegacyReceiptBackfill(
      parseLegacyReceiptBackfillArgs(["--execute"]),
      harness,
    );
    const captureId = deterministicLegacyReceiptCaptureId(EXPENSE_ID);
    draft.receiptCaptureId = captureId;
    const capture = harness.captures.get(captureId)!;
    harness.objects.set(capture.originalObjectKey, {
      bytes: Buffer.from("tampered"),
      contentType: "application/pdf",
    });
    const cleanup = await runLegacyReceiptBackfill(
      parseLegacyReceiptBackfillArgs([
        "--cleanup",
        "--execute",
        "--confirm-verified-cleanup=CLEAR_VERIFIED_LEGACY_RECEIPTS",
      ]),
      harness,
    );
    expect(cleanup.ok).toBe(false);
    expect(cleanup.failed).toEqual({ receipt_object_hash_mismatch: 1 });
    expect(harness.counts().clears).toBe(0);
  });

  it("redacts unsafe failures to an aggregate error code", () => {
    const secret = dataUrl(PDF);
    expect(safeLegacyReceiptErrorCode(new Error(secret))).toBe(
      "unexpected_failure",
    );
    expect(
      safeLegacyReceiptErrorCode(
        new LegacyReceiptBackfillError("receipt_object_hash_mismatch"),
      ),
    ).toBe("receipt_object_hash_mismatch");
  });
});
