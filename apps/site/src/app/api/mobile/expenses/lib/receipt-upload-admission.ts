export const RECEIPT_UPLOAD_RETRY_AFTER_SECONDS = 3;

export type ReceiptUploadAdmissionRejection =
  | { reason: "capture_in_progress"; retryAfterSeconds: number }
  | { reason: "global_capacity"; retryAfterSeconds: number };

export type ReceiptUploadAdmission =
  | {
      ok: true;
      release: () => void;
    }
  | {
      ok: false;
      rejection: ReceiptUploadAdmissionRejection;
    };

/**
 * Process-local admission control for the receipt proxy's buffered uploads.
 * The API's capture idempotency remains authoritative across processes; this
 * controller bounds memory and duplicate work within each site instance.
 */
export class ReceiptUploadAdmissionController {
  readonly #activeCaptureIds = new Set<string>();
  readonly #maximumConcurrentUploads: number;
  readonly #retryAfterSeconds: number;

  constructor(
    maximumConcurrentUploads: number,
    retryAfterSeconds = RECEIPT_UPLOAD_RETRY_AFTER_SECONDS,
  ) {
    if (
      !Number.isSafeInteger(maximumConcurrentUploads) ||
      maximumConcurrentUploads < 1
    ) {
      throw new Error("receipt_upload_concurrency_invalid");
    }
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
      throw new Error("receipt_upload_retry_after_invalid");
    }
    this.#maximumConcurrentUploads = maximumConcurrentUploads;
    this.#retryAfterSeconds = retryAfterSeconds;
  }

  tryAcquire(captureId: string): ReceiptUploadAdmission {
    if (this.#activeCaptureIds.has(captureId)) {
      return {
        ok: false,
        rejection: {
          reason: "capture_in_progress",
          retryAfterSeconds: this.#retryAfterSeconds,
        },
      };
    }
    if (this.#activeCaptureIds.size >= this.#maximumConcurrentUploads) {
      return {
        ok: false,
        rejection: {
          reason: "global_capacity",
          retryAfterSeconds: this.#retryAfterSeconds,
        },
      };
    }

    this.#activeCaptureIds.add(captureId);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.#activeCaptureIds.delete(captureId);
      },
    };
  }
}

export type ReceiptUploadDeclaredLength =
  | { ok: true; byteLength: number | null }
  | { ok: false; reason: "invalid" | "too_large" };

export function receiptUploadDeclaredLength(
  headerValue: string | null,
  maximumBytes: number,
): ReceiptUploadDeclaredLength {
  if (headerValue === null) return { ok: true, byteLength: null };
  const value = headerValue.trim();
  if (!/^\d+$/u.test(value)) return { ok: false, reason: "invalid" };

  const normalized = value.replace(/^0+(?=\d)/u, "");
  const maximum = String(maximumBytes);
  if (
    normalized.length > maximum.length ||
    (normalized.length === maximum.length && normalized > maximum)
  ) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, byteLength: Number(normalized) };
}

export function receiptUploadAdmissionResponse(
  rejection: ReceiptUploadAdmissionRejection,
): Response {
  const captureBusy = rejection.reason === "capture_in_progress";
  return Response.json(
    {
      ok: false,
      error: captureBusy
        ? "receipt_upload_in_progress"
        : "receipt_upload_capacity_reached",
      message: captureBusy
        ? "This receipt upload is already in progress. Wait a moment and retry."
        : "Receipt uploads are busy. Wait a moment and retry.",
      retryable: true,
    },
    {
      status: captureBusy ? 409 : 429,
      headers: {
        "Cache-Control": "private, no-store",
        "Retry-After": String(rejection.retryAfterSeconds),
      },
    },
  );
}

export const receiptUploadAdmission = new ReceiptUploadAdmissionController(4);
