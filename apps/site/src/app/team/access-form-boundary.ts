const URL_ENCODED_CONTENT_TYPE_PATTERN =
  /^application\/x-www-form-urlencoded(?:\s*;|$)/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

export const ACCESS_FORM_MAXIMUM_BYTES = 32 * 1024;
export const ACCESS_FORM_DEADLINE_MS = 5_000;

export function isSameOriginAccessFormRequest(request: Request): boolean {
  const rawOrigin = request.headers.get("origin")?.trim() ?? "";
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (!rawOrigin || rawOrigin === "null") return false;
  if (fetchSite && fetchSite !== "same-origin") return false;

  try {
    const origin = new URL(rawOrigin);
    const target = new URL(request.url);
    return (
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash &&
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.origin.toLowerCase() === target.origin.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function isAccessIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value.normalize("NFKC").trim());
}

export function singleAccessFormValue(
  form: URLSearchParams,
  key: string,
): string | null {
  const values = form.getAll(key);
  return values.length === 1 ? (values[0] ?? null) : null;
}

export async function readBoundedAccessForm(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  options: { maximumBytes?: number; deadlineMs?: number } = {},
): Promise<URLSearchParams | null> {
  const maximumBytes = options.maximumBytes ?? ACCESS_FORM_MAXIMUM_BYTES;
  const deadlineMs = options.deadlineMs ?? ACCESS_FORM_DEADLINE_MS;
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!URL_ENCODED_CONTENT_TYPE_PATTERN.test(contentType)) return null;
  const encoding =
    request.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (encoding && encoding !== "identity") return null;
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d{1,10}$/u.test(declaredLength) ||
      Number(declaredLength) > maximumBytes)
  ) {
    return null;
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const deadlineAt = Date.now() + deadlineMs;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (next === "timeout") return null;
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) return null;
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const form = new URLSearchParams(text);
    if (Array.from(form.keys()).some((key) => !allowedKeys.has(key))) {
      return null;
    }
    return form;
  } catch {
    return null;
  }
}
