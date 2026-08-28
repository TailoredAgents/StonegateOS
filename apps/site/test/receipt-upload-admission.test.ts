import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ReceiptUploadAdmissionController,
  receiptUploadAdmissionResponse,
  receiptUploadDeclaredLength,
} from "../src/app/api/mobile/expenses/lib/receipt-upload-admission";

const uploadRoutePath = fileURLToPath(
  new URL(
    "../src/app/api/mobile/expenses/captures/[captureId]/upload/route.ts",
    import.meta.url,
  ),
);

void test("receipt upload admission joins duplicate capture pressure without consuming another slot", () => {
  const controller = new ReceiptUploadAdmissionController(1, 7);
  const first = controller.tryAcquire("capture-a");
  assert.equal(first.ok, true);

  assert.deepEqual(controller.tryAcquire("capture-a"), {
    ok: false,
    rejection: { reason: "capture_in_progress", retryAfterSeconds: 7 },
  });

  if (!first.ok) assert.fail("first capture admission must succeed");
  first.release();
  const retried = controller.tryAcquire("capture-a");
  assert.equal(retried.ok, true);
  first.release();
  assert.deepEqual(controller.tryAcquire("capture-a"), {
    ok: false,
    rejection: { reason: "capture_in_progress", retryAfterSeconds: 7 },
  });
  if (retried.ok) retried.release();
});

void test("receipt upload admission bounds distinct captures globally and releases capacity", () => {
  const controller = new ReceiptUploadAdmissionController(2, 5);
  const first = controller.tryAcquire("capture-a");
  const second = controller.tryAcquire("capture-b");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(controller.tryAcquire("capture-c"), {
    ok: false,
    rejection: { reason: "global_capacity", retryAfterSeconds: 5 },
  });

  if (!first.ok || !second.ok) assert.fail("initial admissions must succeed");
  first.release();
  const third = controller.tryAcquire("capture-c");
  assert.equal(third.ok, true);
  second.release();
  if (third.ok) third.release();
});

void test("receipt upload admission rejects invalid limits", () => {
  assert.throws(
    () => new ReceiptUploadAdmissionController(0),
    /receipt_upload_concurrency_invalid/u,
  );
  assert.throws(
    () => new ReceiptUploadAdmissionController(1, 0),
    /receipt_upload_retry_after_invalid/u,
  );
});

void test("receipt Content-Length validation rejects oversized and malformed bodies before buffering", () => {
  const maximumBytes = 10 * 1024 * 1024;
  assert.deepEqual(receiptUploadDeclaredLength(null, maximumBytes), {
    ok: true,
    byteLength: null,
  });
  assert.deepEqual(
    receiptUploadDeclaredLength(String(maximumBytes), maximumBytes),
    { ok: true, byteLength: maximumBytes },
  );
  assert.deepEqual(
    receiptUploadDeclaredLength(`000${maximumBytes}`, maximumBytes),
    { ok: true, byteLength: maximumBytes },
  );
  assert.deepEqual(
    receiptUploadDeclaredLength(String(maximumBytes + 1), maximumBytes),
    { ok: false, reason: "too_large" },
  );
  assert.deepEqual(
    receiptUploadDeclaredLength("999999999999999999999999", maximumBytes),
    { ok: false, reason: "too_large" },
  );
  for (const value of ["", "-1", "1.5", "10, 11", "ten"]) {
    assert.deepEqual(receiptUploadDeclaredLength(value, maximumBytes), {
      ok: false,
      reason: "invalid",
    });
  }
});

void test("receipt upload overload responses are bounded, private, and retryable", async () => {
  const cases = [
    {
      reason: "capture_in_progress" as const,
      expectedStatus: 409,
      expectedError: "receipt_upload_in_progress",
    },
    {
      reason: "global_capacity" as const,
      expectedStatus: 429,
      expectedError: "receipt_upload_capacity_reached",
    },
  ];

  for (const entry of cases) {
    const response = receiptUploadAdmissionResponse({
      reason: entry.reason,
      retryAfterSeconds: 4,
    });
    const bodyText = await response.text();
    assert.equal(response.status, entry.expectedStatus);
    assert.equal(response.headers.get("retry-after"), "4");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok(Buffer.byteLength(bodyText) <= 256);
    assert.deepEqual(JSON.parse(bodyText), {
      ok: false,
      error: entry.expectedError,
      message:
        entry.reason === "capture_in_progress"
          ? "This receipt upload is already in progress. Wait a moment and retry."
          : "Receipt uploads are busy. Wait a moment and retry.",
      retryable: true,
    });
  }
});

void test("receipt route acquires admission before reading any request body and always releases it", async () => {
  const source = await readFile(uploadRoutePath, "utf8");
  const handler = source.slice(source.indexOf("export async function PUT"));
  const contentLengthCheck = handler.indexOf("receiptUploadDeclaredLength(");
  const acquire = handler.indexOf("receiptUploadAdmission.tryAcquire(");
  const bodyRead = handler.indexOf("readMobileExpenseBody(");
  const release = handler.indexOf("finally {\n    admission.release();");

  assert.ok(contentLengthCheck >= 0);
  assert.ok(acquire > contentLengthCheck);
  assert.ok(bodyRead > acquire);
  assert.ok(release > bodyRead);
});
