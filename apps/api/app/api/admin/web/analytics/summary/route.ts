import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { appointments, getDb, webEventCountsDaily } from "@/db";
import { isAdminRequest } from "../../../../web/admin";

function parseRangeDays(request: NextRequest): number {
  const rangeDaysRaw = request.nextUrl.searchParams.get("rangeDays");
  const parsed = rangeDaysRaw ? Number(rangeDaysRaw) : NaN;
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(Math.max(Math.floor(parsed), 1), 30);
}

function normalizeScope(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 120);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const rangeDays = parseRangeDays(request);
  const scopeCampaign = normalizeScope(request.nextUrl.searchParams.get("utmCampaign"));

  const tz = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";
  const now = DateTime.now().setZone(tz);
  const since = now.minus({ days: rangeDays - 1 }).toISODate();
  if (!since) {
    return NextResponse.json({ ok: false, error: "invalid_time" }, { status: 500 });
  }

  const db = getDb();
  const sinceTs = now.minus({ days: rangeDays - 1 }).startOf("day").toJSDate();

  const scopeClause = scopeCampaign
    ? and(eq(webEventCountsDaily.utmCampaign, scopeCampaign), gte(webEventCountsDaily.dateStart, since))
    : gte(webEventCountsDaily.dateStart, since);

  const totalsRow = await db
    .select({
      visits: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='visit_start' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(
        Number
      ),
      pageViews: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='page_view' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(
        Number
      ),
      callClicks: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='cta_click' and ${webEventCountsDaily.key}='call' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(
        Number
      ),
      bookStep1Views: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_step_view' and ${webEventCountsDaily.key}='1' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(
        Number
      ),
      bookStep1Submits: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_step1_submit' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(
        Number
      ),
      bookQuoteSuccess: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_quote_success' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(
        Number
      ),
      bookBookingSuccess: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_booking_success' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(
        Number
      ),
      days: sql<number>`count(distinct ${webEventCountsDaily.dateStart})`.mapWith(Number)
    })
    .from(webEventCountsDaily)
    .where(scopeClause)
    .then((rows) => rows[0] ?? null);

  const topPages = await db
    .select({
      path: webEventCountsDaily.path,
      pageViews: sql<number>`coalesce(sum(${webEventCountsDaily.count}),0)`.mapWith(Number)
    })
    .from(webEventCountsDaily)
    .where(and(scopeClause, eq(webEventCountsDaily.event, "page_view")))
    .groupBy(webEventCountsDaily.path)
    .orderBy(desc(sql`sum(${webEventCountsDaily.count})`))
    .limit(12);

  const topSources = await db
    .select({
      utmSource: webEventCountsDaily.utmSource,
      utmMedium: webEventCountsDaily.utmMedium,
      utmCampaign: webEventCountsDaily.utmCampaign,
      visits: sql<number>`coalesce(sum(${webEventCountsDaily.count}),0)`.mapWith(Number)
    })
    .from(webEventCountsDaily)
    .where(and(scopeClause, eq(webEventCountsDaily.event, "visit_start")))
    .groupBy(webEventCountsDaily.utmSource, webEventCountsDaily.utmMedium, webEventCountsDaily.utmCampaign)
    .orderBy(desc(sql`sum(${webEventCountsDaily.count})`))
    .limit(20);

  const bookedAnyChannelRow = await db
    .select({
      bookedAnyChannel: sql<number>`coalesce(count(*),0)`.mapWith(Number)
    })
    .from(appointments)
    .where(and(gte(appointments.createdAt, sinceTs), sql`${appointments.status} <> 'canceled'`))
    .then((rows) => rows[0] ?? null);

  return NextResponse.json({
    ok: true,
    rangeDays,
    since,
    scope: { utmCampaign: scopeCampaign },
    totals:
      {
        ...(totalsRow ?? {
          visits: 0,
          pageViews: 0,
          callClicks: 0,
          bookStep1Views: 0,
          bookStep1Submits: 0,
          bookQuoteSuccess: 0,
          bookBookingSuccess: 0,
          days: 0
        }),
        bookedAnyChannel: bookedAnyChannelRow?.bookedAnyChannel ?? 0
      },
    topPages,
    topSources
  });
}
