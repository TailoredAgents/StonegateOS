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
};

export class PortalFileUploadError extends Error {
  readonly code:
    | "storage_upload_failed"
    | "storage_upload_network_error"
    | "storage_upload_timed_out";

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
        resolve();
        return;
      }
      reject(new PortalFileUploadError("storage_upload_failed"));
    });
    request.addEventListener("error", () => {
      reject(new PortalFileUploadError("storage_upload_network_error"));
    });
    request.addEventListener("timeout", () => {
      reject(new PortalFileUploadError("storage_upload_timed_out"));
    });
    request.send(input.file);
  });
}
