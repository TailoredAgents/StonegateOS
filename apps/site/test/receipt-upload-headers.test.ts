import assert from "node:assert/strict";
import test from "node:test";
import { buildReceiptStorageUploadHeaders } from "../src/app/api/mobile/expenses/lib/receipt-upload-headers";

void test("receipt storage upload headers keep one canonical content type", () => {
  const headers = buildReceiptStorageUploadHeaders("image/jpeg", {
    "Content-Type": "application/octet-stream",
    "content-type": "image/png",
    "CONTENT-TYPE": "image/webp",
    "if-none-match": "*",
    "x-amz-checksum-sha256": "signed-checksum",
    ignored: 123,
  });

  assert.equal(headers.get("content-type"), "image/jpeg");
  let contentTypeCount = 0;
  headers.forEach((_value, name) => {
    if (name === "content-type") contentTypeCount += 1;
  });
  assert.equal(contentTypeCount, 1);
  assert.equal(headers.get("if-none-match"), "*");
  assert.equal(headers.get("x-amz-checksum-sha256"), "signed-checksum");
  assert.equal(headers.has("ignored"), false);
});
