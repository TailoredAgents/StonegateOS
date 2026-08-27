import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  buildExpenseReceiptObjectKeys,
  detectExpenseReceiptUploadContentType,
  expenseReceiptContentTypesMatch,
  ExpenseReceiptUploadIntentSchema,
  MAX_EXPENSE_RECEIPT_UPLOAD_BYTES,
  sanitizeExpenseReceiptFilename,
  verifyAndNormalizeExpenseReceiptUpload,
} from "@/lib/expense-receipt-storage";

const MEMBER_ID = "10000000-0000-4000-8000-000000000001";
const CAPTURE_ID = "20000000-0000-4000-8000-000000000002";

describe("expense receipt private-upload policy", () => {
  it("accepts only bounded verified receipt declarations", () => {
    expect(
      ExpenseReceiptUploadIntentSchema.parse({
        clientCaptureId: CAPTURE_ID,
        filename: "fuel.jpg",
        contentType: "IMAGE/JPEG; charset=binary",
        byteLength: 2_048,
        checksumSha256: "A".repeat(64),
      }),
    ).toMatchObject({
      contentType: "image/jpeg",
      checksumSha256: "a".repeat(64),
    });
    expect(
      ExpenseReceiptUploadIntentSchema.safeParse({
        clientCaptureId: CAPTURE_ID,
        filename: "receipt.svg",
        contentType: "image/svg+xml",
        byteLength: 200,
      }).success,
    ).toBe(false);
    expect(
      ExpenseReceiptUploadIntentSchema.safeParse({
        clientCaptureId: CAPTURE_ID,
        filename: "large.pdf",
        contentType: "application/pdf",
        byteLength: MAX_EXPENSE_RECEIPT_UPLOAD_BYTES + 1,
      }).success,
    ).toBe(false);
  });

  it("uses employee- and capture-scoped keys without filename PII", () => {
    const keys = buildExpenseReceiptObjectKeys({
      memberId: MEMBER_ID,
      captureId: CAPTURE_ID,
      contentType: "image/heic",
    });
    expect(keys).toEqual({
      originalObjectKey: `expenses/receipts/${MEMBER_ID}/${CAPTURE_ID}/original.heic`,
      normalizedObjectKey: `expenses/receipts/${MEMBER_ID}/${CAPTURE_ID}/normalized.jpg`,
    });
    expect(JSON.stringify(keys)).not.toContain("vendor");
  });

  it("sanitizes traversal and control characters from evidence labels", () => {
    expect(sanitizeExpenseReceiptFilename("../Fuel\u0000 Receipt.pdf")).toBe(
      "Fuel Receipt.pdf",
    );
    expect(sanitizeExpenseReceiptFilename("C:\\fakepath\\scan.jpg")).toBe(
      "scan.jpg",
    );
  });

  it("detects PDF and HEIC containers from bytes and permits HEIC-family MIME aliases", () => {
    expect(
      detectExpenseReceiptUploadContentType(
        Buffer.from("%PDF-1.7\nreceipt", "ascii"),
      ),
    ).toBe("application/pdf");
    const heic = Buffer.alloc(24);
    heic.writeUInt32BE(24, 0);
    heic.write("ftyp", 4, "ascii");
    heic.write("heic", 8, "ascii");
    expect(detectExpenseReceiptUploadContentType(heic)).toBe("image/heic");
    expect(expenseReceiptContentTypesMatch("image/heif", "image/heic")).toBe(
      true,
    );
    expect(expenseReceiptContentTypesMatch("image/jpeg", "image/png")).toBe(
      false,
    );
  });

  it("verifies byte count, type, and SHA-256 before creating a normalized derivative", async () => {
    const input = await sharp({
      create: {
        width: 32,
        height: 18,
        channels: 3,
        background: "#ffffff",
      },
    })
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();
    const sha256 = createHash("sha256").update(input).digest("hex");
    const verified = await verifyAndNormalizeExpenseReceiptUpload({
      bytes: input,
      declaredContentType: "image/png",
      declaredByteLength: input.byteLength,
      expectedSha256: sha256,
    });

    expect(verified.verifiedContentType).toBe("image/png");
    expect(verified.sha256).toBe(sha256);
    expect(verified.originalBytes.equals(input)).toBe(true);
    expect(verified.normalized?.contentType).toBe("image/jpeg");
    expect(verified.normalized?.bytes.byteLength).toBeGreaterThan(0);
  });

  it("rejects mismatched length, type, and digest", async () => {
    const pdf = Buffer.from("%PDF-1.7\nreceipt", "ascii");
    await expect(
      verifyAndNormalizeExpenseReceiptUpload({
        bytes: pdf,
        declaredContentType: "application/pdf",
        declaredByteLength: pdf.byteLength + 1,
      }),
    ).rejects.toThrow("receipt_upload_size_mismatch");
    await expect(
      verifyAndNormalizeExpenseReceiptUpload({
        bytes: pdf,
        declaredContentType: "image/jpeg",
        declaredByteLength: pdf.byteLength,
      }),
    ).rejects.toThrow("receipt_upload_type_mismatch");
    await expect(
      verifyAndNormalizeExpenseReceiptUpload({
        bytes: pdf,
        declaredContentType: "application/pdf",
        declaredByteLength: pdf.byteLength,
        expectedSha256: "f".repeat(64),
      }),
    ).rejects.toThrow("receipt_checksum_mismatch");
  });
});
