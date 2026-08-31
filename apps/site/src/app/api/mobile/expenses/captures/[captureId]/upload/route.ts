import { createHash } from "node:crypto";
import { callAdminApiForCurrentSession } from "@/app/team/lib/api";
import {
  encodeExpenseRouteId,
  readMobileExpenseBody,
  requireMobileExpenseSession,
} from "@/app/api/mobile/expenses/lib/expense-proxy";
import {
  receiptUploadAdmission,
  receiptUploadAdmissionResponse,
  receiptUploadDeclaredLength,
} from "@/app/api/mobile/expenses/lib/receipt-upload-admission";
import { buildReceiptStorageUploadHeaders } from "@/app/api/mobile/expenses/lib/receipt-upload-headers";

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

type RouteContext = { params: Promise<{ captureId: string }> };

function failure(status: number, error: string, message: string): Response {
  return Response.json(
    { ok: false, error, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const access = await requireMobileExpenseSession("expenses.submit");
  if (!access.ok) return access.response;

  const contentEncoding = request.headers
    .get("content-encoding")
    ?.toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    return failure(
      415,
      "content_encoding_not_supported",
      "Upload the receipt without content encoding.",
    );
  }
  const contentType =
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
    "";
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return failure(
      415,
      "receipt_type_unsupported",
      "Use a JPEG, PNG, WebP, HEIC, or PDF receipt.",
    );
  }
  const declaredLength = receiptUploadDeclaredLength(
    request.headers.get("content-length"),
    MAX_RECEIPT_BYTES,
  );
  if (!declaredLength.ok) {
    return failure(
      declaredLength.reason === "too_large" ? 413 : 400,
      declaredLength.reason === "too_large"
        ? "receipt_too_large"
        : "invalid_content_length",
      declaredLength.reason === "too_large"
        ? "Receipts must be 10 MB or smaller."
        : "The receipt size header is invalid.",
    );
  }

  const { captureId } = await context.params;
  const admission = receiptUploadAdmission.tryAcquire(captureId);
  if (!admission.ok) {
    return receiptUploadAdmissionResponse(admission.rejection);
  }
  const encodedCaptureId = encodeExpenseRouteId(captureId);
  try {
    const bytes = await readMobileExpenseBody(request, MAX_RECEIPT_BYTES);
    if (!bytes?.byteLength) {
      return failure(
        bytes === null ? 413 : 400,
        bytes === null ? "receipt_too_large" : "empty_receipt",
        bytes === null
          ? "Receipts must be 10 MB or smaller."
          : "Choose a receipt to upload.",
      );
    }

    const statusResponse = await callAdminApiForCurrentSession(
      `/api/admin/expenses/captures/${encodedCaptureId}`,
      { method: "GET" },
    );
    const statusPayload = objectValue(
      await statusResponse.json().catch(() => null),
    );
    if (!statusResponse.ok) {
      return Response.json(statusPayload ?? { error: "capture_not_found" }, {
        status: statusResponse.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const capture = objectValue(statusPayload?.["capture"]);
    const filename =
      typeof capture?.["filename"] === "string" ? capture["filename"] : "";
    const expectedType =
      typeof capture?.["contentType"] === "string"
        ? capture["contentType"].toLowerCase()
        : "";
    const expectedLength =
      typeof capture?.["byteLength"] === "number"
        ? capture["byteLength"]
        : null;
    if (
      capture?.["id"] !== captureId ||
      capture["status"] !== "pending_upload" ||
      !filename ||
      expectedType !== contentType ||
      expectedLength !== bytes.byteLength
    ) {
      return failure(
        409,
        "receipt_upload_mismatch",
        "This receipt no longer matches its upload request. Start a new scan.",
      );
    }

    const checksumSha256 = createHash("sha256")
      .update(new Uint8Array(bytes))
      .digest("hex");
    const expectedChecksum =
      typeof capture["sha256"] === "string"
        ? capture["sha256"].toLowerCase()
        : null;
    if (expectedChecksum && expectedChecksum !== checksumSha256) {
      return failure(
        409,
        "receipt_checksum_mismatch",
        "The saved receipt bytes changed. Start a new scan.",
      );
    }

    const intentResponse = await callAdminApiForCurrentSession(
      "/api/admin/expenses/captures",
      {
        method: "POST",
        body: JSON.stringify({
          clientCaptureId: captureId,
          filename,
          contentType,
          byteLength: bytes.byteLength,
          checksumSha256,
        }),
      },
    );
    const intentPayload = objectValue(
      await intentResponse.json().catch(() => null),
    );
    if (!intentResponse.ok) {
      return Response.json(intentPayload ?? { error: "upload_intent_failed" }, {
        status: intentResponse.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const uploadUrl =
      typeof intentPayload?.["uploadUrl"] === "string"
        ? intentPayload["uploadUrl"]
        : null;
    const uploadHeaders = objectValue(intentPayload?.["uploadHeaders"]);
    if (!uploadUrl) {
      return failure(
        409,
        "receipt_upload_not_pending",
        "This receipt has already moved past upload. Refresh its status.",
      );
    }
    const parsedUploadUrl = new URL(uploadUrl);
    if (
      parsedUploadUrl.protocol !== "https:" &&
      parsedUploadUrl.protocol !== "http:"
    ) {
      return failure(
        502,
        "receipt_storage_url_invalid",
        "Receipt storage returned an invalid upload location.",
      );
    }

    const storageResponse = await fetch(parsedUploadUrl, {
      method: "PUT",
      headers: buildReceiptStorageUploadHeaders(contentType, uploadHeaders),
      body: bytes,
      redirect: "error",
    });
    // Write-once receipt URLs return 412 when a retry reaches an object that
    // was already uploaded. Treat that as transport success; finalization
    // performs the authoritative byte-length, MIME, and SHA-256 verification.
    if (!storageResponse.ok && storageResponse.status !== 412) {
      return failure(
        storageResponse.status >= 500 ? 502 : 409,
        "receipt_storage_upload_failed",
        "The receipt could not be uploaded. It remains queued on this device.",
      );
    }
    return Response.json(
      { ok: true, captureId, checksumSha256, byteLength: bytes.byteLength },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return failure(
      timedOut ? 504 : 502,
      timedOut ? "receipt_upload_timeout" : "receipt_upload_unavailable",
      "The receipt remains queued on this device and will retry.",
    );
  } finally {
    admission.release();
  }
}
