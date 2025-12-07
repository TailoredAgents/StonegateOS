import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, gte, lt, sql } from "drizzle-orm";
import { getDb, payments } from "@/db";
import { isAdminRequest } from "../../../web/admin";

type RangeKey = "today" | "tomorrow" | "this_week" | "next_week";

type ForecastResponse = {
  ok: boolean;
  range: RangeKey;
  totalCents: number;
  currency: string | null;
  count: number;
  error?: string;
};

function parseRange(value: string | null): RangeKey {
  if (value === "today" || value === "tomorrow" || value === "next_week") return value;
  return "this_week";
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function computeRange(range: RangeKey): { start: Date; end: Date } {
  const now = new Date();
  if (range === "today") {
    const start = startOfDay(now);
    const end = addDays(start, 1);
    return { start, end };
  }
  if (range === "tomorrow") {
    const start = startOfDay(addDays(now, 1));
    const end = addDays(start, 1);
    return { start, end };
  }

  // Start of week (Sunday-based)
  const start = startOfDay(now);
  const day = start.getDay();
  start.setDate(start.getDate() - day);

  if (range === "next_week") {
    start.setDate(start.getDate() + 7);
  }

  const end = addDays(start, 7);
  return { start, end };
}

export async function GET(request: NextRequest): Promise<NextResponse<ForecastResponse>> {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { ok: false, range: "this_week", totalCents: 0, currency: null, count: 0, error: "unauthorized" },
      { status: 401 }
    );
  }

  const range = parseRange(request.nextUrl.searchParams.get("range"));
  const { start, end } = computeRange(range);

  const db = getDb();
  const rows = await db
    .select({
      amount: payments.amount,
      currency: payments.currency
    })
    .from(payments)
    .where(
      and(
        gte(sql`coalesce(${payments.capturedAt}, ${payments.createdAt})`, start),
        lt(sql`coalesce(${payments.capturedAt}, ${payments.createdAt})`, end)
      )
    );

  let totalCents = 0;
  let currency: string | null = null;
  for (const row of rows) {
    totalCents += row.amount ?? 0;
    if (!currency && row.currency) {
      currency = row.currency;
    }
  }

  return NextResponse.json({
    ok: true,
    range,
    totalCents,
    currency,
    count: rows.length
  });
}
