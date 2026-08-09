export const SITE_CONVERSATION_EXPORT_MAX_MESSAGES = 5_000;
export const SITE_CONVERSATION_EXPORT_MAX_THREADS = 1_000;
export const SITE_CONVERSATION_EXPORT_MAX_BODY_BYTES = 32 * 1024;
export const SITE_CONVERSATION_EXPORT_MAX_LINE_BYTES = 256 * 1024;
export const SITE_CONVERSATION_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
export const SITE_CONVERSATION_EXPORT_MAX_CONFIRMATION_BYTES = 128;
export const SITE_CONVERSATION_EXPORT_MAX_ERROR_BYTES = 64 * 1024;
export const SITE_CONVERSATION_EXPORT_MAX_FINALIZATION_BYTES = 4 * 1024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_INTEGER_PATTERN = /^(0|[1-9][0-9]{0,9})$/u;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/u;
const ALLOWED_KEYS = new Set(["days", "channel"]);
const ALLOWED_DAYS = new Set(["7", "30", "90"]);
const ALLOWED_CHANNELS = new Set(["all", "sms", "email", "dm", "call", "web"]);
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:;\s*charset=utf-8)?$/iu;

export type SiteConversationExportReceipt = {
  contentType: string;
  contentDisposition: string;
  receiptId: string;
  correlationId: string;
  rowCount: number;
  threadCount: number;
  messageCount: number;
  byteCount: number;
  auditState: "prepared" | "released";
};

export type SiteConversationExportError = {
  error: string;
  message: string;
  correlationId: string;
  supportId: string;
  retryable: boolean;
};

export type SiteConversationExportFinalizationAck = {
  correlationId: string;
  exportId: string;
  outcome: "released" | "failed";
  idempotent: boolean;
};

export type SiteConversationExportFinalizationReason =
  | "body_timeout"
  | "invalid_body"
  | "invalid_receipt"
  | "site_permission_mismatch"
  | null;

export type SiteConversationExportFinalizationAttempt = {
  body: string;
  correlationId: string;
  timeoutMs: number;
};

const RELEASE_FINALIZATION_MAX_ATTEMPTS = 2;
const RELEASE_FINALIZATION_RETRY_GRACE_MS = 3_000;

export class ConversationExportBodyTimeoutError extends Error {
  constructor() {
    super("conversation_export_body_timeout");
    this.name = "ConversationExportBodyTimeoutError";
  }
}

export type CanonicalConversationExportQueryResult =
  | { ok: true; query: string }
  | { ok: false; message: string };

function headerInteger(headers: Headers, name: string): number | null {
  const raw = headers.get(name) ?? "";
  if (!SAFE_INTEGER_PATTERN.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasConversationExportContent(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return !((code >= 0x09 && code <= 0x0d) || code === 0x20);
  });
}

function safeMessage(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000) {
    return null;
  }
  if (
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 && code !== 0x09 && code !== 0x0a;
    })
  ) {
    return null;
  }
  return value.trim();
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort; validation still fails closed.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort; the caller still stops consuming bytes.
  }
}

export function isSameOriginConversationExportRequest(
  request: Pick<Request, "headers" | "url">,
): boolean {
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

export async function readSiteConversationExportConfirmation(
  request: Request,
  options: { deadlineAt?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (
    !JSON_CONTENT_TYPE_PATTERN.test(request.headers.get("content-type") ?? "")
  ) {
    return false;
  }
  const bytes = await readBoundedExportResponse(
    new Response(request.body, { headers: request.headers }),
    SITE_CONVERSATION_EXPORT_MAX_CONFIRMATION_BYTES,
    undefined,
    options,
  );
  if (!bytes || bytes.byteLength === 0) return false;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    return (
      record(parsed) &&
      Object.keys(parsed).length === 1 &&
      parsed["confirmed"] === true
    );
  } catch {
    return false;
  }
}

export function canonicalConversationExportQuery(
  searchParams: URLSearchParams,
): CanonicalConversationExportQueryResult {
  const keys = Array.from(searchParams.keys());
  if (keys.some((key) => !ALLOWED_KEYS.has(key))) {
    return {
      ok: false,
      message: "Only days and channel filters are supported for this export.",
    };
  }
  if (
    searchParams.getAll("days").length > 1 ||
    searchParams.getAll("channel").length > 1
  ) {
    return { ok: false, message: "Each export filter may appear only once." };
  }
  const days = searchParams.get("days") ?? "30";
  const channel = (searchParams.get("channel") ?? "all").toLowerCase();
  if (!ALLOWED_DAYS.has(days)) {
    return { ok: false, message: "Days must be 7, 30, or 90." };
  }
  if (!ALLOWED_CHANNELS.has(channel)) {
    return {
      ok: false,
      message: "Channel must be all, sms, email, dm, call, or web.",
    };
  }
  const canonical = new URLSearchParams({ days });
  if (channel !== "all") canonical.set("channel", channel);
  return { ok: true, query: canonical.toString() };
}

export function parseConversationExportReceipt(
  headers: Headers,
  expectedCorrelationId: string,
  expectedAuditState: "prepared" | "released" = "prepared",
): SiteConversationExportReceipt | null {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  const contentDisposition = headers.get("content-disposition") ?? "";
  const formatVersion = headers.get("x-export-format-version") ?? "";
  const receiptId = headers.get("x-export-receipt-id") ?? "";
  const correlationId = headers.get("x-audit-correlation-id") ?? "";
  const truncated = headers.get("x-export-truncated") ?? "";
  const auditState = headers.get("x-export-audit-state") ?? "";
  const rowCount = headerInteger(headers, "x-export-row-count");
  const threadCount = headerInteger(headers, "x-export-thread-count");
  const messageCount = headerInteger(headers, "x-export-message-count");
  const byteCount = headerInteger(headers, "x-export-byte-count");
  const contentLength = headerInteger(headers, "content-length");
  const maximumMessages = headerInteger(headers, "x-export-maximum-messages");
  const maximumThreads = headerInteger(headers, "x-export-maximum-threads");
  const maximumBodyBytes = headerInteger(
    headers,
    "x-export-maximum-body-bytes",
  );
  const maximumLineBytes = headerInteger(
    headers,
    "x-export-maximum-line-bytes",
  );
  const maximumBytes = headerInteger(headers, "x-export-maximum-bytes");

  if (
    contentType !== "application/x-ndjson; charset=utf-8" ||
    !/^attachment; filename="stonegate-conversations-\d{4}-\d{2}-\d{2}\.jsonl"$/u.test(
      contentDisposition,
    ) ||
    formatVersion !== "1" ||
    !UUID_PATTERN.test(receiptId) ||
    !UUID_PATTERN.test(correlationId) ||
    correlationId.toLowerCase() !== expectedCorrelationId.toLowerCase() ||
    truncated !== "false" ||
    auditState !== expectedAuditState ||
    rowCount === null ||
    threadCount === null ||
    messageCount === null ||
    byteCount === null ||
    contentLength === null ||
    maximumMessages !== SITE_CONVERSATION_EXPORT_MAX_MESSAGES ||
    maximumThreads !== SITE_CONVERSATION_EXPORT_MAX_THREADS ||
    maximumBodyBytes !== SITE_CONVERSATION_EXPORT_MAX_BODY_BYTES ||
    maximumLineBytes !== SITE_CONVERSATION_EXPORT_MAX_LINE_BYTES ||
    maximumBytes !== SITE_CONVERSATION_EXPORT_MAX_BYTES ||
    rowCount !== threadCount ||
    threadCount > SITE_CONVERSATION_EXPORT_MAX_THREADS ||
    messageCount > SITE_CONVERSATION_EXPORT_MAX_MESSAGES ||
    byteCount > SITE_CONVERSATION_EXPORT_MAX_BYTES ||
    contentLength !== byteCount ||
    (rowCount === 0) !== (messageCount === 0) ||
    messageCount < rowCount
  ) {
    return null;
  }
  return {
    contentType,
    contentDisposition,
    receiptId: receiptId.toLowerCase(),
    correlationId: correlationId.toLowerCase(),
    rowCount,
    threadCount,
    messageCount,
    byteCount,
    auditState: expectedAuditState,
  };
}

export function parseReleasedConversationExportReceipt(
  headers: Headers,
): SiteConversationExportReceipt | null {
  const correlationId = headers.get("x-audit-correlation-id") ?? "";
  if (!UUID_PATTERN.test(correlationId)) return null;
  return parseConversationExportReceipt(headers, correlationId, "released");
}

export function parseConversationExportError(
  bytes: Uint8Array | null,
  headers: Headers,
  expectedCorrelationId?: string,
): SiteConversationExportError | null {
  if (
    !bytes ||
    !JSON_CONTENT_TYPE_PATTERN.test(headers.get("content-type") ?? "")
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return null;
  }
  if (!record(parsed)) return null;
  const error = parsed["error"];
  const message = safeMessage(parsed["message"]);
  const correlationId = parsed["correlationId"];
  const supportId = parsed["supportId"];
  const headerCorrelation = headers.get("x-audit-correlation-id") ?? "";
  const retryable = parsed["retryable"];
  if (
    typeof error !== "string" ||
    !SAFE_ERROR_CODE.test(error) ||
    !message ||
    typeof correlationId !== "string" ||
    !UUID_PATTERN.test(correlationId) ||
    typeof supportId !== "string" ||
    !UUID_PATTERN.test(supportId) ||
    supportId.toLowerCase() !== correlationId.toLowerCase() ||
    !UUID_PATTERN.test(headerCorrelation) ||
    correlationId.toLowerCase() !== headerCorrelation.toLowerCase() ||
    (expectedCorrelationId !== undefined &&
      correlationId.toLowerCase() !== expectedCorrelationId.toLowerCase()) ||
    typeof retryable !== "boolean"
  ) {
    return null;
  }
  return {
    error,
    message,
    correlationId: correlationId.toLowerCase(),
    supportId: supportId.toLowerCase(),
    retryable,
  };
}

export function parseConversationExportFinalizationAck(
  bytes: Uint8Array | null,
  headers: Headers,
  expected: {
    correlationId: string;
    exportId: string | null;
    outcome: "released" | "failed";
  },
): SiteConversationExportFinalizationAck | null {
  if (
    !bytes ||
    !JSON_CONTENT_TYPE_PATTERN.test(headers.get("content-type") ?? "")
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return null;
  }
  if (
    !record(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "correlationId,exportId,idempotent,ok,outcome"
  ) {
    return null;
  }
  const correlationId = parsed["correlationId"];
  const exportId = parsed["exportId"];
  const outcome = parsed["outcome"];
  const idempotent = parsed["idempotent"];
  const headerCorrelation = headers.get("x-audit-correlation-id") ?? "";
  if (
    parsed["ok"] !== true ||
    typeof correlationId !== "string" ||
    !UUID_PATTERN.test(correlationId) ||
    correlationId.toLowerCase() !== expected.correlationId.toLowerCase() ||
    !UUID_PATTERN.test(headerCorrelation) ||
    headerCorrelation.toLowerCase() !== correlationId.toLowerCase() ||
    typeof exportId !== "string" ||
    !UUID_PATTERN.test(exportId) ||
    (expected.exportId !== null &&
      exportId.toLowerCase() !== expected.exportId.toLowerCase()) ||
    outcome !== expected.outcome ||
    typeof idempotent !== "boolean"
  ) {
    return null;
  }
  return {
    correlationId: correlationId.toLowerCase(),
    exportId: exportId.toLowerCase(),
    outcome: outcome as SiteConversationExportFinalizationAck["outcome"],
    idempotent,
  };
}

/**
 * Close the prepared-export lifecycle before any bytes reach the browser.
 *
 * A transport can lose the first acknowledgement after the API commits the
 * terminal audit row. One replay is therefore allowed for release only. The
 * replay uses the byte-for-byte same body and correlation ID. If a successful
 * HTTP response was observed but its acknowledgement was malformed or timed
 * out, the replay must explicitly prove idempotency. A pure transport failure
 * may have happened before the first request arrived, so its replay may
 * truthfully be the first committed terminal event. A non-success HTTP
 * response is definitive and is never retried here.
 */
export async function finalizeSiteConversationExport(input: {
  correlationId: string;
  exportId: string | null;
  outcome: "released" | "failed";
  reason: SiteConversationExportFinalizationReason;
  deadlineAt: number;
  invoke: (
    attempt: SiteConversationExportFinalizationAttempt,
  ) => Promise<Response>;
}): Promise<boolean> {
  const body = JSON.stringify({
    correlationId: input.correlationId,
    exportId: input.exportId,
    outcome: input.outcome,
    reason: input.reason,
  });
  const maximumAttempts =
    input.outcome === "released" ? RELEASE_FINALIZATION_MAX_ATTEMPTS : 1;
  let attemptDeadlineAt = input.deadlineAt;
  let requireIdempotentReplay = false;

  for (
    let attemptIndex = 0;
    attemptIndex < maximumAttempts;
    attemptIndex += 1
  ) {
    let successfulResponseObserved = false;
    try {
      const upstream = await input.invoke({
        body,
        correlationId: input.correlationId,
        timeoutMs: Math.max(1, attemptDeadlineAt - Date.now()),
      });
      if (!upstream.ok) return false;
      successfulResponseObserved = true;
      const bytes = await readBoundedExportResponse(
        upstream,
        SITE_CONVERSATION_EXPORT_MAX_FINALIZATION_BYTES,
        undefined,
        { deadlineAt: attemptDeadlineAt },
      );
      const acknowledgement = parseConversationExportFinalizationAck(
        bytes,
        upstream.headers,
        {
          correlationId: input.correlationId,
          exportId: input.exportId,
          outcome: input.outcome,
        },
      );
      if (
        acknowledgement &&
        (!requireIdempotentReplay || acknowledgement.idempotent)
      ) {
        return true;
      }
      requireIdempotentReplay = true;
    } catch {
      // A lost response is ambiguous: the API may already have committed.
      if (successfulResponseObserved) requireIdempotentReplay = true;
    }

    if (attemptIndex + 1 < maximumAttempts) {
      attemptDeadlineAt = Math.max(
        input.deadlineAt,
        Date.now() + RELEASE_FINALIZATION_RETRY_GRACE_MS,
      );
    }
  }

  return false;
}

export async function readBoundedExportResponse(
  response: Response,
  maximumBytes: number,
  expectedBytes?: number,
  options: { deadlineAt?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return null;
  const declared = headerInteger(response.headers, "content-length");
  if (
    (response.headers.has("content-length") && declared === null) ||
    (declared !== null && declared > maximumBytes) ||
    (expectedBytes !== undefined && declared !== expectedBytes)
  ) {
    cancelResponseBody(response);
    return null;
  }
  if (!response.body) {
    return expectedBytes === undefined || expectedBytes === 0
      ? new Uint8Array()
      : null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (options.signal?.aborted) {
        cancelReader(reader);
        throw new ConversationExportBodyTimeoutError();
      }
      const remaining =
        options.deadlineAt === undefined
          ? null
          : Math.max(0, options.deadlineAt - Date.now());
      if (remaining === 0) {
        cancelReader(reader);
        throw new ConversationExportBodyTimeoutError();
      }

      const readPromise = reader.read();
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let abortHandler: (() => void) | null = null;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        if (remaining !== null) {
          timeoutId = setTimeout(() => resolve("timeout"), remaining);
        }
        if (options.signal) {
          abortHandler = () => resolve("timeout");
          options.signal.addEventListener("abort", abortHandler, {
            once: true,
          });
        }
      });
      let next: ReadableStreamReadResult<Uint8Array> | "timeout";
      try {
        next = await Promise.race([readPromise, timeoutPromise]);
      } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (abortHandler && options.signal) {
          options.signal.removeEventListener("abort", abortHandler);
        }
      }
      if (next === "timeout") {
        cancelReader(reader);
        void readPromise.catch(() => undefined);
        throw new ConversationExportBodyTimeoutError();
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        cancelReader(reader);
        return null;
      }
      chunks.push(next.value);
    }
  } catch (error) {
    cancelReader(reader);
    if (error instanceof ConversationExportBodyTimeoutError) throw error;
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out pending read can retain the lock until cancellation settles.
    }
  }
  if (expectedBytes !== undefined && total !== expectedBytes) return null;
  if (declared !== null && total !== declared) return null;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function validateConversationJsonl(
  bytes: Uint8Array,
  receipt: SiteConversationExportReceipt,
): boolean {
  if (bytes.byteLength !== receipt.byteCount) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (receipt.rowCount === 0) return text === "";
  if (!text.endsWith("\n") || text.includes("\r")) return false;
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== receipt.rowCount) return false;

  const encoder = new TextEncoder();
  let messageCount = 0;
  for (const line of lines) {
    if (
      !line ||
      encoder.encode(`${line}\n`).byteLength >
        SITE_CONVERSATION_EXPORT_MAX_LINE_BYTES
    ) {
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return false;
    }
    if (
      !record(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !Array.isArray(parsed["messages"]) ||
      parsed["messages"].length === 0
    ) {
      return false;
    }
    for (const message of parsed["messages"]) {
      if (
        !record(message) ||
        Object.keys(message).length !== 2 ||
        (message["role"] !== "user" && message["role"] !== "assistant") ||
        typeof message["content"] !== "string" ||
        !hasConversationExportContent(message["content"]) ||
        containsUnpairedSurrogate(message["content"]) ||
        encoder.encode(message["content"]).byteLength >
          SITE_CONVERSATION_EXPORT_MAX_BODY_BYTES
      ) {
        return false;
      }
      messageCount += 1;
    }
  }
  return messageCount === receipt.messageCount;
}
