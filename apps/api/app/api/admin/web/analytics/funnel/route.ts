import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, gte, sql } from "drizzle-orm";
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
  const baseWhere = gte(webEventCountsDaily.dateStart, since);

  const rows = await db
    .select({
      event: webEventCountsDaily.event,
      key: webEventCountsDaily.key,
      inAreaBucket: webEventCountsDaily.inAreaBucket,
      count: sql<number>`coalesce(sum(${webEventCountsDaily.count}),0)`.mapWith(Number)
    })
    .from(webEventCountsDaily)
    .where(
      and(
        baseWhere,
        sql`${webEventCountsDaily.event} in ('book_step_view','book_step1_submit','book_quote_success','book_booking_success')`
      )
    )
    .groupBy(webEventCountsDaily.event, webEventCountsDaily.key, webEventCountsDaily.inAreaBucket);

  function sumFor(event: string, key?: string | null, bucket?: string | null): number {
    return rows
      .filter((row) => row.event === event)
      .filter((row) => (key === undefined ? true : (row.key ?? "") === (key ?? "")))
      .filter((row) => (bucket === undefined ? true : (row.inAreaBucket ?? "") === (bucket ?? "")))
      .reduce((acc, row) => acc + (Number.isFinite(row.count) ? row.count : 0), 0);
  }

  const buckets = ["in_area", "borderline", "out_of_area", ""] as const;
  const byBucket = buckets.map((bucket) => ({
    bucket: bucket === "" ? "unknown" : bucket,
    step1Views: sumFor("book_step_view", "1", bucket),
    step2Views: sumFor("book_step_view", "2", bucket),
    step1Submits: sumFor("book_step1_submit", null, bucket),
    quoteSuccess: sumFor("book_quote_success", null, bucket),
    bookingSuccess: sumFor("book_booking_success", null, bucket)
  }));

  return NextResponse.json({
    ok: true,
    rangeDays,
    since,
    totals: {
      step1Views: sumFor("book_step_view", "1"),
      step2Views: sumFor("book_step_view", "2"),
      step1Submits: sumFor("book_step1_submit"),
      quoteSuccess: sumFor("book_quote_success"),
      bookingSuccess: sumFor("book_booking_success")
    },
    byBucket
  });
}
