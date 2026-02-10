import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb } from "@/db";
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

  const sinceTs = now.minus({ days: rangeDays - 1 }).startOf("day").toJSDate();
  const db = getDb();

  const rows = (await db.execute(
    sql`
      with visit_bucket as (
        select v.visit_id,
          coalesce(b.in_area_bucket, '') as bucket
        from (
          select distinct visit_id
          from web_events
          where created_at >= ${sinceTs}
        ) v
        left join lateral (
          select in_area_bucket
          from web_events e
          where e.visit_id = v.visit_id and e.in_area_bucket is not null and e.in_area_bucket <> ''
          order by e.created_at desc
          limit 1
        ) b on true
      )
      select
        vb.bucket as bucket,
        e.event as event,
        coalesce(e.key, '') as key,
        count(*)::int as count
      from web_events e
      join visit_bucket vb on vb.visit_id = e.visit_id
      where e.created_at >= ${sinceTs}
        and e.event in ('book_step_view','book_step1_submit','book_quote_success','book_booking_success')
      group by vb.bucket, e.event, coalesce(e.key, '')
    `
  )) as Array<{ bucket?: string | null; event?: string | null; key?: string | null; count?: number | null }>;

  function sumFor(event: string, key?: string | null, bucket?: string | null): number {
    return rows
      .filter((row) => (row.event ?? "") === event)
      .filter((row) => (key === undefined ? true : (row.key ?? "") === (key ?? "")))
      .filter((row) => (bucket === undefined ? true : (row.bucket ?? "") === (bucket ?? "")))
      .reduce((acc, row) => acc + (Number.isFinite(Number(row.count)) ? Number(row.count) : 0), 0);
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
