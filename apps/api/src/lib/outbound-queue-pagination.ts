import { createHash } from "node:crypto";

export const OUTBOUND_QUEUE_TIME_ZONE = "America/New_York" as const;
export const DEFAULT_OUTBOUND_QUEUE_LIMIT = 50;
export const MAX_OUTBOUND_QUEUE_LIMIT = 100;

const MAX_CURSOR_LENGTH = 1_200;
const MAX_FILTER_LENGTH = 160;
const MAX_DISPOSITION_LENGTH = 80;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_KEY_PATTERN =
  /^(?:account|contact):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OUTBOUND_QUEUE_QUERY_KEYS = new Set([
  "memberId",
  "limit",
  "cursor",
  "direction",
  "q",
  "campaign",
  "attempt",
  "due",
  "has",
  "disposition",
  "accountId",
  "taskId",
]);

export type OutboundDueFilter =
  | "all"
  | "overdue"
  | "due_now"
  | "today"
  | "not_started";
export type OutboundHasFilter = "any" | "phone" | "email" | "both";

export type OutboundQueueFilters = {
  q: string | null;
  campaign: string | null;
  attempt: number | null;
  due: OutboundDueFilter;
  has: OutboundHasFilter;
  disposition: string | null;
};

export type OutboundQueueCursor = {
  version: 1;
  memberId: string;
  filterFingerprint: string;
  snapshotAt: string;
  accountCreatedAt: string;
  accountKey: string;
  pageSize: number;
  position: number;
};

export type OutboundQueueRequest = {
  memberId: string;
  limit: number;
  direction: "next" | "previous";
  cursor: OutboundQueueCursor | null;
  snapshotAt: Date;
  offset: number;
  filters: OutboundQueueFilters;
};

export type OutboundQueueRequestResult =
  | { ok: true; query: OutboundQueueRequest }
  | { ok: false; field: string; message: string };

export type OutboundQueueSelection = {
  accountId: string | null;
  taskId: string | null;
};

export type OutboundQueueSelectionResult =
  | { ok: true; selection: OutboundQueueSelection }
  | { ok: false; field: "accountId" | "taskId"; message: string };

function exactIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function readOne(
  params: URLSearchParams,
  field: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const values = params.getAll(field);
  if (values.length > 1) {
    return { ok: false, message: `${field} may only be provided once.` };
  }
  return { ok: true, value: values[0] ?? null };
}

function readText(
  params: URLSearchParams,
  field: string,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const result = readOne(params, field);
  if (!result.ok) return result;
  if (result.value === null) return result;
  if (
    result.value.length > maxLength ||
    containsControlCharacter(result.value)
  ) {
    return {
      ok: false,
      message: `${field} must be ${maxLength} characters or fewer and cannot contain control characters.`,
    };
  }
  const value = normalizeText(result.value);
  if (value.length > maxLength) {
    return {
      ok: false,
      message: `${field} is longer than the supported normalized limit.`,
    };
  }
  return { ok: true, value: value || null };
}

export function outboundQueueFilterFingerprint(input: {
  memberId: string;
  filters: OutboundQueueFilters;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        memberId: input.memberId.toLowerCase(),
        q: input.filters.q,
        campaign: input.filters.campaign,
        attempt: input.filters.attempt,
        due: input.filters.due,
        has: input.filters.has,
        disposition: input.filters.disposition,
      }),
      "utf8",
    )
    .digest("base64url");
}

export function encodeOutboundQueueCursor(
  input: Omit<OutboundQueueCursor, "version">,
): string {
  const cursor: OutboundQueueCursor = { version: 1, ...input };
  if (
    !UUID_PATTERN.test(cursor.memberId) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(cursor.filterFingerprint) ||
    !exactIsoInstant(cursor.snapshotAt) ||
    !exactIsoInstant(cursor.accountCreatedAt) ||
    !ACCOUNT_KEY_PATTERN.test(cursor.accountKey) ||
    !Number.isSafeInteger(cursor.pageSize) ||
    cursor.pageSize < 1 ||
    cursor.pageSize > MAX_OUTBOUND_QUEUE_LIMIT ||
    !Number.isSafeInteger(cursor.position) ||
    cursor.position < 0
  ) {
    throw new TypeError("Cannot encode an invalid outbound queue cursor.");
  }
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeOutboundQueueCursor(
  value: string,
): OutboundQueueCursor | null {
  if (
    !value ||
    value.length > MAX_CURSOR_LENGTH ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      !parsed ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !==
        "accountCreatedAt,accountKey,filterFingerprint,memberId,pageSize,position,snapshotAt,version" ||
      parsed["version"] !== 1 ||
      typeof parsed["memberId"] !== "string" ||
      !UUID_PATTERN.test(parsed["memberId"]) ||
      typeof parsed["filterFingerprint"] !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parsed["filterFingerprint"]) ||
      !exactIsoInstant(parsed["snapshotAt"]) ||
      !exactIsoInstant(parsed["accountCreatedAt"]) ||
      typeof parsed["accountKey"] !== "string" ||
      !ACCOUNT_KEY_PATTERN.test(parsed["accountKey"]) ||
      !Number.isSafeInteger(parsed["pageSize"]) ||
      Number(parsed["pageSize"]) < 1 ||
      Number(parsed["pageSize"]) > MAX_OUTBOUND_QUEUE_LIMIT ||
      !Number.isSafeInteger(parsed["position"]) ||
      Number(parsed["position"]) < 0
    ) {
      return null;
    }
    return parsed as OutboundQueueCursor;
  } catch {
    return null;
  }
}

function invalid(field: string, message: string): OutboundQueueRequestResult {
  return { ok: false, field, message };
}

export function parseOutboundQueueSelection(
  searchParams: URLSearchParams,
): OutboundQueueSelectionResult {
  for (const field of ["accountId", "taskId"] as const) {
    const result = readOne(searchParams, field);
    if (!result.ok) {
      return { ok: false, field, message: result.message };
    }
    const value = result.value?.trim() ?? "";
    if (value && !UUID_PATTERN.test(value)) {
      return {
        ok: false,
        field,
        message: `${field} must be a valid UUID.`,
      };
    }
  }

  return {
    ok: true,
    selection: {
      accountId: searchParams.get("accountId")?.trim().toLowerCase() || null,
      taskId: searchParams.get("taskId")?.trim().toLowerCase() || null,
    },
  };
}

export function parseOutboundQueueRequest(input: {
  searchParams: URLSearchParams;
  defaultMemberId: string | null;
  now?: Date;
}): OutboundQueueRequestResult {
  for (const key of input.searchParams.keys()) {
    if (!OUTBOUND_QUEUE_QUERY_KEYS.has(key)) {
      return invalid(key, `Unsupported outbound queue parameter: ${key}.`);
    }
  }

  const selection = parseOutboundQueueSelection(input.searchParams);
  if (!selection.ok) return invalid(selection.field, selection.message);

  const memberResult = readOne(input.searchParams, "memberId");
  if (!memberResult.ok) return invalid("memberId", memberResult.message);
  const memberId = (
    memberResult.value?.trim() ||
    input.defaultMemberId ||
    ""
  ).toLowerCase();
  if (!UUID_PATTERN.test(memberId)) {
    return invalid(
      "memberId",
      "Choose an active assignee before loading the outbound queue.",
    );
  }

  const limitResult = readOne(input.searchParams, "limit");
  if (!limitResult.ok) return invalid("limit", limitResult.message);
  let limit = DEFAULT_OUTBOUND_QUEUE_LIMIT;
  if (limitResult.value !== null) {
    if (!/^[1-9]\d{0,2}$/u.test(limitResult.value)) {
      return invalid("limit", "limit must be a positive whole number.");
    }
    limit = Number(limitResult.value);
    if (limit > MAX_OUTBOUND_QUEUE_LIMIT) {
      return invalid(
        "limit",
        `limit must be between 1 and ${MAX_OUTBOUND_QUEUE_LIMIT}.`,
      );
    }
  }

  const q = readText(input.searchParams, "q", MAX_FILTER_LENGTH);
  if (!q.ok) return invalid("q", q.message);
  const campaign = readText(input.searchParams, "campaign", MAX_FILTER_LENGTH);
  if (!campaign.ok) return invalid("campaign", campaign.message);
  const disposition = readText(
    input.searchParams,
    "disposition",
    MAX_DISPOSITION_LENGTH,
  );
  if (!disposition.ok) return invalid("disposition", disposition.message);

  const dueResult = readText(input.searchParams, "due", 24);
  if (!dueResult.ok) return invalid("due", dueResult.message);
  const due = dueResult.value ?? "all";
  if (!["all", "overdue", "due_now", "today", "not_started"].includes(due)) {
    return invalid("due", "due is not a supported outbound queue filter.");
  }

  const hasResult = readText(input.searchParams, "has", 16);
  if (!hasResult.ok) return invalid("has", hasResult.message);
  const has = hasResult.value ?? "any";
  if (!["any", "phone", "email", "both"].includes(has)) {
    return invalid("has", "has must be any, phone, email, or both.");
  }

  const attemptResult = readOne(input.searchParams, "attempt");
  if (!attemptResult.ok) return invalid("attempt", attemptResult.message);
  let attempt: number | null = null;
  if (attemptResult.value !== null && attemptResult.value.trim()) {
    const rawAttempt = attemptResult.value.trim();
    if (!/^[1-9]\d{0,8}$/u.test(rawAttempt)) {
      return invalid("attempt", "attempt must be a positive whole number.");
    }
    attempt = Number(rawAttempt);
  }

  const filters: OutboundQueueFilters = {
    q: q.value,
    campaign: campaign.value,
    attempt,
    due: due as OutboundDueFilter,
    has: has as OutboundHasFilter,
    disposition: disposition.value,
  };

  const directionResult = readText(input.searchParams, "direction", 16);
  if (!directionResult.ok) {
    return invalid("direction", directionResult.message);
  }
  const direction = directionResult.value ?? "next";
  if (direction !== "next" && direction !== "previous") {
    return invalid("direction", "direction must be next or previous.");
  }

  const cursorResult = readOne(input.searchParams, "cursor");
  if (!cursorResult.ok) return invalid("cursor", cursorResult.message);
  if (cursorResult.value === "") {
    return invalid("cursor", "The outbound queue cursor cannot be empty.");
  }
  const cursor = cursorResult.value
    ? decodeOutboundQueueCursor(cursorResult.value)
    : null;
  if (cursorResult.value && !cursor) {
    return invalid(
      "cursor",
      "The outbound queue cursor is invalid. Reset the filters and try again.",
    );
  }
  if (direction === "previous" && !cursor) {
    return invalid("direction", "A cursor is required for previous pages.");
  }

  const fingerprint = outboundQueueFilterFingerprint({ memberId, filters });
  if (
    cursor &&
    (cursor.memberId !== memberId ||
      cursor.filterFingerprint !== fingerprint ||
      cursor.pageSize !== limit)
  ) {
    return invalid(
      "cursor",
      "The outbound queue cursor does not match these filters or assignee. Reset the queue and try again.",
    );
  }

  const now = input.now ?? new Date();
  const snapshotAt = cursor ? new Date(cursor.snapshotAt) : now;
  if (
    Number.isNaN(snapshotAt.getTime()) ||
    snapshotAt.getTime() > now.getTime() + 60_000
  ) {
    return invalid(
      "cursor",
      "The outbound queue cursor has an invalid snapshot.",
    );
  }

  return {
    ok: true,
    query: {
      memberId,
      limit,
      direction,
      cursor,
      snapshotAt,
      offset: cursor?.position ?? 0,
      filters,
    },
  };
}

export function escapedOutboundSearchPattern(value: string): string {
  return `%${value.replace(/[!%_]/gu, (match) => `!${match}`)}%`;
}
