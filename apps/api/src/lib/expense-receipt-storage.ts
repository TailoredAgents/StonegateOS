import { createHash } from "node:crypto";
import { z } from "zod";
import {
  detectAppointmentImageType,
  normalizeAppointmentImage,
} from "@/lib/appointment-image";

export const MAX_EXPENSE_RECEIPT_UPLOAD_BYTES = 10 * 1024 * 1024;

export const EXPENSE_RECEIPT_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

export type ExpenseReceiptContentType =
  (typeof EXPENSE_RECEIPT_CONTENT_TYPES)[number];

const CONTENT_TYPE_SET = new Set<string>(EXPENSE_RECEIPT_CONTENT_TYPES);
const SHA_256_PATTERN = /^[a-f0-9]{64}$/iu;
const declaredContentTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .transform((value) => value.split(";")[0]?.trim().toLowerCase() ?? "")
  .refine((value) => CONTENT_TYPE_SET.has(value), {
    message: "Use a JPEG, PNG, WebP, HEIC, or PDF receipt.",
  })
  .transform((value) => value as ExpenseReceiptContentType);

export const ExpenseReceiptUploadIntentSchema = z
  .object({
    clientCaptureId: z.string().uuid(),
    filename: z.string().trim().min(1).max(240),
    contentType: declaredContentTypeSchema,
    byteLength: z.number().int().min(1).max(MAX_EXPENSE_RECEIPT_UPLOAD_BYTES),
    checksumSha256: z.string().regex(SHA_256_PATTERN).nullish(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    checksumSha256: value.checksumSha256?.toLowerCase() ?? null,
  }));

export type ExpenseReceiptUploadIntentInput = z.input<
  typeof ExpenseReceiptUploadIntentSchema
>;
export type ValidatedExpenseReceiptUploadIntent = z.output<
  typeof ExpenseReceiptUploadIntentSchema
>;

export function sanitizeExpenseReceiptFilename(value: string): string {
  const basename = value.normalize("NFKC").split(/[\\/]/u).pop() ?? "receipt";
  const safe = [...basename]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return (safe || "receipt").slice(0, 240);
}

export function normalizeDeclaredExpenseReceiptContentType(
  value: string,
): ExpenseReceiptContentType {
  const normalized = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!CONTENT_TYPE_SET.has(normalized)) {
    throw new Error("receipt_content_type_unsupported");
  }
  return normalized as ExpenseReceiptContentType;
}

function isPdf(bytes: Buffer): boolean {
  return (
    bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-"
  );
}

export function detectExpenseReceiptUploadContentType(
  bytes: Buffer,
): ExpenseReceiptContentType | null {
  if (isPdf(bytes)) return "application/pdf";
  return detectAppointmentImageType(bytes);
}

function isHeicFamily(contentType: string): boolean {
  return contentType === "image/heic" || contentType === "image/heif";
}

export function expenseReceiptContentTypesMatch(
  declared: ExpenseReceiptContentType,
  verified: ExpenseReceiptContentType,
): boolean {
  return (
    declared === verified || (isHeicFamily(declared) && isHeicFamily(verified))
  );
}

export function buildExpenseReceiptObjectKeys(input: {
  memberId: string;
  captureId: string;
  contentType: ExpenseReceiptContentType;
}): { originalObjectKey: string; normalizedObjectKey: string | null } {
  if (!z.string().uuid().safeParse(input.memberId).success) {
    throw new Error("receipt_member_id_invalid");
  }
  if (!z.string().uuid().safeParse(input.captureId).success) {
    throw new Error("receipt_capture_id_invalid");
  }
  const extension =
    input.contentType === "application/pdf"
      ? "pdf"
      : input.contentType === "image/png"
        ? "png"
        : input.contentType === "image/webp"
          ? "webp"
          : isHeicFamily(input.contentType)
            ? "heic"
            : "jpg";
  const prefix = `expenses/receipts/${input.memberId}/${input.captureId}`;
  return {
    originalObjectKey: `${prefix}/original.${extension}`,
    normalizedObjectKey:
      input.contentType === "application/pdf"
        ? null
        : `${prefix}/normalized.jpg`,
  };
}

export type VerifiedExpenseReceiptUpload = {
  verifiedContentType: ExpenseReceiptContentType;
  byteLength: number;
  sha256: string;
  originalBytes: Buffer;
  normalized: {
    bytes: Buffer;
    contentType: "image/jpeg";
  } | null;
};

/**
 * Verifies the actual upload rather than trusting its extension, browser MIME,
 * declared byte count, or client digest. Images are also normalized for model
 * input while the immutable original bytes remain untouched.
 */
export async function verifyAndNormalizeExpenseReceiptUpload(input: {
  bytes: Buffer;
  declaredContentType: ExpenseReceiptContentType;
  declaredByteLength: number;
  expectedSha256?: string | null;
}): Promise<VerifiedExpenseReceiptUpload> {
  if (
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > MAX_EXPENSE_RECEIPT_UPLOAD_BYTES
  ) {
    throw new Error("receipt_upload_size_invalid");
  }
  if (input.bytes.byteLength !== input.declaredByteLength) {
    throw new Error("receipt_upload_size_mismatch");
  }

  const verifiedContentType = detectExpenseReceiptUploadContentType(
    input.bytes,
  );
  if (!verifiedContentType) {
    throw new Error("receipt_upload_type_unverified");
  }
  if (
    !expenseReceiptContentTypesMatch(
      input.declaredContentType,
      verifiedContentType,
    )
  ) {
    throw new Error("receipt_upload_type_mismatch");
  }

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const expectedSha256 = input.expectedSha256?.trim().toLowerCase() ?? null;
  if (expectedSha256 && !SHA_256_PATTERN.test(expectedSha256)) {
    throw new Error("receipt_checksum_invalid");
  }
  if (expectedSha256 && expectedSha256 !== sha256) {
    throw new Error("receipt_checksum_mismatch");
  }

  const normalized =
    verifiedContentType === "application/pdf"
      ? null
      : await normalizeAppointmentImage(input.bytes, verifiedContentType).then(
          (image) => ({
            // The untouched upload remains the evidence object. The bounded
            // display derivative is sufficient for extraction and avoids
            // sending an unnecessarily large camera original to the model.
            bytes: image.display,
            contentType: image.contentType,
          }),
        );

  return {
    verifiedContentType,
    byteLength: input.bytes.byteLength,
    sha256,
    originalBytes: input.bytes,
    normalized,
  };
}
