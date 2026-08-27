import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVerifiedLegacyExpenseReceipt,
  safeExpenseReceiptResponseHeaders,
} from "../src/lib/legacy-expense-receipt";

function dataUrl(contentType: string, bytes: Buffer): string {
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

void test("accepts a bounded legacy receipt only when MIME and magic bytes agree", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  assert.deepEqual(
    parseVerifiedLegacyExpenseReceipt({
      dataUrl: dataUrl("image/jpeg", jpeg),
      reportedContentType: "image/jpeg",
    }),
    { contentType: "image/jpeg", buffer: jpeg },
  );

  assert.equal(
    parseVerifiedLegacyExpenseReceipt({
      dataUrl: dataUrl("image/jpeg", Buffer.from("<html>active</html>")),
      reportedContentType: "image/jpeg",
    }),
    null,
  );
  assert.equal(
    parseVerifiedLegacyExpenseReceipt({
      dataUrl: dataUrl("image/jpeg", jpeg),
      reportedContentType: "application/pdf",
    }),
    null,
  );
});

void test("rejects active, malformed, and empty legacy data URLs", () => {
  assert.equal(
    parseVerifiedLegacyExpenseReceipt({
      dataUrl: dataUrl("text/html", Buffer.from("<script></script>")),
      reportedContentType: "text/html",
    }),
    null,
  );
  assert.equal(
    parseVerifiedLegacyExpenseReceipt({
      dataUrl: "data:image/png;base64,not base64!",
      reportedContentType: "image/png",
    }),
    null,
  );
  assert.equal(
    parseVerifiedLegacyExpenseReceipt({
      dataUrl: "data:application/pdf;base64,",
      reportedContentType: "application/pdf",
    }),
    null,
  );
});

void test("legacy responses are attachment-only, sandboxed, and never cached", () => {
  const headers = safeExpenseReceiptResponseHeaders({
    filename: 'receipt".pdf',
    contentType: "application/pdf",
  });
  assert.equal(headers["Content-Type"], "application/pdf");
  assert.equal(
    headers["Content-Disposition"],
    'attachment; filename="receipt_.pdf"',
  );
  assert.equal(headers["Cache-Control"], "private, no-store");
  assert.match(headers["Content-Security-Policy"] ?? "", /sandbox/u);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
});
