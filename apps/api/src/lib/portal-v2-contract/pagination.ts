export const PORTAL_V2_DEFAULT_PAGE_LIMIT = 25;
export const PORTAL_V2_MAX_PAGE_LIMIT = 100;
export const PORTAL_V2_MAX_CURSOR_LENGTH = 2_048;
export const PORTAL_V2_MAX_DECODED_CURSOR_BYTES = 1_536;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const CURSOR_KIND_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 256;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 64;
const MAX_KEY_LENGTH = 64;
const MAX_STRING_LENGTH = 1_024;
const FORBIDDEN_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export type PortalV2Cursor<T> = Readonly<{
  version: 1;
  kind: string;
  limit: number;
  payload: T;
}>;

export type PortalV2PaginationResult<T> =
  | Readonly<{
      ok: true;
      limit: number;
      cursor: PortalV2Cursor<T> | null;
    }>
  | Readonly<{
      ok: false;
      error: "invalid_pagination";
      fieldErrors: Readonly<Record<string, string>>;
    }>;

type JsonPrimitive = null | boolean | number | string;
interface JsonArray {
  readonly [index: number]: JsonValue;
  readonly length: number;
  [Symbol.iterator](): ArrayIterator<JsonValue>;
}
interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonArray | JsonObject;

type NodeBudget = { count: number };

function canonicalJsonValue(
  value: unknown,
  depth: number,
  budget: NodeBudget,
): JsonValue {
  budget.count += 1;
  if (budget.count > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new TypeError("The cursor payload is too complex.");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      throw new TypeError("A cursor string is too long.");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("A cursor number is invalid.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw new TypeError("The cursor contains too many items.");
    }
    return Object.freeze(
      value.map((item) => canonicalJsonValue(item, depth + 1, budget)),
    );
  }
  if (typeof value === "object") {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("The cursor payload must be JSON-compatible.");
    }
    const keys = Object.keys(value).sort();
    if (keys.length > MAX_OBJECT_KEYS) {
      throw new TypeError("The cursor contains too many fields.");
    }
    const output: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (
        key.length === 0 ||
        key.length > MAX_KEY_LENGTH ||
        FORBIDDEN_OBJECT_KEYS.has(key)
      ) {
        throw new TypeError("A cursor field name is invalid.");
      }
      output[key] = canonicalJsonValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        budget,
      );
    }
    return Object.freeze(output);
  }
  throw new TypeError("The cursor payload must be JSON-compatible.");
}

function canonicalPayload(value: unknown): JsonValue {
  return canonicalJsonValue(value, 0, { count: 0 });
}

function validLimit(
  value: unknown,
  maximum = PORTAL_V2_MAX_PAGE_LIMIT,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= maximum
  );
}

/**
 * Produces a canonical opaque transport cursor. This encoding is not an
 * authorization token: endpoint payload validators must bind account, filter,
 * sort, and snapshot state before using decoded values in a query.
 */
export function encodePortalV2Cursor(input: {
  kind: string;
  limit: number;
  payload: unknown;
}): string {
  if (!CURSOR_KIND_PATTERN.test(input.kind)) {
    throw new TypeError("The cursor kind is invalid.");
  }
  if (!validLimit(input.limit)) {
    throw new TypeError("The cursor page limit is invalid.");
  }
  const encodedJson = JSON.stringify({
    kind: input.kind,
    limit: input.limit,
    payload: canonicalPayload(input.payload),
    version: 1,
  });
  const bytes = Buffer.byteLength(encodedJson, "utf8");
  if (bytes > PORTAL_V2_MAX_DECODED_CURSOR_BYTES) {
    throw new TypeError("The cursor payload is too large.");
  }
  const encoded = Buffer.from(encodedJson, "utf8").toString("base64url");
  if (encoded.length > PORTAL_V2_MAX_CURSOR_LENGTH) {
    throw new TypeError("The encoded cursor is too large.");
  }
  return encoded;
}

export function decodePortalV2Cursor<T>(
  rawValue: unknown,
  options: {
    expectedKind: string;
    validatePayload: (value: unknown) => value is T;
  },
): PortalV2Cursor<T> | null {
  if (
    typeof rawValue !== "string" ||
    rawValue.length === 0 ||
    rawValue.length > PORTAL_V2_MAX_CURSOR_LENGTH ||
    !BASE64URL_PATTERN.test(rawValue) ||
    !CURSOR_KIND_PATTERN.test(options.expectedKind)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(rawValue, "base64url");
    if (
      decoded.byteLength === 0 ||
      decoded.byteLength > PORTAL_V2_MAX_DECODED_CURSOR_BYTES
    ) {
      return null;
    }
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "kind,limit,payload,version" ||
      record["version"] !== 1 ||
      record["kind"] !== options.expectedKind ||
      !validLimit(record["limit"])
    ) {
      return null;
    }
    const payload = canonicalPayload(record["payload"]);
    if (!options.validatePayload(payload)) return null;
    const cursor: PortalV2Cursor<T> = Object.freeze({
      version: 1,
      kind: options.expectedKind,
      limit: record["limit"],
      payload,
    });
    if (
      encodePortalV2Cursor({
        kind: cursor.kind,
        limit: cursor.limit,
        payload: cursor.payload,
      }) !== rawValue
    ) {
      return null;
    }
    return cursor;
  } catch {
    return null;
  }
}

function paginationFailure(
  field: string,
  message: string,
): PortalV2PaginationResult<never> {
  return Object.freeze({
    ok: false,
    error: "invalid_pagination",
    fieldErrors: Object.freeze({ [field]: message }),
  });
}

export function parsePortalV2Pagination<T>(
  params: URLSearchParams,
  options: {
    cursorKind: string;
    validateCursorPayload: (value: unknown) => value is T;
    defaultLimit?: number;
    maximumLimit?: number;
    allowedQueryKeys?: ReadonlySet<string>;
  },
): PortalV2PaginationResult<T> {
  const maximumLimit = options.maximumLimit ?? PORTAL_V2_MAX_PAGE_LIMIT;
  const defaultLimit = options.defaultLimit ?? PORTAL_V2_DEFAULT_PAGE_LIMIT;
  if (
    !CURSOR_KIND_PATTERN.test(options.cursorKind) ||
    !validLimit(maximumLimit) ||
    !validLimit(defaultLimit, maximumLimit)
  ) {
    throw new TypeError("The pagination configuration is invalid.");
  }
  if (options.allowedQueryKeys) {
    for (const key of params.keys()) {
      if (
        key !== "cursor" &&
        key !== "limit" &&
        !options.allowedQueryKeys.has(key)
      ) {
        return paginationFailure(key, `Unsupported query parameter: ${key}.`);
      }
    }
  }

  const limitValues = params.getAll("limit");
  if (limitValues.length > 1) {
    return paginationFailure("limit", "limit may only be provided once.");
  }
  let explicitLimit: number | null = null;
  if (limitValues.length === 1) {
    const rawLimit = limitValues[0] ?? "";
    if (!/^[1-9]\d{0,2}$/u.test(rawLimit)) {
      return paginationFailure(
        "limit",
        `limit must be a whole number between 1 and ${maximumLimit}.`,
      );
    }
    explicitLimit = Number(rawLimit);
    if (!validLimit(explicitLimit, maximumLimit)) {
      return paginationFailure(
        "limit",
        `limit must be between 1 and ${maximumLimit}.`,
      );
    }
  }

  const cursorValues = params.getAll("cursor");
  if (cursorValues.length > 1) {
    return paginationFailure("cursor", "cursor may only be provided once.");
  }
  const rawCursor = cursorValues[0] ?? null;
  if (cursorValues.length === 1 && rawCursor?.length === 0) {
    return paginationFailure("cursor", "The page cursor cannot be empty.");
  }
  const cursor = rawCursor
    ? decodePortalV2Cursor(rawCursor, {
        expectedKind: options.cursorKind,
        validatePayload: options.validateCursorPayload,
      })
    : null;
  if (rawCursor && !cursor) {
    return paginationFailure(
      "cursor",
      "The page cursor is invalid. Return to the first page.",
    );
  }
  if (cursor && cursor.limit > maximumLimit) {
    return paginationFailure(
      "cursor",
      "The page cursor uses an unsupported page size.",
    );
  }
  if (cursor && explicitLimit !== null && cursor.limit !== explicitLimit) {
    return paginationFailure(
      "cursor",
      "The page cursor belongs to a different page size.",
    );
  }

  return Object.freeze({
    ok: true,
    limit: explicitLimit ?? cursor?.limit ?? defaultLimit,
    cursor,
  });
}
