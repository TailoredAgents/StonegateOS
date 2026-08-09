import { createHash } from "node:crypto";

export const SALES_ACTIVITY_DEFAULT_LIMIT = 50;
export const MAX_SALES_ACTIVITY_LIMIT = 200;

const MAX_CURSOR_LENGTH = 1_600;
const MAX_DECODED_CURSOR_BYTES = 1_200;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const FILTER_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/u;

export const SALES_ACTIVITY_DEFAULT_ACTIONS = [
  "call.started",
  "message.received",
  "message.queued",
  "message.retry",
  "sales.escalation.call.started",
  "sales.escalation.call.dispatched",
  "sales.escalation.call.connected",
  "sales.escalation.call.not_connected",
  "sales.escalation.call.not_dispatched",
  "sales.escalation.call.reconciliation_required",
  "sales.touch.manual",
  "sales.disposition.set",
  "sales.autopilot.draft_created",
  "sales.autopilot.autosend",
  "sales.agent.draft.prepared",
  "sales.agent.draft.reused",
  "sales.agent.draft.skipped",
  "sales.agent.autosend.queued",
  "sales.agent.autosend.skipped",
  "inbox.alert.sent",
  "inbox.alert.failed",
  "crm.reminder.created",
  "crm.reminder.updated",
  "crm.reminder.completed",
  "crm.reminder.sent",
  "crm.reminder.failed",
] as const;

export const SALES_ACTIVITY_ACTIONS: ReadonlySet<string> = new Set(
  SALES_ACTIVITY_DEFAULT_ACTIONS,
);

const QUERY_KEYS = new Set([
  "actions",
  "actorId",
  "cursor",
  "limit",
  "memberId",
  "rangeDays",
]);

export type SalesActivityKey = {
  createdAt: string;
  id: string;
};

export type SalesActivityCursor = {
  version: 1;
  limit: number;
  direction: "older" | "newer";
  filterHash: string;
  windowStart: string;
  snapshotAt: string;
  snapshotCreatedAt: string;
  snapshotId: string;
  anchorCreatedAt: string;
  anchorId: string;
};

export type SalesActivityQuery = {
  limit: number;
  rangeDays: number;
  actorId: string | null;
  actions: string[];
  filterHash: string;
  cursor: SalesActivityCursor | null;
};

export type SalesActivityQueryResult =
  | { ok: true; query: SalesActivityQuery }
  | { ok: false; field: string; message: string };

export type SalesActivityPageMetadata = {
  version: 1;
  state: "empty" | "available";
  complete: true;
  order: "newest_to_oldest";
  position: "newest" | "history";
  limit: number;
  returned: number;
  totalAtSnapshot: number;
  windowStart: string;
  asOf: string;
  snapshot: SalesActivityKey | null;
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

function isSalesActivityKey(value: unknown): value is SalesActivityKey {
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

export function compareSalesActivityKeys(
  left: SalesActivityKey,
  right: SalesActivityKey,
): number {
  const timestamp = normalizedInstant(left.createdAt).localeCompare(
    normalizedInstant(right.createdAt),
  );
  if (timestamp !== 0) return timestamp;
  return left.id.localeCompare(right.id);
}

export function salesActivityFilterHash(input: {
  rangeDays: number;
  actorId: string | null;
  actions: readonly string[];
}): string {
  const canonical = JSON.stringify({
    version: 1,
    rangeDays: input.rangeDays,
    actorId: input.actorId?.toLowerCase() ?? null,
    actions: [...input.actions].sort(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function cursorWindowIsValid(cursor: SalesActivityCursor): boolean {
  const windowStart = new Date(cursor.windowStart).getTime();
  const snapshotAt = new Date(cursor.snapshotAt).getTime();
  return (
    Number.isFinite(windowStart) &&
    Number.isFinite(snapshotAt) &&
    windowStart <= snapshotAt &&
    normalizedInstant(cursor.snapshotCreatedAt) >=
      normalizedInstant(cursor.windowStart) &&
    normalizedInstant(cursor.snapshotCreatedAt) <=
      normalizedInstant(cursor.snapshotAt) &&
    normalizedInstant(cursor.anchorCreatedAt) >=
      normalizedInstant(cursor.windowStart) &&
    compareSalesActivityKeys(
      { createdAt: cursor.anchorCreatedAt, id: cursor.anchorId },
      { createdAt: cursor.snapshotCreatedAt, id: cursor.snapshotId },
    ) <= 0
  );
}

export function encodeSalesActivityCursor(cursor: SalesActivityCursor): string {
  if (
    cursor.version !== 1 ||
    !Number.isSafeInteger(cursor.limit) ||
    cursor.limit < 1 ||
    cursor.limit > MAX_SALES_ACTIVITY_LIMIT ||
    (cursor.direction !== "older" && cursor.direction !== "newer") ||
    !FILTER_HASH_PATTERN.test(cursor.filterHash) ||
    !isExactIsoInstant(cursor.windowStart) ||
    !isExactIsoInstant(cursor.snapshotAt) ||
    !isExactIsoInstant(cursor.snapshotCreatedAt) ||
    !UUID_PATTERN.test(cursor.snapshotId) ||
    !isExactIsoInstant(cursor.anchorCreatedAt) ||
    !UUID_PATTERN.test(cursor.anchorId) ||
    !cursorWindowIsValid(cursor)
  ) {
    throw new TypeError("Cannot encode an invalid Sales Activity cursor.");
  }
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeSalesActivityCursor(
  value: string,
): SalesActivityCursor | null {
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
        "anchorCreatedAt,anchorId,direction,filterHash,limit,snapshotAt,snapshotCreatedAt,snapshotId,version,windowStart" ||
      parsed["version"] !== 1 ||
      typeof parsed["limit"] !== "number" ||
      !Number.isSafeInteger(parsed["limit"]) ||
      parsed["limit"] < 1 ||
      parsed["limit"] > MAX_SALES_ACTIVITY_LIMIT ||
      (parsed["direction"] !== "older" && parsed["direction"] !== "newer") ||
      typeof parsed["filterHash"] !== "string" ||
      !FILTER_HASH_PATTERN.test(parsed["filterHash"]) ||
      !isExactIsoInstant(parsed["windowStart"]) ||
      !isExactIsoInstant(parsed["snapshotAt"]) ||
      !isExactIsoInstant(parsed["snapshotCreatedAt"]) ||
      typeof parsed["snapshotId"] !== "string" ||
      !UUID_PATTERN.test(parsed["snapshotId"]) ||
      !isExactIsoInstant(parsed["anchorCreatedAt"]) ||
      typeof parsed["anchorId"] !== "string" ||
      !UUID_PATTERN.test(parsed["anchorId"])
    ) {
      return null;
    }
    const cursor = parsed as SalesActivityCursor;
    if (
      !cursorWindowIsValid(cursor) ||
      encodeSalesActivityCursor(cursor) !== value
    ) {
      return null;
    }
    return cursor;
  } catch {
    return null;
  }
}

function oneValue(
  params: URLSearchParams,
  key: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const values = params.getAll(key);
  return values.length <= 1
    ? { ok: true, value: values[0] ?? null }
    : { ok: false, message: `${key} may only be provided once.` };
}

function positiveInteger(
  value: string | null,
  fallback: number,
  maximum: number,
): number | null {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

export function parseSalesActivityQuery(
  params: URLSearchParams,
): SalesActivityQueryResult {
  for (const key of params.keys()) {
    if (!QUERY_KEYS.has(key)) {
      return {
        ok: false,
        field: key,
        message: `Unsupported sales-activity parameter: ${key}.`,
      };
    }
  }

  const values = new Map<string, string | null>();
  for (const key of QUERY_KEYS) {
    const result = oneValue(params, key);
    if (!result.ok) return { ok: false, field: key, message: result.message };
    values.set(key, result.value);
  }

  const limit = positiveInteger(
    values.get("limit") ?? null,
    SALES_ACTIVITY_DEFAULT_LIMIT,
    MAX_SALES_ACTIVITY_LIMIT,
  );
  if (limit === null) {
    return {
      ok: false,
      field: "limit",
      message: `limit must be a whole number from 1 through ${MAX_SALES_ACTIVITY_LIMIT}.`,
    };
  }
  const rangeDays = positiveInteger(values.get("rangeDays") ?? null, 7, 90);
  if (rangeDays === null) {
    return {
      ok: false,
      field: "rangeDays",
      message: "rangeDays must be a whole number from 1 through 90.",
    };
  }

  const memberId = values.get("memberId") ?? null;
  const actorIdAlias = values.get("actorId") ?? null;
  if (memberId !== null && actorIdAlias !== null) {
    return {
      ok: false,
      field: "memberId",
      message: "Use memberId or actorId, not both.",
    };
  }
  const rawActorId = memberId ?? actorIdAlias;
  if (rawActorId !== null && !UUID_PATTERN.test(rawActorId)) {
    return {
      ok: false,
      field: memberId !== null ? "memberId" : "actorId",
      message: "Choose a valid team member.",
    };
  }
  const actorId = rawActorId?.toLowerCase() ?? null;

  const actionsRaw = values.get("actions") ?? null;
  let actions: string[] = [...SALES_ACTIVITY_DEFAULT_ACTIONS];
  if (actionsRaw !== null) {
    actions = actionsRaw.split(",").map((entry) => entry.trim());
    const distinct = new Set(actions);
    if (
      actions.length === 0 ||
      actions.length > SALES_ACTIVITY_DEFAULT_ACTIONS.length ||
      actions.some((entry) => !entry || !SALES_ACTIVITY_ACTIONS.has(entry)) ||
      distinct.size !== actions.length
    ) {
      return {
        ok: false,
        field: "actions",
        message: "actions contains an unknown, empty, or duplicate event type.",
      };
    }
  }

  const filterHash = salesActivityFilterHash({ rangeDays, actorId, actions });
  const cursorRaw = values.get("cursor") ?? null;
  if (cursorRaw !== null && cursorRaw.length === 0) {
    return {
      ok: false,
      field: "cursor",
      message: "The Sales Activity cursor cannot be empty.",
    };
  }
  const cursor = cursorRaw ? decodeSalesActivityCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return {
      ok: false,
      field: "cursor",
      message:
        "The Sales Activity cursor is invalid. Return to the newest activity and try again.",
    };
  }
  if (cursor && cursor.limit !== limit) {
    return {
      ok: false,
      field: "cursor",
      message:
        "The Sales Activity cursor was created for a different page size. Return to the newest activity.",
    };
  }
  if (cursor && cursor.filterHash !== filterHash) {
    return {
      ok: false,
      field: "cursor",
      message:
        "The Sales Activity cursor belongs to different filters. Return to the newest activity.",
    };
  }
  if (cursor) {
    const expectedWindowStart = new Date(
      new Date(cursor.snapshotAt).getTime() - rangeDays * 86_400_000,
    ).toISOString();
    if (
      normalizedInstant(cursor.windowStart) !==
      normalizedInstant(expectedWindowStart)
    ) {
      return {
        ok: false,
        field: "cursor",
        message:
          "The Sales Activity cursor has an invalid time window. Return to the newest activity.",
      };
    }
  }

  return {
    ok: true,
    query: { limit, rangeDays, actorId, actions, filterHash, cursor },
  };
}

export function buildSalesActivityPageMetadata(input: {
  limit: number;
  filterHash: string;
  windowStart: string;
  snapshotAt: string;
  snapshot: SalesActivityKey | null;
  visible: SalesActivityKey[];
  position: "newest" | "history";
  totalAtSnapshot: number;
  hasOlder: boolean;
  hasNewer: boolean;
}): SalesActivityPageMetadata {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_SALES_ACTIVITY_LIMIT ||
    !FILTER_HASH_PATTERN.test(input.filterHash) ||
    !isExactIsoInstant(input.windowStart) ||
    !isExactIsoInstant(input.snapshotAt) ||
    !Number.isSafeInteger(input.totalAtSnapshot) ||
    input.totalAtSnapshot < input.visible.length
  ) {
    throw new TypeError("Cannot describe invalid Sales Activity paging state.");
  }
  if (input.visible.length === 0) {
    if (
      input.snapshot ||
      input.position !== "newest" ||
      input.totalAtSnapshot !== 0 ||
      input.hasOlder ||
      input.hasNewer
    ) {
      throw new TypeError(
        "An empty Sales Activity page cannot have paging state.",
      );
    }
    return {
      version: 1,
      state: "empty",
      complete: true,
      order: "newest_to_oldest",
      position: "newest",
      limit: input.limit,
      returned: 0,
      totalAtSnapshot: 0,
      windowStart: input.windowStart,
      asOf: input.snapshotAt,
      snapshot: null,
      hasOlder: false,
      hasNewer: false,
      olderCursor: null,
      newerCursor: null,
    };
  }
  if (!input.snapshot || !isSalesActivityKey(input.snapshot)) {
    throw new TypeError("A non-empty Sales Activity page needs a snapshot.");
  }
  if (
    input.visible.length > input.limit ||
    input.visible.some((key, index) => {
      return (
        !isSalesActivityKey(key) ||
        (index > 0 &&
          compareSalesActivityKeys(input.visible[index - 1]!, key) <= 0) ||
        compareSalesActivityKeys(key, input.snapshot!) > 0
      );
    }) ||
    normalizedInstant(input.snapshot.createdAt) <
      normalizedInstant(input.windowStart) ||
    normalizedInstant(input.snapshot.createdAt) >
      normalizedInstant(input.snapshotAt)
  ) {
    throw new TypeError("Cannot describe an invalid Sales Activity page.");
  }

  const newest = input.visible[0]!;
  const oldest = input.visible.at(-1)!;
  const common = {
    version: 1 as const,
    limit: input.limit,
    filterHash: input.filterHash,
    windowStart: input.windowStart,
    snapshotAt: input.snapshotAt,
    snapshotCreatedAt: input.snapshot.createdAt,
    snapshotId: input.snapshot.id,
  };
  return {
    version: 1,
    state: "available",
    complete: true,
    order: "newest_to_oldest",
    position: input.position,
    limit: input.limit,
    returned: input.visible.length,
    totalAtSnapshot: input.totalAtSnapshot,
    windowStart: input.windowStart,
    asOf: input.snapshotAt,
    snapshot: input.snapshot,
    hasOlder: input.hasOlder,
    hasNewer: input.hasNewer,
    olderCursor: input.hasOlder
      ? encodeSalesActivityCursor({
          ...common,
          direction: "older",
          anchorCreatedAt: oldest.createdAt,
          anchorId: oldest.id,
        })
      : null,
    newerCursor: input.hasNewer
      ? encodeSalesActivityCursor({
          ...common,
          direction: "newer",
          anchorCreatedAt: newest.createdAt,
          anchorId: newest.id,
        })
      : null,
  };
}

/** Pure reference used to prove the SQL cursor boundaries and concurrency rules. */
export function paginateSalesActivityKeys(input: {
  keys: SalesActivityKey[];
  filterHash: string;
  snapshotAt: string;
  rangeDays: number;
  limit?: number;
  cursor?: SalesActivityCursor | null;
}):
  | {
      ok: true;
      keys: SalesActivityKey[];
      page: SalesActivityPageMetadata;
    }
  | { ok: false; error: "cursor_out_of_range" } {
  const limit = input.limit ?? SALES_ACTIVITY_DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_SALES_ACTIVITY_LIMIT ||
    !Number.isSafeInteger(input.rangeDays) ||
    input.rangeDays < 1 ||
    input.rangeDays > 90 ||
    !isExactIsoInstant(input.snapshotAt) ||
    !FILTER_HASH_PATTERN.test(input.filterHash)
  ) {
    throw new TypeError("Invalid reference Sales Activity pagination input.");
  }

  const snapshotAt = input.cursor?.snapshotAt ?? input.snapshotAt;
  const windowStart =
    input.cursor?.windowStart ??
    new Date(
      new Date(snapshotAt).getTime() - input.rangeDays * 86_400_000,
    ).toISOString();
  const sorted = [...input.keys]
    .filter(
      (key) =>
        isSalesActivityKey(key) &&
        normalizedInstant(key.createdAt) >= normalizedInstant(windowStart) &&
        normalizedInstant(key.createdAt) <= normalizedInstant(snapshotAt),
    )
    .sort(compareSalesActivityKeys);
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
      page: buildSalesActivityPageMetadata({
        limit,
        filterHash: input.filterHash,
        windowStart,
        snapshotAt,
        snapshot: null,
        visible: [],
        position: "newest",
        totalAtSnapshot: 0,
        hasOlder: false,
        hasNewer: false,
      }),
    };
  }

  const bounded = sorted.filter(
    (key) => compareSalesActivityKeys(key, snapshot) <= 0,
  );
  if (
    input.cursor &&
    (!bounded.some((key) => compareSalesActivityKeys(key, snapshot) === 0) ||
      !bounded.some(
        (key) =>
          compareSalesActivityKeys(key, {
            createdAt: input.cursor!.anchorCreatedAt,
            id: input.cursor!.anchorId,
          }) === 0,
      ))
  ) {
    return { ok: false, error: "cursor_out_of_range" };
  }

  const candidates = input.cursor
    ? bounded.filter((key) => {
        const comparison = compareSalesActivityKeys(key, {
          createdAt: input.cursor!.anchorCreatedAt,
          id: input.cursor!.anchorId,
        });
        return input.cursor!.direction === "older"
          ? comparison < 0
          : comparison > 0;
      })
    : bounded;
  const requested =
    input.cursor?.direction === "newer"
      ? candidates.slice(0, limit)
      : candidates.slice(-limit);
  const visible = [...requested].reverse();
  if (input.cursor && visible.length === 0) {
    return { ok: false, error: "cursor_out_of_range" };
  }
  const hasExtra = candidates.length > limit;
  const hasOlder = input.cursor?.direction === "newer" ? true : hasExtra;
  const hasNewer =
    input.cursor?.direction === "older"
      ? true
      : input.cursor?.direction === "newer"
        ? hasExtra
        : false;

  return {
    ok: true,
    keys: visible,
    page: buildSalesActivityPageMetadata({
      limit,
      filterHash: input.filterHash,
      windowStart,
      snapshotAt,
      snapshot,
      visible,
      position: input.cursor ? "history" : "newest",
      totalAtSnapshot: bounded.length,
      hasOlder,
      hasNewer,
    }),
  };
}
