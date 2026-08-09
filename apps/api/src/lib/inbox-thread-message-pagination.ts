const DEFAULT_LIMIT = 50;
export const MAX_INBOX_THREAD_MESSAGE_LIMIT = 100;
const MAX_CURSOR_LENGTH = 1_200;
const MAX_DECODED_CURSOR_BYTES = 900;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const ISO_INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/u;
const QUERY_KEYS = new Set(["cursor", "limit"]);

export type InboxThreadMessageKey = {
  createdAt: string;
  id: string;
};

export type InboxThreadMessageCursor = {
  version: 1;
  threadId: string;
  limit: number;
  direction: "older" | "newer";
  anchorCreatedAt: string;
  anchorId: string;
  snapshotCreatedAt: string;
  snapshotId: string;
};

export type ParsedInboxThreadMessageQuery = {
  limit: number;
  cursor: InboxThreadMessageCursor | null;
};

export type InboxThreadMessageQueryResult =
  | { ok: true; query: ParsedInboxThreadMessageQuery }
  | { ok: false; field: string; message: string };

export type InboxThreadIdResult =
  | { ok: true; threadId: string }
  | {
      ok: false;
      status: 400 | 422;
      error: "thread_id_required" | "invalid_thread_id";
      message: string;
    };

export type InboxThreadMessagePageMetadata = {
  version: 1;
  state: "empty" | "available";
  complete: true;
  order: "oldest_to_newest";
  position: "newest" | "history";
  limit: number;
  returned: number;
  snapshot: InboxThreadMessageKey | null;
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor: string | null;
  newerCursor: string | null;
};

function isExactIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) return false;
  const millisecondIso = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
  const parsed = new Date(millisecondIso);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString() === millisecondIso
  );
}

function normalizedInstant(value: string): string {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) return value;
  return `${match[1]}.${match[2]!.padEnd(6, "0")}Z`;
}

export function parseInboxThreadId(
  value: string | null | undefined,
): InboxThreadIdResult {
  if (value === null || value === undefined || value.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "thread_id_required",
      message: "threadId is required.",
    };
  }
  if (!UUID_PATTERN.test(value)) {
    return {
      ok: false,
      status: 422,
      error: "invalid_thread_id",
      message: "threadId must be a UUID.",
    };
  }
  return { ok: true, threadId: value.toLowerCase() };
}

function isMessageKey(value: unknown): value is InboxThreadMessageKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "createdAt,id" &&
    isExactIsoInstant(record["createdAt"]) &&
    typeof record["id"] === "string" &&
    UUID_PATTERN.test(record["id"])
  );
}

export function compareInboxThreadMessageKeys(
  left: InboxThreadMessageKey,
  right: InboxThreadMessageKey,
): number {
  const timestamp = normalizedInstant(left.createdAt).localeCompare(
    normalizedInstant(right.createdAt),
  );
  if (timestamp !== 0) return timestamp;
  return left.id.localeCompare(right.id);
}

export function encodeInboxThreadMessageCursor(
  cursor: InboxThreadMessageCursor,
): string {
  if (
    cursor.version !== 1 ||
    !UUID_PATTERN.test(cursor.threadId) ||
    !Number.isSafeInteger(cursor.limit) ||
    cursor.limit < 1 ||
    cursor.limit > MAX_INBOX_THREAD_MESSAGE_LIMIT ||
    (cursor.direction !== "older" && cursor.direction !== "newer") ||
    !isExactIsoInstant(cursor.anchorCreatedAt) ||
    !UUID_PATTERN.test(cursor.anchorId) ||
    !isExactIsoInstant(cursor.snapshotCreatedAt) ||
    !UUID_PATTERN.test(cursor.snapshotId) ||
    compareInboxThreadMessageKeys(
      { createdAt: cursor.anchorCreatedAt, id: cursor.anchorId },
      { createdAt: cursor.snapshotCreatedAt, id: cursor.snapshotId },
    ) > 0
  ) {
    throw new TypeError("Cannot encode an invalid Inbox message cursor.");
  }

  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeInboxThreadMessageCursor(
  value: string,
): InboxThreadMessageCursor | null {
  if (
    !value ||
    value.length > MAX_CURSOR_LENGTH ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return null;
  }

  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.byteLength > MAX_DECODED_CURSOR_BYTES) return null;
    const parsed = JSON.parse(decoded.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      !parsed ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !==
        "anchorCreatedAt,anchorId,direction,limit,snapshotCreatedAt,snapshotId,threadId,version" ||
      parsed["version"] !== 1 ||
      typeof parsed["threadId"] !== "string" ||
      !UUID_PATTERN.test(parsed["threadId"]) ||
      typeof parsed["limit"] !== "number" ||
      !Number.isSafeInteger(parsed["limit"]) ||
      parsed["limit"] < 1 ||
      parsed["limit"] > MAX_INBOX_THREAD_MESSAGE_LIMIT ||
      (parsed["direction"] !== "older" && parsed["direction"] !== "newer") ||
      !isExactIsoInstant(parsed["anchorCreatedAt"]) ||
      typeof parsed["anchorId"] !== "string" ||
      !UUID_PATTERN.test(parsed["anchorId"]) ||
      !isExactIsoInstant(parsed["snapshotCreatedAt"]) ||
      typeof parsed["snapshotId"] !== "string" ||
      !UUID_PATTERN.test(parsed["snapshotId"])
    ) {
      return null;
    }

    const cursor: InboxThreadMessageCursor = {
      version: 1,
      threadId: parsed["threadId"],
      limit: parsed["limit"],
      direction: parsed["direction"],
      anchorCreatedAt: parsed["anchorCreatedAt"],
      anchorId: parsed["anchorId"],
      snapshotCreatedAt: parsed["snapshotCreatedAt"],
      snapshotId: parsed["snapshotId"],
    };
    if (
      compareInboxThreadMessageKeys(
        { createdAt: cursor.anchorCreatedAt, id: cursor.anchorId },
        { createdAt: cursor.snapshotCreatedAt, id: cursor.snapshotId },
      ) > 0 ||
      encodeInboxThreadMessageCursor(cursor) !== value
    ) {
      return null;
    }
    return cursor;
  } catch {
    return null;
  }
}

export function parseInboxThreadMessageQuery(
  searchParams: URLSearchParams,
  threadId: string,
): InboxThreadMessageQueryResult {
  for (const key of searchParams.keys()) {
    if (!QUERY_KEYS.has(key)) {
      return {
        ok: false,
        field: key,
        message: `Unsupported conversation-page parameter: ${key}.`,
      };
    }
  }

  const limitValues = searchParams.getAll("limit");
  if (limitValues.length > 1) {
    return {
      ok: false,
      field: "limit",
      message: "limit may only be provided once.",
    };
  }
  let limit = DEFAULT_LIMIT;
  if (limitValues.length === 1) {
    const rawLimit = limitValues[0] ?? "";
    if (!/^[1-9]\d{0,2}$/u.test(rawLimit)) {
      return {
        ok: false,
        field: "limit",
        message: "limit must be a positive whole number.",
      };
    }
    limit = Number(rawLimit);
    if (
      !Number.isSafeInteger(limit) ||
      limit > MAX_INBOX_THREAD_MESSAGE_LIMIT
    ) {
      return {
        ok: false,
        field: "limit",
        message: `limit must be between 1 and ${MAX_INBOX_THREAD_MESSAGE_LIMIT}.`,
      };
    }
  }

  const cursorValues = searchParams.getAll("cursor");
  if (cursorValues.length > 1) {
    return {
      ok: false,
      field: "cursor",
      message: "cursor may only be provided once.",
    };
  }
  const cursorRaw = cursorValues[0] ?? null;
  if (cursorValues.length === 1 && !cursorRaw) {
    return {
      ok: false,
      field: "cursor",
      message: "The conversation cursor cannot be empty.",
    };
  }
  const cursor = cursorRaw ? decodeInboxThreadMessageCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return {
      ok: false,
      field: "cursor",
      message:
        "The conversation cursor is invalid. Return to the newest messages and try again.",
    };
  }
  if (cursor && cursor.threadId !== threadId) {
    return {
      ok: false,
      field: "cursor",
      message:
        "The conversation cursor belongs to a different thread. Return to the newest messages.",
    };
  }
  if (cursor && cursor.limit !== limit) {
    return {
      ok: false,
      field: "limit",
      message:
        "The conversation cursor was created for a different page size. Return to the newest messages.",
    };
  }

  return { ok: true, query: { limit, cursor } };
}

export function buildInboxThreadMessagePageMetadata(input: {
  threadId: string;
  limit: number;
  visible: InboxThreadMessageKey[];
  snapshot: InboxThreadMessageKey | null;
  position: "newest" | "history";
  hasOlder: boolean;
  hasNewer: boolean;
}): InboxThreadMessagePageMetadata {
  const visible = input.visible;
  if (visible.length === 0) {
    if (
      input.snapshot ||
      input.position !== "newest" ||
      input.hasOlder ||
      input.hasNewer
    ) {
      throw new TypeError("An empty message page cannot have paging state.");
    }
    return {
      version: 1,
      state: "empty",
      complete: true,
      order: "oldest_to_newest",
      position: "newest",
      limit: input.limit,
      returned: 0,
      snapshot: null,
      hasOlder: false,
      hasNewer: false,
      olderCursor: null,
      newerCursor: null,
    };
  }
  if (!input.snapshot || !isMessageKey(input.snapshot)) {
    throw new TypeError("A non-empty message page requires a valid snapshot.");
  }
  if (
    visible.length > input.limit ||
    visible.some((key, index) => {
      return (
        !isMessageKey(key) ||
        (index > 0 &&
          compareInboxThreadMessageKeys(visible[index - 1]!, key) >= 0) ||
        compareInboxThreadMessageKeys(key, input.snapshot!) > 0
      );
    })
  ) {
    throw new TypeError("Cannot describe an invalid Inbox message page.");
  }

  const oldest = visible[0]!;
  const newest = visible.at(-1)!;
  return {
    version: 1,
    state: "available",
    complete: true,
    order: "oldest_to_newest",
    position: input.position,
    limit: input.limit,
    returned: visible.length,
    snapshot: input.snapshot,
    hasOlder: input.hasOlder,
    hasNewer: input.hasNewer,
    olderCursor: input.hasOlder
      ? encodeInboxThreadMessageCursor({
          version: 1,
          threadId: input.threadId,
          limit: input.limit,
          direction: "older",
          anchorCreatedAt: oldest.createdAt,
          anchorId: oldest.id,
          snapshotCreatedAt: input.snapshot.createdAt,
          snapshotId: input.snapshot.id,
        })
      : null,
    newerCursor: input.hasNewer
      ? encodeInboxThreadMessageCursor({
          version: 1,
          threadId: input.threadId,
          limit: input.limit,
          direction: "newer",
          anchorCreatedAt: newest.createdAt,
          anchorId: newest.id,
          snapshotCreatedAt: input.snapshot.createdAt,
          snapshotId: input.snapshot.id,
        })
      : null,
  };
}

/**
 * Pure reference implementation used by contract tests. Production uses the
 * same cursor boundaries in SQL so it never has to load the full thread.
 */
export function paginateInboxThreadMessageKeys(input: {
  threadId: string;
  keys: InboxThreadMessageKey[];
  limit?: number;
  cursor?: InboxThreadMessageCursor | null;
}):
  | {
      ok: true;
      keys: InboxThreadMessageKey[];
      page: InboxThreadMessagePageMetadata;
    }
  | { ok: false; error: "cursor_out_of_range" } {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_INBOX_THREAD_MESSAGE_LIMIT
  ) {
    throw new TypeError("Invalid reference pagination limit.");
  }

  const sorted = [...input.keys].sort(compareInboxThreadMessageKeys);
  const snapshot = input.cursor
    ? {
        createdAt: input.cursor.snapshotCreatedAt,
        id: input.cursor.snapshotId,
      }
    : (sorted.at(-1) ?? null);
  if (!snapshot) {
    return {
      ok: true,
      keys: [],
      page: buildInboxThreadMessagePageMetadata({
        threadId: input.threadId,
        limit,
        visible: [],
        snapshot: null,
        position: "newest",
        hasOlder: false,
        hasNewer: false,
      }),
    };
  }

  const bounded = sorted.filter(
    (key) => compareInboxThreadMessageKeys(key, snapshot) <= 0,
  );
  const candidates = input.cursor
    ? bounded.filter((key) => {
        const anchor = {
          createdAt: input.cursor!.anchorCreatedAt,
          id: input.cursor!.anchorId,
        };
        const comparison = compareInboxThreadMessageKeys(key, anchor);
        return input.cursor!.direction === "older"
          ? comparison < 0
          : comparison > 0;
      })
    : bounded;
  const visible =
    input.cursor?.direction === "newer"
      ? candidates.slice(0, limit)
      : candidates.slice(-limit);
  if (input.cursor && visible.length === 0) {
    return { ok: false, error: "cursor_out_of_range" };
  }

  const oldest = visible[0] ?? null;
  const newest = visible.at(-1) ?? null;
  const hasOlder = Boolean(
    oldest &&
      bounded.some((key) => compareInboxThreadMessageKeys(key, oldest) < 0),
  );
  const hasNewer = Boolean(
    newest &&
      bounded.some((key) => compareInboxThreadMessageKeys(key, newest) > 0),
  );
  return {
    ok: true,
    keys: visible,
    page: buildInboxThreadMessagePageMetadata({
      threadId: input.threadId,
      limit,
      visible,
      snapshot,
      position: input.cursor ? "history" : "newest",
      hasOlder,
      hasNewer,
    }),
  };
}
