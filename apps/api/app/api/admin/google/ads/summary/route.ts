import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb, googleAdsInsightsDaily, googleAdsSearchTermsDaily } from "@/db";
import { getGoogleAdsConfiguredIds } from "@/lib/google-ads-insights";
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

  const { customerId } = getGoogleAdsConfiguredIds();
  if (!customerId) {
    return NextResponse.json({ ok: false, error: "google_ads_not_configured" }, { status: 400 });
  }

  const rangeDays = parseRangeDays(request);
  const tz = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";
  const now = DateTime.now().setZone(tz);
  const since = now.minus({ days: rangeDays - 1 }).toISODate();
  if (!since) {
    return NextResponse.json({ ok: false, error: "invalid_time" }, { status: 500 });
  }

  const db = getDb();
  const [totalsRow, topCampaigns, topSearchTerms] = await Promise.all([
    db
      .select({
        impressions: sql<number>`coalesce(sum(${googleAdsInsightsDaily.impressions}), 0)`.mapWith(Number),
        clicks: sql<number>`coalesce(sum(${googleAdsInsightsDaily.clicks}), 0)`.mapWith(Number),
        cost: sql<string>`coalesce(sum(${googleAdsInsightsDaily.cost}), 0)::text`,
        conversions: sql<string>`coalesce(sum(${googleAdsInsightsDaily.conversions}), 0)::text`,
        conversionValue: sql<string>`coalesce(sum(${googleAdsInsightsDaily.conversionValue}), 0)::text`,
        days: sql<number>`count(distinct ${googleAdsInsightsDaily.dateStart})`.mapWith(Number)
      })
      .from(googleAdsInsightsDaily)
      .where(and(gte(googleAdsInsightsDaily.dateStart, since), eq(googleAdsInsightsDaily.customerId, customerId)))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        campaignId: googleAdsInsightsDaily.campaignId,
        campaignName: sql<string>`max(${googleAdsInsightsDaily.campaignName})`,
        clicks: sql<number>`coalesce(sum(${googleAdsInsightsDaily.clicks}), 0)`.mapWith(Number),
        cost: sql<string>`coalesce(sum(${googleAdsInsightsDaily.cost}), 0)::text`,
        conversions: sql<string>`coalesce(sum(${googleAdsInsightsDaily.conversions}), 0)::text`
      })
      .from(googleAdsInsightsDaily)
      .where(and(gte(googleAdsInsightsDaily.dateStart, since), eq(googleAdsInsightsDaily.customerId, customerId)))
      .groupBy(googleAdsInsightsDaily.campaignId)
      .orderBy(desc(sql`sum(${googleAdsInsightsDaily.conversions})`))
      .limit(20),
    db
      .select({
        searchTerm: googleAdsSearchTermsDaily.searchTerm,
        campaignId: googleAdsSearchTermsDaily.campaignId,
        campaignName: sql<string>`(
          select max(${googleAdsInsightsDaily.campaignName})
          from ${googleAdsInsightsDaily}
          where ${googleAdsInsightsDaily.campaignId} = ${googleAdsSearchTermsDaily.campaignId}
            and ${googleAdsInsightsDaily.customerId} = ${googleAdsSearchTermsDaily.customerId}
            and ${googleAdsInsightsDaily.dateStart} >= ${since}
            and ${googleAdsInsightsDaily.customerId} = ${customerId}
        )`,
        impressions: sql<number>`coalesce(sum(${googleAdsSearchTermsDaily.impressions}), 0)`.mapWith(Number),
        clicks: sql<number>`coalesce(sum(${googleAdsSearchTermsDaily.clicks}), 0)`.mapWith(Number),
        cost: sql<string>`coalesce(sum(${googleAdsSearchTermsDaily.cost}), 0)::text`,
        conversions: sql<string>`coalesce(sum(${googleAdsSearchTermsDaily.conversions}), 0)::text`
      })
      .from(googleAdsSearchTermsDaily)
      .where(and(gte(googleAdsSearchTermsDaily.dateStart, since), eq(googleAdsSearchTermsDaily.customerId, customerId)))
      .groupBy(googleAdsSearchTermsDaily.searchTerm, googleAdsSearchTermsDaily.campaignId)
      .orderBy(desc(sql`sum(${googleAdsSearchTermsDaily.conversions})`))
      .limit(50)
  ]);

  const campaignNameById = new Map<string, string>();
  for (const row of topCampaigns) {
    if (row.campaignId && row.campaignName) campaignNameById.set(row.campaignId, row.campaignName);
  }

  const normalizedTopSearchTerms = topSearchTerms.map((row) => {
    const inferred = campaignNameById.get(row.campaignId) ?? null;
    // Prefer the Top-campaigns name mapping when available so both tables stay consistent.
    return {
      ...row,
      campaignName: inferred ?? row.campaignName ?? null
    };
  });

  return NextResponse.json({
    ok: true,
    rangeDays,
    since,
    totals: totalsRow ?? {
      impressions: 0,
      clicks: 0,
      cost: "0",
      conversions: "0",
      conversionValue: "0",
      days: 0
    },
    topCampaigns,
    topSearchTerms: normalizedTopSearchTerms
  });
}
