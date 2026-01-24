import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb, googleAdsConversionActions, googleAdsInsightsDaily, googleAdsSearchTermsDaily } from "@/db";
import { getGoogleAdsConfiguredIds } from "@/lib/google-ads-insights";
import { isAdminRequest } from "../../../../web/admin";

function parseRangeDays(request: NextRequest): number {
  const rangeDaysRaw = request.nextUrl.searchParams.get("rangeDays");
  const parsed = rangeDaysRaw ? Number(rangeDaysRaw) : NaN;
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(Math.max(Math.floor(parsed), 1), 30);
}

function normalizeDigits(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function classifyConversionAction(input: { name: string | null; category: string | null; type: string | null }): "call" | "booking" | "other" {
  const name = (input.name ?? "").toLowerCase();
  const category = (input.category ?? "").toLowerCase();
  const type = (input.type ?? "").toLowerCase();

  if (category.includes("phone_call") || type.includes("call") || name.includes("call")) {
    return "call";
  }

  if (name.includes("book") || name.includes("appointment") || name.includes("schedule") || name.includes("booking")) {
    return "booking";
  }

  return "other";
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
  const campaignIdRaw = request.nextUrl.searchParams.get("campaignId");
  const selectedCampaignId = campaignIdRaw ? normalizeDigits(campaignIdRaw) : "";
  const hasCampaignScope = selectedCampaignId.length > 0;

  const tz = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";
  const now = DateTime.now().setZone(tz);
  const since = now.minus({ days: rangeDays - 1 }).toISODate();
  if (!since) {
    return NextResponse.json({ ok: false, error: "invalid_time" }, { status: 500 });
  }

  const db = getDb();
  const [totalsRow, topCampaigns, topSearchTerms, conversionActionRows] = await Promise.all([
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
      .where(
        and(
          gte(googleAdsInsightsDaily.dateStart, since),
          eq(googleAdsInsightsDaily.customerId, customerId),
          ...(hasCampaignScope ? [eq(googleAdsInsightsDaily.campaignId, selectedCampaignId)] : [])
        )
      )
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
      .orderBy(desc(sql`sum(${googleAdsInsightsDaily.conversions})`), desc(sql`sum(${googleAdsInsightsDaily.cost})`))
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
      .where(
        and(
          gte(googleAdsSearchTermsDaily.dateStart, since),
          eq(googleAdsSearchTermsDaily.customerId, customerId),
          ...(hasCampaignScope ? [eq(googleAdsSearchTermsDaily.campaignId, selectedCampaignId)] : [])
        )
      )
      .groupBy(googleAdsSearchTermsDaily.searchTerm, googleAdsSearchTermsDaily.campaignId)
      .orderBy(
        desc(sql`sum(${googleAdsSearchTermsDaily.conversions})`),
        desc(sql`sum(${googleAdsSearchTermsDaily.clicks})`),
        desc(sql`sum(${googleAdsSearchTermsDaily.cost})`)
      )
      .limit(50)
    ,
    db
      .select({
        name: googleAdsConversionActions.name,
        category: googleAdsConversionActions.category,
        type: googleAdsConversionActions.type,
        status: googleAdsConversionActions.status
      })
      .from(googleAdsConversionActions)
      .where(eq(googleAdsConversionActions.customerId, customerId))
      .limit(250)
  ]);

  const campaignNameById = new Map<string, string>();
  for (const row of topCampaigns) {
    if (row.campaignId && row.campaignName) campaignNameById.set(row.campaignId, row.campaignName);
  }

  const selectedCampaignName = hasCampaignScope ? campaignNameById.get(selectedCampaignId) ?? null : null;

  const normalizedTopSearchTerms = topSearchTerms.map((row) => {
    const inferred = campaignNameById.get(row.campaignId) ?? null;
    // Prefer the Top-campaigns name mapping when available so both tables stay consistent.
    return {
      ...row,
      campaignName: inferred ?? row.campaignName ?? null
    };
  });

  const conversionActions = conversionActionRows
    .filter((row) => (row.status ?? "").toUpperCase() !== "REMOVED")
    .map((row) => ({
      name: row.name ?? null,
      category: row.category ?? null,
      type: row.type ?? null,
      cls: classifyConversionAction({ name: row.name ?? null, category: row.category ?? null, type: row.type ?? null })
    }));

  const callConversionActions = conversionActions.filter((row) => row.cls === "call").map((row) => row.name).filter(Boolean) as string[];
  const bookingConversionActions = conversionActions.filter((row) => row.cls === "booking").map((row) => row.name).filter(Boolean) as string[];

  return NextResponse.json({
    ok: true,
    rangeDays,
    since,
    scope: {
      campaignId: hasCampaignScope ? selectedCampaignId : null,
      campaignName: selectedCampaignName
    },
    totals: totalsRow ?? {
      impressions: 0,
      clicks: 0,
      cost: "0",
      conversions: "0",
      conversionValue: "0",
      days: 0
    },
    topCampaigns,
    topSearchTerms: normalizedTopSearchTerms,
    diagnostics: {
      conversionActionsTotal: conversionActions.length,
      callConversionActions,
      bookingConversionActions
    }
  });
}
