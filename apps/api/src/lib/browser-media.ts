const DEFAULT_MAX_BROWSER_MEDIA_BYTES = 10 * 1024 * 1024;

export class BrowserMediaError extends Error {
  constructor(
    readonly code:
      | "media_response_missing"
      | "media_length_invalid"
      | "media_too_large"
      | "media_read_failed",
    readonly status: 413 | 502,
  ) {
    super(code);
    this.name = "BrowserMediaError";
  }
}

function normalizedDeclaredType(value: string | null): string {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export function detectSafeInlineMediaType(
  bytes: Uint8Array,
):
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "image/avif"
  | "video/mp4"
  | "video/webm"
  | null {
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
    ascii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 6 &&
    (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    return "video/mp4";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  return null;
}

export async function readBoundedBrowserMedia(
  response: Response,
  maximumBytes = DEFAULT_MAX_BROWSER_MEDIA_BYTES,
): Promise<Uint8Array> {
  if (
    !Number.isInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > DEFAULT_MAX_BROWSER_MEDIA_BYTES
  ) {
    throw new BrowserMediaError("media_length_invalid", 502);
  }
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const declaredLength = Number(rawLength);
    if (!Number.isInteger(declaredLength) || declaredLength < 0) {
      await response.body?.cancel().catch(() => undefined);
      throw new BrowserMediaError("media_length_invalid", 502);
    }
    if (declaredLength > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new BrowserMediaError("media_too_large", 413);
    }
  }
  if (!response.body) {
    throw new BrowserMediaError("media_response_missing", 502);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BrowserMediaError("media_too_large", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BrowserMediaError) throw error;
    throw new BrowserMediaError("media_read_failed", 502);
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new BrowserMediaError("media_response_missing", 502);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function sanitizeMediaFilename(
  value: string | null | undefined,
  fallback = "media.bin",
): string {
  const leaf = (value ?? "").split(/[\\/]/u).at(-1) ?? "";
  const normalized = leaf
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 80);
  return normalized || fallback;
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    default:
      return "bin";
  }
}

export function buildSafeBrowserMediaResponse(input: {
  bytes: Uint8Array;
  declaredContentType: string | null;
  filename?: string | null;
  headOnly?: boolean;
}): Response {
  const detected = detectSafeInlineMediaType(input.bytes);
  const declared = normalizedDeclaredType(input.declaredContentType);
  const inline = detected !== null && declared === detected;
  const contentType = inline ? detected : "application/octet-stream";
  const filename = inline
    ? sanitizeMediaFilename(
        input.filename,
        `media.${extensionFor(contentType)}`,
      )
    : "media.bin";
  const disposition = inline ? "inline" : "attachment";
  const body = input.headOnly ? null : Uint8Array.from(input.bytes).buffer;
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "private, max-age=60",
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Content-Length": String(input.bytes.byteLength),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": contentType,
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
