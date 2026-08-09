const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/u;
const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_CURSOR_LENGTH = 1_200;

export type InboxThreadMessagePage = {
  version: 1;
  state: "empty" | "available";
  complete: true;
  order: "oldest_to_newest";
  position: "newest" | "history";
  limit: number;
  returned: number;
  snapshot: { createdAt: string; id: string } | null;
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor: string | null;
  newerCursor: string | null;
};

export type ParsedInboxThreadPage = {
  thread: Record<string, unknown>;
  participants: unknown[];
  messages: Array<Record<string, unknown>>;
  messagePage: InboxThreadMessagePage;
};

export type InboxConversationHrefInput = {
  queue?: string | null;
  status?: string | null;
  view?: string | null;
  threadId?: string | null;
  contactId?: string | null;
  channel?: string | null;
  q?: string | null;
  firstMessageFrom?: string | null;
  firstMessageTo?: string | null;
  lastMessageFrom?: string | null;
  lastMessageTo?: string | null;
  offset?: string | number | null;
  messageCursor?: string | readonly string[] | null;
  messageLimit?: string | number | readonly string[] | null;
};

export type InboxThreadRouteIdResult =
  | { ok: true; threadId: string }
  | {
      ok: false;
      status: 400 | 422;
      error: "thread_id_required" | "invalid_thread_id";
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

export function parseInboxThreadRouteId(
  value: string | null | undefined,
): InboxThreadRouteIdResult {
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

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isOpaqueCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CURSOR_LENGTH &&
    OPAQUE_CURSOR_PATTERN.test(value)
  );
}

function compareMessageKeys(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): number {
  const timestamp = normalizedInstant(left.createdAt).localeCompare(
    normalizedInstant(right.createdAt),
  );
  if (timestamp !== 0) return timestamp;
  return left.id.localeCompare(right.id);
}

function isSnapshot(
  value: unknown,
): value is { createdAt: string; id: string } {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).sort().join(",") === "createdAt,id" &&
    isExactIsoInstant(value["createdAt"]) &&
    typeof value["id"] === "string" &&
    UUID_PATTERN.test(value["id"])
  );
}

function isThreadShape(
  value: unknown,
  expectedThreadId: string,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (
    value["id"] !== expectedThreadId ||
    typeof value["status"] !== "string" ||
    typeof value["channel"] !== "string" ||
    !isNullableString(value["subject"]) ||
    !isNullableString(value["lastMessageAt"])
  ) {
    return false;
  }

  const contact = value["contact"];
  if (
    contact !== null &&
    (!isRecord(contact) ||
      typeof contact["id"] !== "string" ||
      typeof contact["name"] !== "string" ||
      !isNullableString(contact["email"]) ||
      !isNullableString(contact["phone"]))
  ) {
    return false;
  }
  const property = value["property"];
  if (
    property !== null &&
    (!isRecord(property) ||
      typeof property["id"] !== "string" ||
      typeof property["addressLine1"] !== "string" ||
      typeof property["city"] !== "string" ||
      typeof property["state"] !== "string" ||
      typeof property["postalCode"] !== "string")
  ) {
    return false;
  }
  return true;
}

function isMessageShape(
  value: unknown,
  expectedThreadId: string,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const mediaUrls = value["mediaUrls"];
  const metadata = value["metadata"];
  return (
    typeof value["id"] === "string" &&
    UUID_PATTERN.test(value["id"]) &&
    value["threadId"] === expectedThreadId &&
    typeof value["direction"] === "string" &&
    typeof value["channel"] === "string" &&
    typeof value["body"] === "string" &&
    isNullableString(value["subject"]) &&
    isNullableString(value["participantName"]) &&
    typeof value["deliveryStatus"] === "string" &&
    isExactIsoInstant(value["createdAt"]) &&
    Array.isArray(mediaUrls) &&
    mediaUrls.every((url) => typeof url === "string") &&
    (metadata === null || isRecord(metadata))
  );
}

function parseMessagePage(
  value: unknown,
  messages: Array<Record<string, unknown>>,
  expectedLimit: number,
  expectedPosition: "newest" | "history",
): InboxThreadMessagePage | null {
  if (!isRecord(value)) return null;
  if (
    !Number.isSafeInteger(expectedLimit) ||
    expectedLimit < 1 ||
    expectedLimit > 100 ||
    Object.keys(value).sort().join(",") !==
      "complete,hasNewer,hasOlder,limit,newerCursor,olderCursor,order,position,returned,snapshot,state,version" ||
    value["version"] !== 1 ||
    value["complete"] !== true ||
    value["order"] !== "oldest_to_newest" ||
    (value["position"] !== "newest" && value["position"] !== "history") ||
    (value["state"] !== "empty" && value["state"] !== "available") ||
    !Number.isSafeInteger(value["limit"]) ||
    Number(value["limit"]) < 1 ||
    Number(value["limit"]) > 100 ||
    Number(value["limit"]) !== expectedLimit ||
    !Number.isSafeInteger(value["returned"]) ||
    Number(value["returned"]) !== messages.length ||
    messages.length > Number(value["limit"]) ||
    typeof value["hasOlder"] !== "boolean" ||
    typeof value["hasNewer"] !== "boolean"
  ) {
    return null;
  }

  const hasOlder = value["hasOlder"];
  const hasNewer = value["hasNewer"];
  const olderCursor = value["olderCursor"];
  const newerCursor = value["newerCursor"];
  if (
    (hasOlder ? !isOpaqueCursor(olderCursor) : olderCursor !== null) ||
    (hasNewer ? !isOpaqueCursor(newerCursor) : newerCursor !== null) ||
    value["position"] !== expectedPosition ||
    (value["position"] === "newest" && hasNewer)
  ) {
    return null;
  }

  if (value["state"] === "empty") {
    if (
      messages.length !== 0 ||
      value["snapshot"] !== null ||
      hasOlder ||
      hasNewer ||
      value["position"] !== "newest"
    ) {
      return null;
    }
  } else {
    if (messages.length === 0 || !isSnapshot(value["snapshot"])) return null;
    const newest = messages.at(-1)!;
    if (
      compareMessageKeys(
        { createdAt: String(newest["createdAt"]), id: String(newest["id"]) },
        value["snapshot"],
      ) > 0 ||
      (value["position"] === "newest" &&
        compareMessageKeys(
          {
            createdAt: String(newest["createdAt"]),
            id: String(newest["id"]),
          },
          value["snapshot"],
        ) !== 0)
    ) {
      return null;
    }
  }

  return value as InboxThreadMessagePage;
}

export function parseInboxThreadPagePayload(
  payload: unknown,
  expectedThreadId: string,
  expectedLimit = 50,
  expectedPosition: "newest" | "history" = "newest",
): ParsedInboxThreadPage | null {
  if (!isRecord(payload) || payload["ok"] !== true) return null;
  const thread = payload["thread"];
  const participants = payload["participants"];
  const messages = payload["messages"];
  if (
    !isThreadShape(thread, expectedThreadId) ||
    !Array.isArray(participants) ||
    !Array.isArray(messages) ||
    !messages.every((message) => isMessageShape(message, expectedThreadId))
  ) {
    return null;
  }

  for (let index = 1; index < messages.length; index += 1) {
    const previous = messages[index - 1]!;
    const current = messages[index]!;
    if (
      compareMessageKeys(
        {
          createdAt: String(previous["createdAt"]),
          id: String(previous["id"]),
        },
        {
          createdAt: String(current["createdAt"]),
          id: String(current["id"]),
        },
      ) >= 0
    ) {
      return null;
    }
  }

  const messagePage = parseMessagePage(
    payload["messagePage"],
    messages,
    expectedLimit,
    expectedPosition,
  );
  return messagePage ? { thread, participants, messages, messagePage } : null;
}

function setOptional(
  params: URLSearchParams,
  key: string,
  value: string | number | readonly string[] | null | undefined,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number") {
    params.set(key, String(value));
    return;
  }
  for (const entry of value) params.append(key, entry);
}

export function buildInboxConversationQuery(
  input: InboxConversationHrefInput,
): URLSearchParams {
  const params = new URLSearchParams();
  setOptional(params, "inbox_queue", input.queue);
  setOptional(params, "inbox_status", input.status);
  if (input.view && input.view !== "all") {
    params.set("inbox_view", input.view);
  }
  setOptional(params, "threadId", input.threadId);
  setOptional(params, "contactId", input.contactId);
  setOptional(params, "channel", input.channel);
  setOptional(params, "inbox_q", input.q);
  setOptional(params, "inbox_first_from", input.firstMessageFrom);
  setOptional(params, "inbox_first_to", input.firstMessageTo);
  setOptional(params, "inbox_last_from", input.lastMessageFrom);
  setOptional(params, "inbox_last_to", input.lastMessageTo);

  const numericOffset =
    typeof input.offset === "number" &&
    Number.isFinite(input.offset) &&
    input.offset > 0
      ? Math.floor(input.offset)
      : null;
  const stringOffset =
    typeof input.offset === "string" && input.offset.trim().length > 0
      ? input.offset.trim()
      : null;
  setOptional(params, "inbox_offset", numericOffset ?? stringOffset);
  setOptional(params, "inbox_message_cursor", input.messageCursor);
  setOptional(params, "inbox_message_limit", input.messageLimit);
  return params;
}
