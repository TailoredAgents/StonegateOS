import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, gte, lt } from "drizzle-orm";
import { getDb, appointments } from "@/db";
import { isAdminRequest } from "../../../web/admin";

type RangeKey = "today" | "tomorrow" | "this_week" | "next_week";

type SummaryResponse = {
  ok: boolean;
  range: RangeKey;
  total: number;
  byStatus: Record<string, number>;
  byDay: Array<{ date: string; count: number }>;
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
  const day = start.getDay(); // 0-6
  start.setDate(start.getDate() - day);

  if (range === "next_week") {
    start.setDate(start.getDate() + 7);
  }

  const end = addDays(start, 7);
  return { start, end };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest): Promise<NextResponse<SummaryResponse>> {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { ok: false, range: "this_week", total: 0, byStatus: {}, byDay: [], error: "unauthorized" },
      { status: 401 }
    );
  }

  const range = parseRange(request.nextUrl.searchParams.get("range"));
  const { start, end } = computeRange(range);

  const db = getDb();
  const rows = await db
    .select({
      status: appointments.status,
      startAt: appointments.startAt
    })
    .from(appointments)
    .where(and(gte(appointments.startAt, start), lt(appointments.startAt, end)));

  const byStatus: Record<string, number> = {};
  const byDayMap = new Map<string, number>();

  for (const row of rows) {
    const status = row.status ?? "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (row.startAt instanceof Date) {
      const dayKey = isoDate(row.startAt);
      byDayMap.set(dayKey, (byDayMap.get(dayKey) ?? 0) + 1);
    }
  }

  const byDay = Array.from(byDayMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return NextResponse.json({
    ok: true,
    range,
    total: rows.length,
    byStatus,
    byDay
  });
}
