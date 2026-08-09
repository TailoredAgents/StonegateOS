import type { NextRequest } from "next/server";

export class BoundedJsonRequestError extends Error {
  readonly status: 400 | 408 | 413 | 415;
  readonly code:
    | "invalid_body"
    | "body_timeout"
    | "body_too_large"
    | "unsupported_media_type";

  constructor(
    code: BoundedJsonRequestError["code"],
    message: string,
    status: BoundedJsonRequestError["status"],
  ) {
    super(message);
    this.name = "BoundedJsonRequestError";
    this.code = code;
    this.status = status;
  }
}

function requestFailure(
  code: BoundedJsonRequestError["code"],
  message: string,
  status: BoundedJsonRequestError["status"],
): never {
  throw new BoundedJsonRequestError(code, message, status);
}

/**
 * Native JSON parsing accepts duplicate object keys and silently keeps the
 * final value. Security-sensitive request shapes can opt into this scanner so
 * ambiguous keys (including escaped-equivalent names) fail closed.
 */
export function parseJsonRejectingDuplicateObjectKeys(text: string): unknown {
  const stack: Array<
    { kind: "object"; keys: Set<string> } | { kind: "array" }
  > = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      stack.push({ kind: "object", keys: new Set() });
      if (stack.length > 128) {
        requestFailure(
          "invalid_body",
          "The JSON body is nested too deeply.",
          400,
        );
      }
      continue;
    }
    if (character === "[") {
      stack.push({ kind: "array" });
      if (stack.length > 128) {
        requestFailure(
          "invalid_body",
          "The JSON body is nested too deeply.",
          400,
        );
      }
      continue;
    }
    if (character === "}" || character === "]") {
      stack.pop();
      continue;
    }
    if (character !== '"') continue;

    const start = index;
    let escaped = false;
    for (index += 1; index < text.length; index += 1) {
      const stringCharacter = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (stringCharacter === "\\") {
        escaped = true;
        continue;
      }
      if (stringCharacter === '"') break;
    }
    if (index >= text.length) break;
    let lookahead = index + 1;
    while (/\s/u.test(text[lookahead] ?? "")) lookahead += 1;
    if (text[lookahead] !== ":") continue;
    const frame = stack.at(-1);
    if (frame?.kind !== "object") continue;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(start, index + 1)) as unknown;
    } catch {
      requestFailure(
        "invalid_body",
        "The request body is not valid JSON.",
        400,
      );
    }
    if (typeof key !== "string") continue;
    if (frame.keys.has(key)) {
      requestFailure(
        "invalid_body",
        "The JSON body contains a duplicate object key.",
        400,
      );
    }
    frame.keys.add(key);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    requestFailure("invalid_body", "The request body is not valid JSON.", 400);
  }
}

export async function readBoundedJsonRequest(
  request: NextRequest,
  options: {
    maximumBytes?: number;
    deadlineMs?: number;
    rejectDuplicateObjectKeys?: boolean;
  } = {},
): Promise<unknown> {
  const maximumBytes = options.maximumBytes ?? 8 * 1024;
  const deadlineMs = options.deadlineMs ?? 10_000;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 1024 * 1024 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 60_000
  ) {
    throw new TypeError("The bounded JSON request limits are invalid.");
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    requestFailure(
      "unsupported_media_type",
      "This endpoint accepts application/json only.",
      415,
    );
  }
  const contentEncoding =
    request.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (contentEncoding && contentEncoding !== "identity") {
    requestFailure(
      "unsupported_media_type",
      "Compressed request bodies are not supported.",
      415,
    );
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d{1,10}$/u.test(declaredLength)) {
      requestFailure("invalid_body", "Content-Length is invalid.", 400);
    }
    if (Number(declaredLength) > maximumBytes) {
      requestFailure("body_too_large", "The request body is too large.", 413);
    }
  }

  const reader = request.body?.getReader();
  if (!reader) requestFailure("invalid_body", "A JSON body is required.", 400);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadlineAt = Date.now() + deadlineMs;
  try {
    while (true) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        requestFailure("body_timeout", "The request body timed out.", 408);
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new BoundedJsonRequestError(
                  "body_timeout",
                  "The request body timed out.",
                  408,
                ),
              ),
            remainingMs,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (result.done) break;
      if (!result.value) continue;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        requestFailure("body_too_large", "The request body is too large.", 413);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel("bounded_json_request_rejected").catch(() => undefined);
    if (error instanceof BoundedJsonRequestError) throw error;
    requestFailure("invalid_body", "The request body could not be read.", 400);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    requestFailure("invalid_body", "The JSON body must be valid UTF-8.", 400);
  }
  if (options.rejectDuplicateObjectKeys) {
    return parseJsonRejectingDuplicateObjectKeys(text);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    requestFailure("invalid_body", "The request body is not valid JSON.", 400);
  }
}
