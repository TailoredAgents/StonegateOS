export type PortalUploadProgress = {
  loadedBytes: number;
  totalBytes: number;
  percent: number;
};

export type PortalFileUploadInput = {
  url: string;
  method: "PUT";
  headers: Readonly<Record<string, string>>;
  file: File;
  onProgress?: (progress: PortalUploadProgress) => void;
  signal?: AbortSignal;
};

const CLIENT_COMPRESSION_THRESHOLD_BYTES = 2 * 1024 * 1024;
const CLIENT_COMPRESSION_MAX_EDGE = 2_560;
const CLIENT_COMPRESSION_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type PreparedPortalImage = Readonly<{
  file: File;
  compressed: boolean;
  originalBytes: number;
}>;

export function shouldCompressPortalImage(input: {
  contentType: string;
  byteLength: number;
}): boolean {
  return (
    CLIENT_COMPRESSION_TYPES.has(input.contentType.toLowerCase()) &&
    input.byteLength >= CLIENT_COMPRESSION_THRESHOLD_BYTES
  );
}

function compressedFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/u, "").trim() || "partner-photo";
  return stem + ".webp";
}

/**
 * Best-effort in-browser re-encoding reduces large uploads and strips external
 * image metadata before transport. HEIC/HEIF and browsers without a safe
 * decoder retain the original file for the server-side verified pipeline.
 */
export async function preparePortalImageForUpload(
  source: File,
): Promise<PreparedPortalImage> {
  if (
    !shouldCompressPortalImage({
      contentType: source.type,
      byteLength: source.size,
    }) ||
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  ) {
    return { file: source, compressed: false, originalBytes: source.size };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(source, {
      imageOrientation: "from-image",
    });
    const scale = Math.min(
      1,
      CLIENT_COMPRESSION_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      return { file: source, compressed: false, originalBytes: source.size };
    }
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.84),
    );
    if (!blob || blob.size <= 0 || blob.size >= source.size) {
      return { file: source, compressed: false, originalBytes: source.size };
    }
    return {
      file: new File([blob], compressedFilename(source.name), {
        type: "image/webp",
        lastModified: source.lastModified,
      }),
      compressed: true,
      originalBytes: source.size,
    };
  } catch {
    return { file: source, compressed: false, originalBytes: source.size };
  } finally {
    bitmap?.close();
  }
}

export class PortalFileUploadError extends Error {
  readonly code:
    | "storage_upload_failed"
    | "storage_upload_network_error"
    | "storage_upload_timed_out"
    | "storage_upload_interrupted";

  constructor(code: PortalFileUploadError["code"]) {
    super(code);
    this.name = "PortalFileUploadError";
    this.code = code;
  }
}

function normalizedProgress(
  loadedBytes: number,
  totalBytes: number,
): PortalUploadProgress {
  const safeTotal = Math.max(1, totalBytes);
  const safeLoaded = Math.min(Math.max(0, loadedBytes), safeTotal);
  return {
    loadedBytes: safeLoaded,
    totalBytes: safeTotal,
    percent: Math.min(100, Math.round((safeLoaded / safeTotal) * 100)),
  };
}

/**
 * Upload directly to a short-lived private-storage intent while exposing the
 * browser's real byte progress. The caller retains its stable client ID and
 * selected File after a failure so retry can reconcile the same staged asset.
 */
export function uploadPortalFileWithProgress(
  input: PortalFileUploadInput,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finish = (
      result: "resolve" | PortalFileUploadError["code"],
    ): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abortFromSignal);
      if (result === "resolve") resolve();
      else reject(new PortalFileUploadError(result));
    };
    const abortFromSignal = (): void => request.abort();
    request.open(input.method, input.url, true);
    request.timeout = 4 * 60 * 1_000;
    for (const [name, value] of Object.entries(input.headers)) {
      request.setRequestHeader(name, value);
    }

    input.onProgress?.(normalizedProgress(0, input.file.size));
    request.upload.addEventListener("progress", (event) => {
      input.onProgress?.(
        normalizedProgress(
          event.loaded,
          event.lengthComputable && event.total > 0
            ? event.total
            : input.file.size,
        ),
      );
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        input.onProgress?.(
          normalizedProgress(input.file.size, input.file.size),
        );
        finish("resolve");
        return;
      }
      finish("storage_upload_failed");
    });
    request.addEventListener("error", () => {
      finish("storage_upload_network_error");
    });
    request.addEventListener("timeout", () => {
      finish("storage_upload_timed_out");
    });
    request.addEventListener("abort", () => {
      finish("storage_upload_interrupted");
    });
    if (input.signal?.aborted) {
      finish("storage_upload_interrupted");
      return;
    }
    input.signal?.addEventListener("abort", abortFromSignal, { once: true });
    request.send(input.file);
  });
}
