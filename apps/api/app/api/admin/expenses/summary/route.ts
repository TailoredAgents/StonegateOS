import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, gte, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { expenses, getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

type WindowSummary = {
  totalCents: number;
  count: number;
};

const EXPENSE_TIME_ZONE =
  process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";

function startOfUtcMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfUtcYear(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
}

function startOfLocalWeek(d: Date, timezone: string) {
  return DateTime.fromJSDate(d, { zone: timezone }).startOf("week").toJSDate();
}

async function computeWindow(
  db: ReturnType<typeof getDb>,
  start: Date,
  end: Date,
): Promise<WindowSummary> {
  const [row] = await db
    .select({
      totalCents: sql<number>`coalesce(sum(${expenses.amount}), 0)::int`.as(
        "total_cents",
      ),
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(expenses)
    .where(and(gte(expenses.paidAt, start), lt(expenses.paidAt, end)));

  return {
    totalCents: row?.totalCents ?? 0,
    count: row?.count ?? 0,
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "expenses.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const now = new Date();

  const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const weekStart = startOfLocalWeek(now, EXPENSE_TIME_ZONE);
  const monthStart = startOfUtcMonth(now);
  const nextMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  const yearStart = startOfUtcYear(now);
  const nextYearStart = new Date(
    Date.UTC(now.getUTCFullYear() + 1, 0, 1, 0, 0, 0, 0),
  );

  const last7Start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dayBucket =
    sql<string>`to_char(date_trunc('day', ${expenses.paidAt} AT TIME ZONE 'America/New_York'), 'YYYY-MM-DD')`.as(
      "day",
    );

  const [weekToDate, last30Days, monthToDate, yearToDate, dailyRows] =
    await Promise.all([
      computeWindow(db, weekStart, now),
      computeWindow(db, last30Start, now),
      computeWindow(db, monthStart, nextMonthStart),
      computeWindow(db, yearStart, nextYearStart),
      db
        .select({
          day: dayBucket,
          totalCents: sql<number>`coalesce(sum(${expenses.amount}), 0)::int`.as(
            "total_cents",
          ),
        })
        .from(expenses)
        .where(and(gte(expenses.paidAt, last7Start), lt(expenses.paidAt, now)))
        .groupBy(dayBucket)
        .orderBy(sql`day asc`),
    ]);

  return NextResponse.json({
    ok: true,
    currency: "USD",
    windows: {
      weekToDate,
      last30Days,
      monthToDate,
      yearToDate,
    },
    dailyTotals: dailyRows.map((row) => ({
      day: row.day,
      totalCents: row.totalCents,
    })),
  });
}
