import { createHash } from "node:crypto";

export const PARTNER_DEFAULT_LIMIT = 50;
export const PARTNER_MAX_LIMIT = 100;

const MAX_CURSOR_LENGTH = 1_600;
const MAX_DECODED_CURSOR_BYTES = 1_200;
const MAX_SNAPSHOT_TOTAL = 100_000_000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const FILTER_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const NUMERIC_SORT_PATTERN = /^-?\d{1,24}(?:\.\d{1,12})?$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const QUERY_KEYS = new Set([
  "cursor",
  "limit",
  "ownerId",
  "q",
  "status",
  "type",
]);
const PARTNER_STATUSES = new Set([
  "partner",
  "prospect",
  "contacted",
  "inactive",
  "none",
]);

export type PartnerStatus =
  | "partner"
  | "prospect"
  | "contacted"
  | "inactive"
  | "none";

export type PartnerSortKey = {
  nextSort: string;
  lastSort: string;
  id: string;
};

export type PartnerCursor = PartnerSortKey & {
  version: 1;
  direction: "next" | "previous";
  limit: number;
  filterHash: string;
  snapshotAt: string;
  totalAtSnapshot: number;
};

export type PartnerListQuery = {
  status: PartnerStatus;
  ownerId: string | null;
  type: string | null;
  q: string | null;
  limit: number;
  filterHash: string;
  cursor: PartnerCursor | null;
};

export type PartnerListQueryResult =
  | { ok: true; query: PartnerListQuery }
  | { ok: false; field: string; message: string };

export type PartnerPageMetadata = {
  version: 1;
  complete: true;
  order: "next_touch_ascending";
  position: "start" | "history";
  limit: number;
  returned: number;
  totalAtSnapshot: number;
  asOf: string;
  hasPrevious: boolean;
  hasNext: boolean;
  previousCursor: string | null;
  nextCursor: string | null;
};

function invalid(field: string, message: string): PartnerListQueryResult {
  return { ok: false, field, message };
}

function isExactIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function oneValue(
  params: URLSearchParams,
  key: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const values = params.getAll(key);
  if (values.length > 1) {
    return { ok: false, message: `${key} may only be provided once.` };
  }
  return { ok: true, value: values[0] ?? null };
}

function textFilter(
  params: URLSearchParams,
  key: string,
  maximum: number,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const result = oneValue(params, key);
  if (!result.ok) return result;
  if (result.value === null) return { ok: true, value: null };
  if (result.value.length > maximum || containsControlCharacter(result.value)) {
    return {
      ok: false,
      message: `${key} must be at most ${maximum} characters and contain no control characters.`,
    };
  }
  const normalized = normalizeText(result.value);
  if (normalized.length > maximum) {
    return {
      ok: false,
      message: `${key} is longer than the supported normalized limit.`,
    };
  }
  return { ok: true, value: normalized || null };
}

export function partnerFilterHash(input: {
  status: PartnerStatus;
  ownerId: string | null;
  type: string | null;
  q: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        status: input.status,
        ownerId: input.ownerId,
        type: input.type,
        q: input.q,
      }),
      "utf8",
    )
    .digest("hex");
}

function isPartnerSortKey(value: unknown): value is PartnerSortKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "id,lastSort,nextSort" &&
    typeof record["nextSort"] === "string" &&
    NUMERIC_SORT_PATTERN.test(record["nextSort"]) &&
    typeof record["lastSort"] === "string" &&
    NUMERIC_SORT_PATTERN.test(record["lastSort"]) &&
    typeof record["id"] === "string" &&
    UUID_PATTERN.test(record["id"])
  );
}

export function comparePartnerSortKeys(
  left: PartnerSortKey,
  right: PartnerSortKey,
): number {
  const nextDifference = Number(left.nextSort) - Number(right.nextSort);
  if (nextDifference !== 0) return Math.sign(nextDifference);
  const lastDifference = Number(left.lastSort) - Number(right.lastSort);
  if (lastDifference !== 0) return Math.sign(lastDifference);
  return left.id.localeCompare(right.id);
}

export function encodePartnerCursor(cursor: PartnerCursor): string {
  if (
    cursor.version !== 1 ||
    (cursor.direction !== "next" && cursor.direction !== "previous") ||
    !Number.isSafeInteger(cursor.limit) ||
    cursor.limit < 1 ||
    cursor.limit > PARTNER_MAX_LIMIT ||
    !FILTER_HASH_PATTERN.test(cursor.filterHash) ||
    !isExactIsoInstant(cursor.snapshotAt) ||
    !Number.isSafeInteger(cursor.totalAtSnapshot) ||
    cursor.totalAtSnapshot < 0 ||
    cursor.totalAtSnapshot > MAX_SNAPSHOT_TOTAL ||
    !isPartnerSortKey({
      nextSort: cursor.nextSort,
      lastSort: cursor.lastSort,
      id: cursor.id,
    })
  ) {
    throw new TypeError("Cannot encode an invalid partner cursor.");
  }
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodePartnerCursor(value: string): PartnerCursor | null {
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
        "direction,filterHash,id,lastSort,limit,nextSort,snapshotAt,totalAtSnapshot,version"
    ) {
      return null;
    }
    const cursor = parsed as PartnerCursor;
    if (
      cursor.version !== 1 ||
      (cursor.direction !== "next" && cursor.direction !== "previous") ||
      typeof cursor.limit !== "number" ||
      !Number.isSafeInteger(cursor.limit) ||
      cursor.limit < 1 ||
      cursor.limit > PARTNER_MAX_LIMIT ||
      typeof cursor.filterHash !== "string" ||
      !FILTER_HASH_PATTERN.test(cursor.filterHash) ||
      !isExactIsoInstant(cursor.snapshotAt) ||
      typeof cursor.totalAtSnapshot !== "number" ||
      !Number.isSafeInteger(cursor.totalAtSnapshot) ||
      cursor.totalAtSnapshot < 0 ||
      cursor.totalAtSnapshot > MAX_SNAPSHOT_TOTAL ||
      !isPartnerSortKey({
        nextSort: cursor.nextSort,
        lastSort: cursor.lastSort,
        id: cursor.id,
      }) ||
      encodePartnerCursor(cursor) !== value
    ) {
      return null;
    }
    return cursor;
  } catch {
    return null;
  }
}

export function parsePartnerListQuery(
  params: URLSearchParams,
  now = new Date(),
): PartnerListQueryResult {
  for (const key of params.keys()) {
    if (!QUERY_KEYS.has(key)) {
      return invalid(key, `Unsupported partner-list parameter: ${key}.`);
    }
  }

  const statusResult = textFilter(params, "status", 16);
  if (!statusResult.ok) return invalid("status", statusResult.message);
  const status = statusResult.value ?? "partner";
  if (!PARTNER_STATUSES.has(status)) {
    return invalid("status", "Choose a supported partner status.");
  }

  const ownerResult = textFilter(params, "ownerId", 36);
  if (!ownerResult.ok) return invalid("ownerId", ownerResult.message);
  if (ownerResult.value && !UUID_PATTERN.test(ownerResult.value)) {
    return invalid("ownerId", "Choose a valid partner owner.");
  }
  const ownerId = ownerResult.value?.toLowerCase() ?? null;

  const typeResult = textFilter(params, "type", 64);
  if (!typeResult.ok) return invalid("type", typeResult.message);
  const searchResult = textFilter(params, "q", 160);
  if (!searchResult.ok) return invalid("q", searchResult.message);

  const limitResult = oneValue(params, "limit");
  if (!limitResult.ok) return invalid("limit", limitResult.message);
  let limit = PARTNER_DEFAULT_LIMIT;
  if (limitResult.value !== null) {
    if (!/^[1-9]\d{0,2}$/u.test(limitResult.value)) {
      return invalid("limit", "limit must be a positive whole number.");
    }
    limit = Number(limitResult.value);
    if (!Number.isSafeInteger(limit) || limit > PARTNER_MAX_LIMIT) {
      return invalid(
        "limit",
        `limit must be between 1 and ${PARTNER_MAX_LIMIT}.`,
      );
    }
  }

  const filterHash = partnerFilterHash({
    status: status as PartnerStatus,
    ownerId,
    type: typeResult.value,
    q: searchResult.value,
  });
  const cursorResult = oneValue(params, "cursor");
  if (!cursorResult.ok) return invalid("cursor", cursorResult.message);
  if (cursorResult.value === "") {
    return invalid("cursor", "The partner cursor cannot be empty.");
  }
  const cursor = cursorResult.value
    ? decodePartnerCursor(cursorResult.value)
    : null;
  if (cursorResult.value && !cursor) {
    return invalid(
      "cursor",
      "The partner cursor is invalid. Reset the partner list and try again.",
    );
  }
  if (cursor && cursor.limit !== limit) {
    return invalid(
      "limit",
      "The partner cursor was created for a different page size.",
    );
  }
  if (cursor && cursor.filterHash !== filterHash) {
    return invalid(
      "cursor",
      "The partner filters changed. Reset pagination before continuing.",
    );
  }
  if (cursor) {
    const snapshotTime = new Date(cursor.snapshotAt).getTime();
    if (snapshotTime > now.getTime() + 5 * 60_000) {
      return invalid("cursor", "The partner cursor has a future snapshot.");
    }
  }

  return {
    ok: true,
    query: {
      status: status as PartnerStatus,
      ownerId,
      type: typeResult.value,
      q: searchResult.value,
      limit,
      filterHash,
      cursor,
    },
  };
}

export function buildPartnerPageMetadata(input: {
  limit: number;
  filterHash: string;
  snapshotAt: string;
  totalAtSnapshot: number;
  visible: PartnerSortKey[];
  position: "start" | "history";
  hasPrevious: boolean;
  hasNext: boolean;
}): PartnerPageMetadata {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > PARTNER_MAX_LIMIT ||
    !FILTER_HASH_PATTERN.test(input.filterHash) ||
    !isExactIsoInstant(input.snapshotAt) ||
    !Number.isSafeInteger(input.totalAtSnapshot) ||
    input.totalAtSnapshot < 0 ||
    input.totalAtSnapshot > MAX_SNAPSHOT_TOTAL ||
    input.visible.length > input.limit ||
    input.visible.some(
      (key, index) =>
        !isPartnerSortKey(key) ||
        (index > 0 &&
          comparePartnerSortKeys(input.visible[index - 1]!, key) >= 0),
    ) ||
    (input.visible.length === 0 &&
      (input.hasPrevious || input.hasNext || input.position !== "start"))
  ) {
    throw new TypeError("Cannot describe an invalid partner page.");
  }

  const first = input.visible[0] ?? null;
  const last = input.visible.at(-1) ?? null;
  const cursorBase = {
    version: 1 as const,
    limit: input.limit,
    filterHash: input.filterHash,
    snapshotAt: input.snapshotAt,
    totalAtSnapshot: input.totalAtSnapshot,
  };
  return {
    version: 1,
    complete: true,
    order: "next_touch_ascending",
    position: input.position,
    limit: input.limit,
    returned: input.visible.length,
    totalAtSnapshot: input.totalAtSnapshot,
    asOf: input.snapshotAt,
    hasPrevious: input.hasPrevious,
    hasNext: input.hasNext,
    previousCursor:
      input.hasPrevious && first
        ? encodePartnerCursor({
            ...cursorBase,
            ...first,
            direction: "previous",
          })
        : null,
    nextCursor:
      input.hasNext && last
        ? encodePartnerCursor({
            ...cursorBase,
            ...last,
            direction: "next",
          })
        : null,
  };
}
