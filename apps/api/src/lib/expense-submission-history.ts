import { z } from "zod";
import { TeamMutationFailure } from "@/lib/team-mutation";

export const EXPENSE_HISTORY_FILTERS = [
  "all",
  "pending",
  "approved",
  "rejected",
  "reimbursement",
] as const;

export type ExpenseHistoryFilter = (typeof EXPENSE_HISTORY_FILTERS)[number];
export type ExpenseHistoryCursor = {
  filter: ExpenseHistoryFilter;
  ownerQueue: boolean;
  pendingRank: 0 | 1;
  paidAt: Date;
  createdAt: Date;
  id: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const FilterSchema = z.enum(EXPENSE_HISTORY_FILTERS);
const CursorTupleSchema = z.tuple([
  FilterSchema,
  z.boolean(),
  z.union([z.literal(0), z.literal(1)]),
  z.string(),
  z.string(),
  z.string().regex(UUID_PATTERN),
]);

function parseIsoTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
    ? parsed
    : null;
}

export function encodeExpenseHistoryCursor(
  cursor: ExpenseHistoryCursor,
): string {
  return Buffer.from(
    JSON.stringify([
      cursor.filter,
      cursor.ownerQueue,
      cursor.pendingRank,
      cursor.paidAt.toISOString(),
      cursor.createdAt.toISOString(),
      cursor.id,
    ]),
    "utf8",
  ).toString("base64url");
}

function decodeExpenseHistoryCursor(
  value: string,
): ExpenseHistoryCursor | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    const parsed = CursorTupleSchema.safeParse(decoded);
    if (!parsed.success) return null;
    const [filter, ownerQueue, pendingRank, paidAtValue, createdAtValue, id] =
      parsed.data;
    const paidAt = parseIsoTimestamp(paidAtValue);
    const createdAt = parseIsoTimestamp(createdAtValue);
    if (!paidAt || !createdAt) return null;
    return {
      filter,
      ownerQueue,
      pendingRank,
      paidAt,
      createdAt,
      id,
    };
  } catch {
    return null;
  }
}

export function parseExpenseHistoryQuery(
  searchParams: URLSearchParams,
  ownerQueue: boolean,
): {
  filter: ExpenseHistoryFilter;
  limit: number;
  cursor: ExpenseHistoryCursor | null;
} {
  const rawFilter = searchParams.get("filter")?.trim().toLowerCase() ?? "all";
  const parsedFilter = FilterSchema.safeParse(rawFilter);
  if (!parsedFilter.success) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a valid expense history filter.",
      { status: 422, fieldErrors: { filter: "Choose a valid filter." } },
    );
  }

  const rawLimit = searchParams.get("limit")?.trim() ?? "";
  const limit = rawLimit ? Number(rawLimit) : DEFAULT_LIMIT;
  if (
    (rawLimit && !/^\d+$/u.test(rawLimit)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT
  ) {
    throw new TeamMutationFailure(
      "invalid",
      `Use a history page size from 1 through ${MAX_LIMIT}.`,
      { status: 422, fieldErrors: { limit: "Choose a valid page size." } },
    );
  }

  const rawCursor = searchParams.get("cursor")?.trim() ?? "";
  const cursor =
    rawCursor && rawCursor.length <= 512
      ? decodeExpenseHistoryCursor(rawCursor)
      : null;
  if (
    rawCursor &&
    (!cursor ||
      cursor.filter !== parsedFilter.data ||
      cursor.ownerQueue !== ownerQueue)
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Refresh expense history and try again.",
      { status: 422, fieldErrors: { cursor: "The history page expired." } },
    );
  }

  return { filter: parsedFilter.data, limit, cursor };
}
