import {
  MAX_QUOTE_ATTACHMENT_BYTES,
  detectQuoteAttachmentMediaType,
  normalizeQuoteAttachmentPurpose,
  quoteAttachmentContentDisposition,
  validateQuoteAttachment,
  validateQuoteAttachmentSet,
} from "@/lib/quote-v2-attachments";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("quote V2 attachments", () => {
  it("detects every allowed format from file signatures", () => {
    expect(detectQuoteAttachmentMediaType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(
      "image/jpeg",
    );
    expect(
      detectQuoteAttachmentMediaType(
        bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      ),
    ).toBe("image/png");
    expect(detectQuoteAttachmentMediaType(text("RIFF0000WEBP"))).toBe(
      "image/webp",
    );
    expect(detectQuoteAttachmentMediaType(text("%PDF-1.7"))).toBe(
      "application/pdf",
    );
    expect(
      detectQuoteAttachmentMediaType(bytes(0, 0, 0, 24, ...text("ftypheic"))),
    ).toBe("image/heic");
  });

  it("rejects spoofed MIME types, oversized files, and more than ten files", () => {
    expect(() =>
      validateQuoteAttachment({
        fileName: "spoofed.jpg",
        claimedMediaType: "image/jpeg",
        byteSize: 100,
        signature: text("%PDF-1.7"),
      }),
    ).toThrow("does not match");
    expect(() =>
      validateQuoteAttachment({
        fileName: "large.pdf",
        claimedMediaType: "application/pdf",
        byteSize: MAX_QUOTE_ATTACHMENT_BYTES + 1,
        signature: text("%PDF-1.7"),
      }),
    ).toThrow("10 MB");
    expect(() =>
      validateQuoteAttachmentSet(
        Array.from({ length: 11 }, (_, index) => ({
          fileName: `${index}.pdf`,
          claimedMediaType: "application/pdf",
          byteSize: 100,
          signature: text("%PDF-1.7"),
        })),
      ),
    ).toThrow("up to 10");
  });

  it("sanitizes attachment download names", () => {
    expect(quoteAttachmentContentDisposition('../proposal\r\n".pdf')).toBe(
      'attachment; filename=".._proposal___.pdf"',
    );
  });

  it("keeps internal evidence structurally customer-invisible", () => {
    expect(
      normalizeQuoteAttachmentPurpose({
        purpose: "scope_evidence",
        customerVisible: true,
      }),
    ).toBe("scope_evidence");
    expect(() =>
      normalizeQuoteAttachmentPurpose({
        purpose: "internal",
        customerVisible: true,
      }),
    ).toThrow("cannot be customer-visible");
    expect(
      normalizeQuoteAttachmentPurpose({
        purpose: "internal",
        customerVisible: false,
      }),
    ).toBe("internal");
  });
});
