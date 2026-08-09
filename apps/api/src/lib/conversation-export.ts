export const CONVERSATION_EXPORT_ALLOWED_DAYS = [7, 30, 90] as const;
export const CONVERSATION_EXPORT_CHANNELS = [
  "sms",
  "email",
  "dm",
  "call",
  "web",
] as const;
export const CONVERSATION_EXPORT_DEFAULT_DAYS = 30;
export const CONVERSATION_EXPORT_MAX_MESSAGES = 5_000;
export const CONVERSATION_EXPORT_MAX_THREADS = 1_000;
export const CONVERSATION_EXPORT_MAX_BODY_BYTES = 32 * 1024;
export const CONVERSATION_EXPORT_MAX_LINE_BYTES = 256 * 1024;
export const CONVERSATION_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
export const CONVERSATION_EXPORT_MAX_CONFIRMATION_BYTES = 128;
export const CONVERSATION_EXPORT_MAX_FINALIZATION_BYTES = 512;

export type ConversationExportChannel =
  (typeof CONVERSATION_EXPORT_CHANNELS)[number];

export type ConversationExportQuery = {
  days: (typeof CONVERSATION_EXPORT_ALLOWED_DAYS)[number];
  channel: ConversationExportChannel | null;
  fromInclusive: Date;
  toExclusive: Date;
};

export type ConversationExportParseResult =
  | { ok: true; query: ConversationExportQuery }
  | { ok: false; field: "query" | "days" | "channel"; message: string };

export type ConversationExportFinalizationInput = {
  correlationId: string;
  exportId: string | null;
  outcome: "released" | "failed";
  reason:
    | "body_timeout"
    | "invalid_body"
    | "invalid_receipt"
    | "site_permission_mismatch"
    | null;
};

export type ConversationExportSourceRow = {
  threadKey: string;
  role: "user" | "assistant";
  content: string;
};

export type ConversationExportLimits = {
  maximumMessages: number;
  maximumThreads: number;
  maximumBodyBytes: number;
  maximumLineBytes: number;
  maximumBytes: number;
};

export type ConversationExportLimitReason =
  | "message_limit"
  | "thread_limit"
  | "body_limit"
  | "line_limit"
  | "byte_limit"
  | "invalid_row";

export type ConversationExportBuildResult =
  | {
      ok: true;
      text: string;
      bytes: Uint8Array;
      rowCount: number;
      threadCount: number;
      messageCount: number;
      byteCount: number;
    }
  | {
      ok: false;
      reason: ConversationExportLimitReason;
      observed: number;
      maximum: number;
    };

const ALLOWED_QUERY_KEYS = new Set(["days", "channel"]);
const ALLOWED_DAYS = new Set<number>(CONVERSATION_EXPORT_ALLOWED_DAYS);
const ALLOWED_CHANNELS = new Set<string>(CONVERSATION_EXPORT_CHANNELS);
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:;\s*charset=utf-8)?$/iu;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINALIZATION_FAILURE_REASONS = new Set([
  "body_timeout",
  "invalid_body",
  "invalid_receipt",
  "site_permission_mismatch",
]);

export const DEFAULT_CONVERSATION_EXPORT_LIMITS: ConversationExportLimits = {
  maximumMessages: CONVERSATION_EXPORT_MAX_MESSAGES,
  maximumThreads: CONVERSATION_EXPORT_MAX_THREADS,
  maximumBodyBytes: CONVERSATION_EXPORT_MAX_BODY_BYTES,
  maximumLineBytes: CONVERSATION_EXPORT_MAX_LINE_BYTES,
  maximumBytes: CONVERSATION_EXPORT_MAX_BYTES,
};

function validLimits(limits: ConversationExportLimits): boolean {
  return Object.values(limits).every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
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

export function hasConversationExportContent(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return !((code >= 0x09 && code <= 0x0d) || code === 0x20);
  });
}

async function readBoundedConversationExportRequest(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array | null> {
  if (
    !JSON_CONTENT_TYPE_PATTERN.test(request.headers.get("content-type") ?? "")
  ) {
    return null;
  }

  const declaredRaw = request.headers.get("content-length");
  if (declaredRaw !== null) {
    if (!/^(0|[1-9][0-9]{0,3})$/u.test(declaredRaw)) return null;
    const declared = Number(declaredRaw);
    if (
      !Number.isSafeInteger(declared) ||
      declared < 1 ||
      declared > maximumBytes
    ) {
      return null;
    }
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
  if (total < 1 || (declaredRaw !== null && Number(declaredRaw) !== total)) {
    return null;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

export async function readConversationExportConfirmation(
  request: Request,
): Promise<boolean> {
  const bytes = await readBoundedConversationExportRequest(
    request,
    CONVERSATION_EXPORT_MAX_CONFIRMATION_BYTES,
  );
  if (!bytes) return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      (parsed as Record<string, unknown>)["confirmed"] === true
    );
  } catch {
    return false;
  }
}

export async function readConversationExportFinalization(
  request: Request,
  expectedCorrelationId: string,
): Promise<ConversationExportFinalizationInput | null> {
  const bytes = await readBoundedConversationExportRequest(
    request,
    CONVERSATION_EXPORT_MAX_FINALIZATION_BYTES,
  );
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "correlationId,exportId,outcome,reason"
  ) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const correlationId = record["correlationId"];
  const exportId = record["exportId"];
  const outcome = record["outcome"];
  const reason = record["reason"];
  if (
    typeof correlationId !== "string" ||
    !UUID_PATTERN.test(correlationId) ||
    correlationId.toLowerCase() !== expectedCorrelationId.toLowerCase() ||
    (exportId !== null &&
      (typeof exportId !== "string" || !UUID_PATTERN.test(exportId))) ||
    (outcome === "released" && exportId === null) ||
    (outcome !== "released" && outcome !== "failed") ||
    (outcome === "released" && reason !== null) ||
    (outcome === "failed" &&
      (typeof reason !== "string" || !FINALIZATION_FAILURE_REASONS.has(reason)))
  ) {
    return null;
  }
  return {
    correlationId: correlationId.toLowerCase(),
    exportId: typeof exportId === "string" ? exportId.toLowerCase() : null,
    outcome,
    reason: reason as ConversationExportFinalizationInput["reason"],
  };
}

export function parseConversationExportQuery(
  searchParams: URLSearchParams,
  now = new Date(),
): ConversationExportParseResult {
  const keys = Array.from(searchParams.keys());
  if (keys.some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    return {
      ok: false,
      field: "query",
      message: "Only days and channel filters are supported.",
    };
  }
  if (
    searchParams.getAll("days").length > 1 ||
    searchParams.getAll("channel").length > 1
  ) {
    return {
      ok: false,
      field: "query",
      message: "Each export filter may be supplied only once.",
    };
  }

  const daysRaw =
    searchParams.get("days") ?? String(CONVERSATION_EXPORT_DEFAULT_DAYS);
  if (!/^\d{1,2}$/u.test(daysRaw)) {
    return {
      ok: false,
      field: "days",
      message: "Days must be 7, 30, or 90.",
    };
  }
  const days = Number(daysRaw);
  if (!ALLOWED_DAYS.has(days)) {
    return {
      ok: false,
      field: "days",
      message: "Days must be 7, 30, or 90.",
    };
  }

  const channelRaw = (searchParams.get("channel") ?? "all").toLowerCase();
  if (channelRaw !== "all" && !ALLOWED_CHANNELS.has(channelRaw)) {
    return {
      ok: false,
      field: "channel",
      message: "Channel must be all, sms, email, dm, call, or web.",
    };
  }
  if (!Number.isFinite(now.getTime())) {
    return { ok: false, field: "query", message: "Export time is invalid." };
  }

  // This is an exact trailing window ending when the export is requested. It
  // neither includes future-dated rows later in the UTC day nor silently uses
  // UTC-midnight boundaries for an Eastern-time CRM.
  const toExclusive = new Date(now.getTime());
  const fromInclusive = new Date(
    toExclusive.getTime() - days * 24 * 60 * 60 * 1_000,
  );
  return {
    ok: true,
    query: {
      days: days as ConversationExportQuery["days"],
      channel:
        channelRaw === "all" ? null : (channelRaw as ConversationExportChannel),
      fromInclusive,
      toExclusive,
    },
  };
}

export function conversationExportFilterEvidence(
  query: ConversationExportQuery,
): Record<string, unknown> {
  return {
    days: query.days,
    channel: query.channel ?? "all",
    fromInclusive: query.fromInclusive.toISOString(),
    toExclusive: query.toExclusive.toISOString(),
  };
}

export function isConversationMessageExportEligible(input: {
  direction: string;
  deliveryStatus: string;
  draft: boolean;
}): boolean {
  if (input.direction === "internal") return false;
  if (input.direction === "inbound") return true;
  return (
    input.direction === "outbound" &&
    !input.draft &&
    (input.deliveryStatus === "sent" || input.deliveryStatus === "delivered")
  );
}

export function buildConversationJsonl(
  rows: readonly ConversationExportSourceRow[],
  limits: ConversationExportLimits = DEFAULT_CONVERSATION_EXPORT_LIMITS,
): ConversationExportBuildResult {
  if (!validLimits(limits)) {
    throw new Error("invalid_conversation_export_limits");
  }
  if (rows.length > limits.maximumMessages) {
    return {
      ok: false,
      reason: "message_limit",
      observed: rows.length,
      maximum: limits.maximumMessages,
    };
  }

  const encoder = new TextEncoder();
  const byThread = new Map<
    string,
    Array<{ role: "user" | "assistant"; content: string }>
  >();
  for (const row of rows) {
    if (
      !row.threadKey ||
      (row.role !== "user" && row.role !== "assistant") ||
      !hasConversationExportContent(row.content) ||
      containsUnpairedSurrogate(row.content)
    ) {
      return {
        ok: false,
        reason: "invalid_row",
        observed: 1,
        maximum: 0,
      };
    }
    const bodyBytes = encoder.encode(row.content).byteLength;
    if (bodyBytes > limits.maximumBodyBytes) {
      return {
        ok: false,
        reason: "body_limit",
        observed: bodyBytes,
        maximum: limits.maximumBodyBytes,
      };
    }
    const messages = byThread.get(row.threadKey) ?? [];
    messages.push({ role: row.role, content: row.content });
    byThread.set(row.threadKey, messages);
    if (byThread.size > limits.maximumThreads) {
      return {
        ok: false,
        reason: "thread_limit",
        observed: byThread.size,
        maximum: limits.maximumThreads,
      };
    }
  }

  const encodedLines: Uint8Array[] = [];
  let totalBytes = 0;
  for (const messages of byThread.values()) {
    const line = JSON.stringify({ messages });
    const encoded = encoder.encode(`${line}\n`);
    if (encoded.byteLength > limits.maximumLineBytes) {
      return {
        ok: false,
        reason: "line_limit",
        observed: encoded.byteLength,
        maximum: limits.maximumLineBytes,
      };
    }
    totalBytes += encoded.byteLength;
    if (totalBytes > limits.maximumBytes) {
      return {
        ok: false,
        reason: "byte_limit",
        observed: totalBytes,
        maximum: limits.maximumBytes,
      };
    }
    encodedLines.push(encoded);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const line of encodedLines) {
    bytes.set(line, offset);
    offset += line.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return {
    ok: true,
    text,
    bytes,
    rowCount: byThread.size,
    threadCount: byThread.size,
    messageCount: rows.length,
    byteCount: bytes.byteLength,
  };
}
