import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, gte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb, webEventCountsDaily } from "@/db";
import { isAdminRequest } from "../../../../web/admin";

function parseRangeDays(request: NextRequest): number {
  const rangeDaysRaw = request.nextUrl.searchParams.get("rangeDays");
  const parsed = rangeDaysRaw ? Number(rangeDaysRaw) : NaN;
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(Math.max(Math.floor(parsed), 1), 30);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const rangeDays = parseRangeDays(request);
  const tz = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";
  const now = DateTime.now().setZone(tz);
  const since = now.minus({ days: rangeDays - 1 }).toISODate();
  if (!since) {
    return NextResponse.json({ ok: false, error: "invalid_time" }, { status: 500 });
  }

  const db = getDb();
  const rows = await db
    .select({
      event: webEventCountsDaily.event,
      key: webEventCountsDaily.key,
      path: webEventCountsDaily.path,
      count: sql<number>`coalesce(sum(${webEventCountsDaily.count}),0)`.mapWith(Number)
    })
    .from(webEventCountsDaily)
    .where(and(gte(webEventCountsDaily.dateStart, since), sql`${webEventCountsDaily.event} like '%_fail'`))
    .groupBy(webEventCountsDaily.event, webEventCountsDaily.key, webEventCountsDaily.path)
    .orderBy(desc(sql`sum(${webEventCountsDaily.count})`))
    .limit(40);

  return NextResponse.json({
    ok: true,
    rangeDays,
    since,
    items: rows.map((row) => ({
      event: row.event,
      key: row.key || null,
      path: row.path,
      count: row.count
    }))
  });
}
