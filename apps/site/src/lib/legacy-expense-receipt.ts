const MAX_LEGACY_RECEIPT_BYTES = 10 * 1024 * 1024;
const MAX_LEGACY_RECEIPT_BASE64_LENGTH =
  Math.ceil(MAX_LEGACY_RECEIPT_BYTES / 3) * 4;

export const SAFE_EXPENSE_RECEIPT_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

function hasBytes(
  buffer: Buffer,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((value, index) => buffer[offset + index] === value);
}

function bytesMatchDeclaredType(buffer: Buffer, contentType: string): boolean {
  switch (contentType) {
    case "image/jpeg":
      return hasBytes(buffer, 0, [0xff, 0xd8, 0xff]);
    case "image/png":
      return hasBytes(
        buffer,
        0,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
    case "image/webp":
      return (
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case "image/heic":
    case "image/heif": {
      if (buffer.subarray(4, 8).toString("ascii") !== "ftyp") return false;
      const brand = buffer.subarray(8, 12).toString("ascii");
      return new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]).has(
        brand,
      );
    }
    case "application/pdf":
      return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    default:
      return false;
  }
}

/** Decode only the legacy receipt formats accepted by the V2 intake path. */
export function parseVerifiedLegacyExpenseReceipt(input: {
  dataUrl: string;
  reportedContentType?: string | null;
}): { contentType: string; buffer: Buffer } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(input.dataUrl);
  if (!match) return null;
  const contentType = (match[1] ?? "").trim().toLowerCase();
  const reportedContentType = (input.reportedContentType ?? contentType)
    .trim()
    .toLowerCase();
  const base64 = match[2] ?? "";
  if (
    reportedContentType !== contentType ||
    !SAFE_EXPENSE_RECEIPT_CONTENT_TYPES.has(contentType) ||
    base64.length === 0 ||
    base64.length > MAX_LEGACY_RECEIPT_BASE64_LENGTH ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      base64,
    )
  ) {
    return null;
  }
  const buffer = Buffer.from(base64, "base64");
  if (
    buffer.byteLength === 0 ||
    buffer.byteLength > MAX_LEGACY_RECEIPT_BYTES ||
    !bytesMatchDeclaredType(buffer, contentType)
  ) {
    return null;
  }
  return { contentType, buffer };
}

export function safeExpenseReceiptResponseHeaders(input: {
  filename: string;
  contentType: string;
}): Record<string, string> {
  const filename =
    input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "receipt";
  return {
    "Content-Type": input.contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}
