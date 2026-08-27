const mockDeleteMediaObject = jest.fn<Promise<void>, [string]>();
const mockPutImmutableMediaObject = jest.fn<
  Promise<"created" | "already_exists">,
  [Record<string, unknown>]
>();
const mockVerifyAndNormalize = jest.fn();

jest.mock("@/lib/media-storage", () => ({
  deleteMediaObject: mockDeleteMediaObject,
  getMediaStorageProvider: () => "r2",
  putImmutableMediaObject: mockPutImmutableMediaObject,
}));
jest.mock("@/lib/expense-receipt-storage", () => ({
  buildExpenseReceiptObjectKeys: ({
    submittedBy: _submittedBy,
    memberId,
    captureId,
  }: {
    submittedBy?: string;
    memberId: string;
    captureId: string;
  }) => ({
    originalObjectKey: `expenses/receipts/${memberId}/${captureId}/original.jpg`,
    normalizedObjectKey: `expenses/receipts/${memberId}/${captureId}/normalized.jpg`,
  }),
  verifyAndNormalizeExpenseReceiptUpload: mockVerifyAndNormalize,
}));

import {
  cleanupStagedExpenseReceiptEvidence,
  cleanupStagedExpenseReceiptEvidenceIfUncommitted,
  stageExpenseReceiptEvidence,
} from "@/lib/expense-receipt-evidence";
import type { DatabaseClient } from "@/db";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const CAPTURE_ID = "22222222-2222-4222-8222-222222222222";
const ORIGINAL = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const NORMALIZED = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);

function makeCaptureLookupDb(result: unknown[] | Error): DatabaseClient {
  const limit =
    result instanceof Error
      ? jest.fn().mockRejectedValue(result)
      : jest.fn().mockResolvedValue(result);
  const where = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  return { select } as unknown as DatabaseClient;
}

async function stageReceiptEvidence() {
  return stageExpenseReceiptEvidence({
    captureId: CAPTURE_ID,
    submittedBy: MEMBER_ID,
    receipt: {
      filename: "receipt.jpg",
      contentType: "image/jpeg",
      bytes: ORIGINAL,
      sha256: "a".repeat(64),
      byteLength: ORIGINAL.byteLength,
    },
  });
}

describe("manual expense receipt evidence storage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteMediaObject.mockResolvedValue();
    mockPutImmutableMediaObject.mockResolvedValue("created");
    mockVerifyAndNormalize.mockResolvedValue({
      verifiedContentType: "image/jpeg",
      byteLength: ORIGINAL.byteLength,
      sha256: "a".repeat(64),
      originalBytes: ORIGINAL,
      normalized: { bytes: NORMALIZED, contentType: "image/jpeg" },
    });
  });

  it("stores immutable original and derivative while returning metadata only", async () => {
    const staged = await stageExpenseReceiptEvidence({
      captureId: CAPTURE_ID,
      submittedBy: MEMBER_ID,
      receipt: {
        filename: "receipt.jpg",
        contentType: "image/jpeg",
        bytes: ORIGINAL,
        sha256: "a".repeat(64),
        byteLength: ORIGINAL.byteLength,
      },
      now: new Date("2026-08-27T12:00:00.000Z"),
    });

    expect(mockPutImmutableMediaObject).toHaveBeenCalledTimes(2);
    expect(mockPutImmutableMediaObject).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ body: ORIGINAL, contentType: "image/jpeg" }),
    );
    expect(mockPutImmutableMediaObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: NORMALIZED,
        contentType: "image/jpeg",
      }),
    );
    expect(staged.capture).toEqual(
      expect.objectContaining({
        id: CAPTURE_ID,
        submittedBy: MEMBER_ID,
        status: "confirmed",
        storageProvider: "r2",
        sha256: "a".repeat(64),
      }),
    );
    expect(JSON.stringify(staged.capture)).not.toContain("data:");
    expect(JSON.stringify(staged.capture)).not.toContain("bytes");
  });

  it("removes every staged object when verification or commit fails", async () => {
    const staged = await stageReceiptEvidence();

    await cleanupStagedExpenseReceiptEvidence(staged);

    expect(mockDeleteMediaObject).toHaveBeenCalledTimes(2);
    expect(mockDeleteMediaObject.mock.calls.map(([key]) => key)).toEqual([
      expect.stringContaining("normalized.jpg"),
      expect.stringContaining("original.jpg"),
    ]);
  });

  it("cleans only the newly created original if immutable derivative verification fails", async () => {
    mockPutImmutableMediaObject
      .mockResolvedValueOnce("created")
      .mockRejectedValueOnce(new Error("media_immutable_object_conflict"));

    await expect(
      stageExpenseReceiptEvidence({
        captureId: CAPTURE_ID,
        submittedBy: MEMBER_ID,
        receipt: {
          filename: "receipt.jpg",
          contentType: "image/jpeg",
          bytes: ORIGINAL,
          sha256: "a".repeat(64),
          byteLength: ORIGINAL.byteLength,
        },
      }),
    ).rejects.toThrow("media_immutable_object_conflict");
    expect(mockDeleteMediaObject).toHaveBeenCalledTimes(1);
    expect(mockDeleteMediaObject).toHaveBeenCalledWith(
      expect.stringContaining("original.jpg"),
    );
  });

  it("deletes staged evidence only after a primary read proves the row is absent", async () => {
    const staged = await stageReceiptEvidence();
    mockDeleteMediaObject.mockClear();

    await expect(
      cleanupStagedExpenseReceiptEvidenceIfUncommitted(
        makeCaptureLookupDb([]),
        staged,
      ),
    ).resolves.toBe("cleaned");

    expect(mockDeleteMediaObject.mock.calls.map(([key]) => key)).toEqual([
      expect.stringContaining("normalized.jpg"),
      expect.stringContaining("original.jpg"),
    ]);
  });

  it("retains staged evidence when the capture row committed", async () => {
    const staged = await stageReceiptEvidence();
    mockDeleteMediaObject.mockClear();

    await expect(
      cleanupStagedExpenseReceiptEvidenceIfUncommitted(
        makeCaptureLookupDb([{ id: CAPTURE_ID }]),
        staged,
      ),
    ).resolves.toBe("retained_committed");

    expect(mockDeleteMediaObject).not.toHaveBeenCalled();
  });

  it("retains staged evidence when the commit verification read fails", async () => {
    const staged = await stageReceiptEvidence();
    mockDeleteMediaObject.mockClear();

    await expect(
      cleanupStagedExpenseReceiptEvidenceIfUncommitted(
        makeCaptureLookupDb(new Error("primary database unavailable")),
        staged,
      ),
    ).resolves.toBe("retained_unverified");

    expect(mockDeleteMediaObject).not.toHaveBeenCalled();
  });
});
