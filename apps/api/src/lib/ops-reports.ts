import { and, desc, eq, gte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { appointments, getDb, googleAdsInsightsDaily, webEventCountsDaily } from "../db";
import { getGoogleAdsConfiguredIds } from "./google-ads-insights";

function toPercent(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${Math.round(n * 100)}%`;
}

function safeDiv(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

function fmtMoneyFromNumericString(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "$0";
  return `$${parsed.toFixed(2)}`;
}

export type WebTotals = {
  visits: number;
  pageViews: number;
  callClicks: number;
  bookStep1Views: number;
  bookStep1Submits: number;
  bookQuoteSuccess: number;
  bookBookingSuccess: number;
  bookedAnyChannel: number;
};

export type FunnelBucketRow = {
  bucket: "in_area" | "borderline" | "out_of_area" | "unknown";
  step1Views: number;
  step2Views: number;
  step1Submits: number;
  quoteSuccess: number;
  bookingSuccess: number;
};

export type WebErrorRow = { event: string; key: string | null; path: string; count: number };

function parseRangeDays(rangeDays: number): number {
  const parsed = Number(rangeDays);
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(Math.max(Math.floor(parsed), 1), 30);
}

function computeSince(rangeDays: number, tz: string) {
  const now = DateTime.now().setZone(tz);
  const sinceDate = now.minus({ days: rangeDays - 1 }).toISODate();
  const sinceTs = now.minus({ days: rangeDays - 1 }).startOf("day").toJSDate();
  return { now, sinceDate: sinceDate ?? now.toISODate() ?? "", sinceTs };
}

export async function fetchWebTotals(input: { rangeDays: number; tz: string }): Promise<{ rangeDays: number; since: string; totals: WebTotals }> {
  const rangeDays = parseRangeDays(input.rangeDays);
  const tz = input.tz || "America/New_York";
  const { sinceDate, sinceTs } = computeSince(rangeDays, tz);

  const db = getDb();
  const totalsRow = await db
    .select({
      visits: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='visit_start' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number),
      pageViews: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='page_view' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number),
      callClicks: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='cta_click' and ${webEventCountsDaily.key}='call' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number),
      bookStep1Views: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_step_view' and ${webEventCountsDaily.key}='1' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number),
      bookStep1Submits: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_step1_submit' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number),
      bookQuoteSuccess: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_quote_success' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number),
      bookBookingSuccess: sql<number>`coalesce(sum(case when ${webEventCountsDaily.event}='book_booking_success' then ${webEventCountsDaily.count} else 0 end),0)`.mapWith(Number)
    })
    .from(webEventCountsDaily)
    .where(gte(webEventCountsDaily.dateStart, sinceDate))
    .then((rows) => rows[0] ?? null);

  const bookedAnyChannelRow = await db
    .select({
      bookedAnyChannel: sql<number>`coalesce(count(*),0)`.mapWith(Number)
    })
    .from(appointments)
    .where(and(gte(appointments.createdAt, sinceTs), sql`${appointments.status} <> 'canceled'`))
    .then((rows) => rows[0] ?? null);

  return {
    rangeDays,
    since: sinceDate,
    totals: {
      visits: totalsRow?.visits ?? 0,
      pageViews: totalsRow?.pageViews ?? 0,
      callClicks: totalsRow?.callClicks ?? 0,
      bookStep1Views: totalsRow?.bookStep1Views ?? 0,
      bookStep1Submits: totalsRow?.bookStep1Submits ?? 0,
      bookQuoteSuccess: totalsRow?.bookQuoteSuccess ?? 0,
      bookBookingSuccess: totalsRow?.bookBookingSuccess ?? 0,
      bookedAnyChannel: bookedAnyChannelRow?.bookedAnyChannel ?? 0
    }
  };
}

export async function fetchWebFunnelByBucket(input: { rangeDays: number; tz: string }): Promise<{ rangeDays: number; since: string; totals: FunnelBucketRow; byBucket: FunnelBucketRow[] }> {
  const rangeDays = parseRangeDays(input.rangeDays);
  const tz = input.tz || "America/New_York";
  const { sinceDate, sinceTs } = computeSince(rangeDays, tz);
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

  const bucketKeys = ["in_area", "borderline", "out_of_area", ""] as const;
  const byBucket: FunnelBucketRow[] = bucketKeys.map((bucket) => ({
    bucket: bucket === "" ? "unknown" : (bucket as any),
    step1Views: sumFor("book_step_view", "1", bucket),
    step2Views: sumFor("book_step_view", "2", bucket),
    step1Submits: sumFor("book_step1_submit", null, bucket),
    quoteSuccess: sumFor("book_quote_success", null, bucket),
    bookingSuccess: sumFor("book_booking_success", null, bucket)
  }));

  const totals: FunnelBucketRow = {
    bucket: "unknown",
    step1Views: sumFor("book_step_view", "1"),
    step2Views: sumFor("book_step_view", "2"),
    step1Submits: sumFor("book_step1_submit"),
    quoteSuccess: sumFor("book_quote_success"),
    bookingSuccess: sumFor("book_booking_success")
  };

  return { rangeDays, since: sinceDate, totals, byBucket };
}

export async function fetchWebErrors(input: { rangeDays: number; tz: string }): Promise<{ rangeDays: number; since: string; items: WebErrorRow[] }> {
  const rangeDays = parseRangeDays(input.rangeDays);
  const tz = input.tz || "America/New_York";
  const { sinceDate } = computeSince(rangeDays, tz);

  const db = getDb();
  const rows = await db
    .select({
      event: webEventCountsDaily.event,
      key: webEventCountsDaily.key,
      path: webEventCountsDaily.path,
      count: sql<number>`coalesce(sum(${webEventCountsDaily.count}),0)`.mapWith(Number)
    })
    .from(webEventCountsDaily)
    .where(and(gte(webEventCountsDaily.dateStart, sinceDate), sql`${webEventCountsDaily.event} like '%_fail'`))
    .groupBy(webEventCountsDaily.event, webEventCountsDaily.key, webEventCountsDaily.path)
    .orderBy(desc(sql`sum(${webEventCountsDaily.count})`))
    .limit(12);

  return {
    rangeDays,
    since: sinceDate,
    items: rows.map((row) => ({
      event: row.event,
      key: row.key || null,
      path: row.path,
      count: row.count
    }))
  };
}

export async function fetchGoogleAdsSummary(input: { rangeDays: number; tz: string }) {
  const rangeDays = parseRangeDays(input.rangeDays);
  const tz = input.tz || "America/New_York";
  const { sinceDate } = computeSince(rangeDays, tz);
  const { customerId } = getGoogleAdsConfiguredIds();
  if (!customerId) return null;

  const db = getDb();
  const totalsRow = await db
    .select({
      impressions: sql<number>`coalesce(sum(${googleAdsInsightsDaily.impressions}), 0)`.mapWith(Number),
      clicks: sql<number>`coalesce(sum(${googleAdsInsightsDaily.clicks}), 0)`.mapWith(Number),
      cost: sql<string>`coalesce(sum(${googleAdsInsightsDaily.cost}), 0)::text`,
      conversions: sql<string>`coalesce(sum(${googleAdsInsightsDaily.conversions}), 0)::text`
    })
    .from(googleAdsInsightsDaily)
    .where(and(gte(googleAdsInsightsDaily.dateStart, sinceDate), eq(googleAdsInsightsDaily.customerId, customerId)))
    .then((rows) => rows[0] ?? null);

  if (!totalsRow) return null;
  return {
    rangeDays,
    since: sinceDate,
    impressions: totalsRow.impressions ?? 0,
    clicks: totalsRow.clicks ?? 0,
    cost: totalsRow.cost ?? "0",
    conversions: totalsRow.conversions ?? "0"
  };
}

export async function buildDailyOpsReportMarkdown(input?: { tz?: string }) {
  const tz = input?.tz || process.env["APPOINTMENT_TIMEZONE"] || "America/New_York";

  const [todayTotals, todayFunnel, todayErrors, weekTotals, weekFunnel, adsWeek] = await Promise.all([
    fetchWebTotals({ rangeDays: 1, tz }),
    fetchWebFunnelByBucket({ rangeDays: 1, tz }),
    fetchWebErrors({ rangeDays: 1, tz }),
    fetchWebTotals({ rangeDays: 7, tz }),
    fetchWebFunnelByBucket({ rangeDays: 7, tz }),
    fetchGoogleAdsSummary({ rangeDays: 7, tz })
  ]);

  const now = DateTime.now().setZone(tz);
  const dayLabel = now.toFormat("ccc, LLL d");

  const t = todayTotals.totals;
  const w = weekTotals.totals;

  const submitRateToday = safeDiv(t.bookStep1Submits, t.bookStep1Views);
  const quoteRateToday = safeDiv(t.bookQuoteSuccess, t.bookStep1Submits);
  const bookRateToday = safeDiv(t.bookBookingSuccess, t.bookQuoteSuccess);

  const submitRateWeek = safeDiv(w.bookStep1Submits, w.bookStep1Views);
  const quoteRateWeek = safeDiv(w.bookQuoteSuccess, w.bookStep1Submits);
  const bookRateWeek = safeDiv(w.bookBookingSuccess, w.bookQuoteSuccess);

  const lines: string[] = [];
  lines.push(`**Daily Ops Report — ${dayLabel} (${tz})**`);
  lines.push("");

  lines.push("**Website (today)**");
  lines.push(`- Visits: ${t.visits} | /book step 1: ${t.bookStep1Views} | Submits: ${t.bookStep1Submits} (${toPercent(submitRateToday)})`);
  lines.push(`- Quotes shown: ${t.bookQuoteSuccess} (${toPercent(quoteRateToday)} of submits) | Self-serve bookings: ${t.bookBookingSuccess} (${toPercent(bookRateToday)} of quotes)`);
  lines.push(`- Booked (any channel): ${t.bookedAnyChannel} | Call clicks: ${t.callClicks}`);
  lines.push("");

  lines.push("**Website (last 7 days)**");
  lines.push(`- Visits: ${w.visits} | /book step 1: ${w.bookStep1Views} | Submits: ${w.bookStep1Submits} (${toPercent(submitRateWeek)})`);
  lines.push(`- Quotes shown: ${w.bookQuoteSuccess} (${toPercent(quoteRateWeek)} of submits) | Self-serve bookings: ${w.bookBookingSuccess} (${toPercent(bookRateWeek)} of quotes)`);
  lines.push(`- Booked (any channel): ${w.bookedAnyChannel} | Call clicks: ${w.callClicks}`);
  lines.push("");

  if (adsWeek) {
    lines.push("**Google Ads (last 7 days)**");
    lines.push(`- Clicks: ${adsWeek.clicks} | Impressions: ${adsWeek.impressions} | Cost: ${fmtMoneyFromNumericString(adsWeek.cost)} | Conversions: ${adsWeek.conversions}`);
    lines.push("");
  }

  if (todayErrors.items.length) {
    lines.push("**Errors (today)**");
    for (const item of todayErrors.items.slice(0, 5)) {
      const key = item.key ? `:${item.key}` : "";
      lines.push(`- ${item.count}× ${item.event}${key} on ${item.path}`);
    }
    lines.push("");
  }

  const alerts: string[] = [];
  if (t.bookStep1Submits >= 5 && quoteRateToday < 0.85) {
    alerts.push(`Submit → Quote shown looks low today (${toPercent(quoteRateToday)}).`);
  }
  if (t.bookQuoteSuccess >= 5 && bookRateToday < 0.08) {
    alerts.push(`Quote → Self-serve booking is low today (${toPercent(bookRateToday)}).`);
  }
  if (todayErrors.items.length) {
    alerts.push(`There were ${todayErrors.items.reduce((a, b) => a + (b.count || 0), 0)} tracked failure event(s) today.`);
  }

  if (alerts.length) {
    lines.push("**Alerts**");
    for (const alert of alerts) lines.push(`- ${alert}`);
    lines.push("");
  }

  // Small appendix for bucket visibility (kept short).
  const bucketTop = weekFunnel.byBucket
    .filter((b) => b.step1Views > 0)
    .sort((a, b) => b.step1Views - a.step1Views)
    .slice(0, 3)
    .map((b) => `${b.bucket}: ${b.step1Views} step1`)
    .join(", ");
  if (bucketTop) {
    lines.push(`Bucket mix (7d): ${bucketTop}`);
  }

  return lines.join("\n").trim();
}
