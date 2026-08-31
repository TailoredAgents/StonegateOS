export const MAX_QUOTE_ATTACHMENTS = 10;
export const MAX_QUOTE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const QUOTE_ATTACHMENT_PURPOSES = [
  "scope_evidence",
  "site_plan",
  "specification",
  "terms",
  "other",
  "internal",
] as const;

export type QuoteAttachmentPurpose = (typeof QUOTE_ATTACHMENT_PURPOSES)[number];

export type QuoteAttachmentMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "application/pdf";

export type QuoteAttachmentCandidate = {
  fileName: string;
  claimedMediaType: string;
  byteSize: number;
  signature: Uint8Array;
};

export class QuoteAttachmentError extends Error {
  readonly code:
    | "too_many_files"
    | "file_too_large"
    | "unsupported_type"
    | "signature_mismatch";

  constructor(code: QuoteAttachmentError["code"], message: string) {
    super(message);
    this.name = "QuoteAttachmentError";
    this.code = code;
  }
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

export function detectQuoteAttachmentMediaType(
  bytes: Uint8Array,
): QuoteAttachmentMediaType | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-") {
    return "application/pdf";
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
  }
  return null;
}

export function validateQuoteAttachment(
  candidate: QuoteAttachmentCandidate,
): QuoteAttachmentMediaType {
  if (
    candidate.byteSize < 1 ||
    candidate.byteSize > MAX_QUOTE_ATTACHMENT_BYTES
  ) {
    throw new QuoteAttachmentError(
      "file_too_large",
      `${candidate.fileName} must be no larger than 10 MB.`,
    );
  }
  const supported = new Set<QuoteAttachmentMediaType>([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "application/pdf",
  ]);
  if (!supported.has(candidate.claimedMediaType as QuoteAttachmentMediaType)) {
    throw new QuoteAttachmentError(
      "unsupported_type",
      `${candidate.fileName} must be a JPEG, PNG, WebP, HEIC, or PDF.`,
    );
  }
  const detected = detectQuoteAttachmentMediaType(candidate.signature);
  if (detected !== candidate.claimedMediaType) {
    throw new QuoteAttachmentError(
      "signature_mismatch",
      `${candidate.fileName} does not match its declared file type.`,
    );
  }
  return detected;
}

export function validateQuoteAttachmentSet(
  candidates: readonly QuoteAttachmentCandidate[],
): QuoteAttachmentMediaType[] {
  if (candidates.length > MAX_QUOTE_ATTACHMENTS) {
    throw new QuoteAttachmentError(
      "too_many_files",
      "A proposal can include up to 10 attachments.",
    );
  }
  return candidates.map(validateQuoteAttachment);
}

export function quoteAttachmentContentDisposition(fileName: string): string {
  const safeName =
    Array.from(fileName.normalize("NFKC"), (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f ||
        codePoint === 0x7f ||
        character === '"' ||
        character === "\\" ||
        character === "/"
        ? "_"
        : character;
    })
      .join("")
      .trim()
      .slice(0, 180) || "proposal-attachment";
  return `attachment; filename="${safeName}"`;
}

export function normalizeQuoteAttachmentPurpose(input: {
  purpose: string;
  customerVisible: boolean;
}): QuoteAttachmentPurpose {
  if (
    !QUOTE_ATTACHMENT_PURPOSES.includes(input.purpose as QuoteAttachmentPurpose)
  ) {
    throw new QuoteAttachmentError(
      "unsupported_type",
      "Choose a supported proposal attachment purpose.",
    );
  }
  if (input.purpose === "internal" && input.customerVisible) {
    throw new QuoteAttachmentError(
      "unsupported_type",
      "Internal attachments cannot be customer-visible.",
    );
  }
  return input.purpose as QuoteAttachmentPurpose;
}
