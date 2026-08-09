import { and, eq, gt, gte, lt, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { DateTime } from "luxon";
import { expenses } from "@/db";

const DEFAULT_LIMIT = 25;
export const MAX_EXPENSE_PAGE_LIMIT = 100;
const MAX_CURSOR_LENGTH = 800;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const LIFECYCLE_STATUSES = new Set(["draft", "posted", "voided", "corrected"]);
const FINANCE_REVIEW_FILTERS = new Set(["required", "clear"]);
const EXPENSE_TIME_ZONE = "America/New_York";
const LIST_QUERY_KEYS = new Set([
  "limit",
  "cursor",
  "direction",
  "from",
  "to",
  "status",
  "category",
  "source",
  "financeReview",
  "q",
]);

export type ExpenseLifecycleStatus =
  | "draft"
  | "posted"
  | "voided"
  | "corrected";

export type ExpenseFinanceReviewFilter = "required" | "clear";

export type ExpenseCursor = {
  version: 1;
  paidAt: string;
  createdAt: string;
  id: string;
};

export type ExpenseSortKey = Pick<ExpenseCursor, "paidAt" | "createdAt" | "id">;

/** Pure reference comparator for the database's stable newest-first order. */
export function compareExpenseSortKeysNewestFirst(
  left: ExpenseSortKey,
  right: ExpenseSortKey,
): number {
  const paidAt = right.paidAt.localeCompare(left.paidAt);
  if (paidAt !== 0) return paidAt;
  const createdAt = right.createdAt.localeCompare(left.createdAt);
  if (createdAt !== 0) return createdAt;
  return right.id.localeCompare(left.id);
}

export function expenseSortKeyIsAfterCursor(
  key: ExpenseSortKey,
  cursor: ExpenseCursor,
): boolean {
  return compareExpenseSortKeysNewestFirst(key, cursor) > 0;
}

export type ParsedExpenseQuery = {
  limit: number;
  cursor: ExpenseCursor | null;
  direction: "next" | "previous";
  from: Date | null;
  toExclusive: Date | null;
  status: ExpenseLifecycleStatus | null;
  category: string | null;
  source: string | null;
  financeReview: ExpenseFinanceReviewFilter | null;
  q: string | null;
};

export type ExpenseQueryResult =
  | { ok: true; query: ParsedExpenseQuery }
  | { ok: false; field: string; message: string };

type ParseExpenseQueryOptions = {
  allowCursor?: boolean;
  allowLimit?: boolean;
  defaultLimit?: number;
  maxLimit?: number;
};

function invalid(field: string, message: string): ExpenseQueryResult {
  return { ok: false, field, message };
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function readTextFilter(
  searchParams: URLSearchParams,
  field: string,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const values = searchParams.getAll(field);
  if (values.length > 1) {
    return { ok: false, message: `${field} may only be provided once.` };
  }
  if (values.length === 0) return { ok: true, value: null };
  const raw = values[0] ?? "";
  if (raw.length > maxLength) {
    return {
      ok: false,
      message: `${field} is longer than the supported limit of ${maxLength} characters.`,
    };
  }
  if (containsControlCharacter(raw)) {
    return { ok: false, message: `${field} contains unsupported characters.` };
  }
  const value = normalizedText(raw);
  if (value.length > maxLength) {
    return {
      ok: false,
      message: `${field} is longer than the supported normalized limit of ${maxLength} characters.`,
    };
  }
  return { ok: true, value: value || null };
}

function parseDate(raw: string, boundary: "from" | "to"): Date | null {
  if (DATE_ONLY_PATTERN.test(raw)) {
    const local = DateTime.fromISO(raw, { zone: EXPENSE_TIME_ZONE }).startOf(
      "day",
    );
    if (!local.isValid || local.toFormat("yyyy-MM-dd") !== raw) {
      return null;
    }
    return (boundary === "to" ? local.plus({ days: 1 }) : local)
      .toUTC()
      .toJSDate();
  }
  if (!ISO_INSTANT_PATTERN.test(raw)) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) || date.toISOString() !== raw
    ? null
    : date;
}

function isExactIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function encodeExpenseCursor(input: {
  paidAt: Date | string;
  createdAt: Date | string;
  id: string;
}): string {
  const cursor: ExpenseCursor = {
    version: 1,
    paidAt:
      input.paidAt instanceof Date ? input.paidAt.toISOString() : input.paidAt,
    createdAt:
      input.createdAt instanceof Date
        ? input.createdAt.toISOString()
        : input.createdAt,
    id: input.id,
  };
  if (
    !isExactIsoInstant(cursor.paidAt) ||
    !isExactIsoInstant(cursor.createdAt) ||
    !UUID_PATTERN.test(cursor.id)
  ) {
    throw new TypeError("Cannot encode an invalid expense cursor.");
  }
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeExpenseCursor(value: string): ExpenseCursor | null {
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
      Object.keys(parsed).sort().join(",") !== "createdAt,id,paidAt,version" ||
      parsed["version"] !== 1 ||
      !isExactIsoInstant(parsed["paidAt"]) ||
      !isExactIsoInstant(parsed["createdAt"]) ||
      typeof parsed["id"] !== "string" ||
      !UUID_PATTERN.test(parsed["id"])
    ) {
      return null;
    }
    return {
      version: 1,
      paidAt: parsed["paidAt"],
      createdAt: parsed["createdAt"],
      id: parsed["id"],
    };
  } catch {
    return null;
  }
}

export function parseExpenseQuery(
  searchParams: URLSearchParams,
  options: ParseExpenseQueryOptions = {},
): ExpenseQueryResult {
  for (const key of searchParams.keys()) {
    if (!LIST_QUERY_KEYS.has(key)) {
      return invalid(key, `Unsupported expense filter: ${key}.`);
    }
  }

  const allowLimit = options.allowLimit !== false;
  const allowCursor = options.allowCursor !== false;
  const maxLimit = options.maxLimit ?? MAX_EXPENSE_PAGE_LIMIT;
  const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  const limitValues = searchParams.getAll("limit");
  if (limitValues.length > 1) {
    return invalid("limit", "limit may only be provided once.");
  }
  if (!allowLimit && limitValues.length > 0) {
    return invalid("limit", "limit is not supported for expense exports.");
  }
  let limit = defaultLimit;
  if (limitValues.length === 1) {
    const rawLimit = limitValues[0] ?? "";
    if (rawLimit.length > 3 || !/^[1-9]\d*$/u.test(rawLimit)) {
      return invalid("limit", "limit must be a positive whole number.");
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > maxLimit) {
      return invalid("limit", `limit must be between 1 and ${maxLimit}.`);
    }
  }

  const cursorValues = searchParams.getAll("cursor");
  if (cursorValues.length > 1) {
    return invalid("cursor", "cursor may only be provided once.");
  }
  if (!allowCursor && cursorValues.length > 0) {
    return invalid("cursor", "cursor is not supported for expense exports.");
  }
  const cursorRaw = cursorValues[0] ?? null;
  if (cursorValues.length === 1 && !cursorRaw) {
    return invalid("cursor", "The expense cursor cannot be empty.");
  }
  const cursor = cursorRaw ? decodeExpenseCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return invalid(
      "cursor",
      "The expense cursor is invalid. Reset the ledger filters and try again.",
    );
  }
  const directionResult = readTextFilter(searchParams, "direction", 16);
  if (!directionResult.ok) {
    return invalid("direction", directionResult.message);
  }
  if (
    directionResult.value &&
    directionResult.value !== "next" &&
    directionResult.value !== "previous"
  ) {
    return invalid("direction", "direction must be next or previous.");
  }
  if (!allowCursor && directionResult.value) {
    return invalid(
      "direction",
      "direction is not supported for expense exports.",
    );
  }
  if (directionResult.value === "previous" && !cursor) {
    return invalid("direction", "A cursor is required for previous pages.");
  }

  for (const field of ["from", "to"] as const) {
    if (searchParams.getAll(field).length > 1) {
      return invalid(field, `${field} may only be provided once.`);
    }
  }
  const fromRaw = searchParams.get("from")?.trim() ?? "";
  const toRaw = searchParams.get("to")?.trim() ?? "";
  if (fromRaw.length > 80 || containsControlCharacter(fromRaw)) {
    return invalid("from", "from must use the supported date format.");
  }
  if (toRaw.length > 80 || containsControlCharacter(toRaw)) {
    return invalid("to", "to must use the supported date format.");
  }
  const from = fromRaw ? parseDate(fromRaw, "from") : null;
  const toExclusive = toRaw ? parseDate(toRaw, "to") : null;
  if (fromRaw && !from) {
    return invalid(
      "from",
      "from must be a real YYYY-MM-DD date or ISO instant.",
    );
  }
  if (toRaw && !toExclusive) {
    return invalid("to", "to must be a real YYYY-MM-DD date or ISO instant.");
  }
  if (from && toExclusive && from >= toExclusive) {
    return invalid("to", "to must be later than from.");
  }

  const statusResult = readTextFilter(searchParams, "status", 32);
  if (!statusResult.ok) return invalid("status", statusResult.message);
  if (statusResult.value && !LIFECYCLE_STATUSES.has(statusResult.value)) {
    return invalid("status", "Expense lifecycle status is not supported.");
  }

  const categoryResult = readTextFilter(searchParams, "category", 120);
  if (!categoryResult.ok) return invalid("category", categoryResult.message);
  const sourceResult = readTextFilter(searchParams, "source", 120);
  if (!sourceResult.ok) return invalid("source", sourceResult.message);
  const reviewResult = readTextFilter(searchParams, "financeReview", 32);
  if (!reviewResult.ok) {
    return invalid("financeReview", reviewResult.message);
  }
  if (reviewResult.value && !FINANCE_REVIEW_FILTERS.has(reviewResult.value)) {
    return invalid(
      "financeReview",
      "Finance review must be required or clear.",
    );
  }
  const searchResult = readTextFilter(searchParams, "q", 160);
  if (!searchResult.ok) return invalid("q", searchResult.message);

  return {
    ok: true,
    query: {
      limit,
      cursor,
      direction: directionResult.value === "previous" ? "previous" : "next",
      from,
      toExclusive,
      status: statusResult.value as ExpenseLifecycleStatus | null,
      category: categoryResult.value,
      source: sourceResult.value,
      financeReview: reviewResult.value as ExpenseFinanceReviewFilter | null,
      q: searchResult.value,
    },
  };
}

function normalizedColumn(column: AnyPgColumn): SQL<string> {
  return sql<string>`lower(regexp_replace(trim(coalesce(${column}, '')), '[[:space:]]+', ' ', 'g'))`;
}

export function expenseRequiresFinanceReviewSql(): SQL<boolean> {
  return sql<boolean>`(
    ${expenses.amount} <= 0
    OR ${expenses.currency} <> 'USD'
    OR (
      ${expenses.coverageStartAt} IS NOT NULL
      AND ${expenses.coverageEndAt} IS NOT NULL
      AND ${expenses.coverageEndAt} < ${expenses.coverageStartAt}
    )
  )`;
}

export function escapedExpenseSearchPattern(value: string): string {
  return `%${value.replace(/[!%_]/gu, (match) => `!${match}`)}%`;
}

export function buildExpenseWhere(query: ParsedExpenseQuery): SQL[] {
  const searchPattern = query.q ? escapedExpenseSearchPattern(query.q) : null;
  const financeReview = expenseRequiresFinanceReviewSql();
  return [
    query.from ? gte(expenses.paidAt, query.from) : undefined,
    query.toExclusive ? lt(expenses.paidAt, query.toExclusive) : undefined,
    query.status ? eq(expenses.lifecycleStatus, query.status) : undefined,
    query.category
      ? eq(normalizedColumn(expenses.category), query.category)
      : undefined,
    query.source
      ? eq(normalizedColumn(expenses.source), query.source)
      : undefined,
    query.financeReview === "required" ? financeReview : undefined,
    query.financeReview === "clear"
      ? sql<boolean>`NOT ${financeReview}`
      : undefined,
    searchPattern
      ? or(
          sql<boolean>`${normalizedColumn(expenses.vendor)} LIKE ${searchPattern} ESCAPE '!'`,
          sql<boolean>`${normalizedColumn(expenses.category)} LIKE ${searchPattern} ESCAPE '!'`,
          sql<boolean>`${normalizedColumn(expenses.memo)} LIKE ${searchPattern} ESCAPE '!'`,
        )
      : undefined,
    query.cursor
      ? query.direction === "previous"
        ? or(
            gt(expenses.paidAt, new Date(query.cursor.paidAt)),
            and(
              eq(expenses.paidAt, new Date(query.cursor.paidAt)),
              gt(expenses.createdAt, new Date(query.cursor.createdAt)),
            ),
            and(
              eq(expenses.paidAt, new Date(query.cursor.paidAt)),
              eq(expenses.createdAt, new Date(query.cursor.createdAt)),
              gt(expenses.id, query.cursor.id),
            ),
          )
        : or(
            lt(expenses.paidAt, new Date(query.cursor.paidAt)),
            and(
              eq(expenses.paidAt, new Date(query.cursor.paidAt)),
              lt(expenses.createdAt, new Date(query.cursor.createdAt)),
            ),
            and(
              eq(expenses.paidAt, new Date(query.cursor.paidAt)),
              eq(expenses.createdAt, new Date(query.cursor.createdAt)),
              lt(expenses.id, query.cursor.id),
            ),
          )
      : undefined,
  ].filter((condition): condition is SQL => condition !== undefined);
}

export function expenseFilterEvidence(
  query: ParsedExpenseQuery,
): Record<string, unknown> {
  return {
    from: query.from?.toISOString() ?? null,
    toExclusive: query.toExclusive?.toISOString() ?? null,
    lifecycleStatus: query.status,
    category: query.category,
    source: query.source,
    financeReview: query.financeReview,
    searchApplied: Boolean(query.q),
  };
}
