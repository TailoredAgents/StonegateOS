import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { getDb, appointments } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

type WindowSummary = {
  totalCents: number;
  count: number;
};

function startOfUtcMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfUtcYear(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
}

async function computeWindow(db: ReturnType<typeof getDb>, start: Date, end: Date): Promise<WindowSummary> {
  const [row] = await db
    .select({
      totalCents: sql<number>`
        coalesce(
          sum(coalesce(${appointments.finalTotalCents}, ${appointments.quotedTotalCents})),
          0
        )::int
      `.as("total_cents"),
      count: sql<number>`count(*)::int`.as("count")
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "completed"),
        isNotNull(appointments.startAt),
        gte(appointments.startAt, start),
        lt(appointments.startAt, end)
      )
    );

  return {
    totalCents: row?.totalCents ?? 0,
    count: row?.count ?? 0
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const now = new Date();

  const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const monthStart = startOfUtcMonth(now);
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const yearStart = startOfUtcYear(now);
  const nextYearStart = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1, 0, 0, 0, 0));

  const [last30Days, monthToDate, yearToDate] = await Promise.all([
    computeWindow(db, last30Start, now),
    computeWindow(db, monthStart, nextMonthStart),
    computeWindow(db, yearStart, nextYearStart)
  ]);

  return NextResponse.json({
    ok: true,
    currency: "USD",
    windows: {
      last30Days,
      monthToDate,
      yearToDate
    }
  });
}
