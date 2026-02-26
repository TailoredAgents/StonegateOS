import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb, googleAdsInsightsDaily } from "@/db";
import { getGoogleAdsConfiguredIds } from "@/lib/google-ads-insights";
import { isAdminRequest } from "../../../../web/admin";

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeDigits(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function pickDate(request: NextRequest): { ok: true; date: string } | { ok: false; status: number; error: string } {
  const tz = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";

  const dateRaw = request.nextUrl.searchParams.get("date");
  if (dateRaw) {
    const date = dateRaw.trim();
    if (!isIsoDate(date)) return { ok: false, status: 400, error: "invalid_date" };
    return { ok: true, date };
  }

  const relative = (request.nextUrl.searchParams.get("relative") ?? "").trim().toLowerCase();
  if (!relative) return { ok: false, status: 400, error: "missing_date" };

  const now = DateTime.now().setZone(tz);
  if (!now.isValid) return { ok: false, status: 500, error: "invalid_time" };

  if (relative === "today") {
    const date = now.toISODate();
    if (!date) return { ok: false, status: 500, error: "invalid_time" };
    return { ok: true, date };
  }

  if (relative === "yesterday") {
    const date = now.minus({ days: 1 }).toISODate();
    if (!date) return { ok: false, status: 500, error: "invalid_time" };
    return { ok: true, date };
  }

  return { ok: false, status: 400, error: "invalid_relative" };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { customerId } = getGoogleAdsConfiguredIds();
  if (!customerId) {
    return NextResponse.json({ ok: false, error: "google_ads_not_configured" }, { status: 400 });
  }

  const picked = pickDate(request);
  if (!picked.ok) {
    return NextResponse.json({ ok: false, error: picked.error }, { status: picked.status });
  }

  const campaignIdRaw = request.nextUrl.searchParams.get("campaignId");
  const selectedCampaignId = campaignIdRaw ? normalizeDigits(campaignIdRaw) : "";
  const hasCampaignScope = selectedCampaignId.length > 0;

  const db = getDb();
  const totals = await db
    .select({
      impressions: sql<number>`coalesce(sum(${googleAdsInsightsDaily.impressions}), 0)`.mapWith(Number),
      clicks: sql<number>`coalesce(sum(${googleAdsInsightsDaily.clicks}), 0)`.mapWith(Number),
      cost: sql<string>`coalesce(sum(${googleAdsInsightsDaily.cost}), 0)::text`,
      conversions: sql<string>`coalesce(sum(${googleAdsInsightsDaily.conversions}), 0)::text`,
      conversionValue: sql<string>`coalesce(sum(${googleAdsInsightsDaily.conversionValue}), 0)::text`
    })
    .from(googleAdsInsightsDaily)
    .where(
      and(
        eq(googleAdsInsightsDaily.customerId, customerId),
        eq(googleAdsInsightsDaily.dateStart, picked.date),
        ...(hasCampaignScope ? [eq(googleAdsInsightsDaily.campaignId, selectedCampaignId)] : [])
      )
    )
    .then((rows) => rows[0] ?? null);

  return NextResponse.json({
    ok: true,
    date: picked.date,
    scope: {
      campaignId: hasCampaignScope ? selectedCampaignId : null
    },
    totals: totals ?? {
      impressions: 0,
      clicks: 0,
      cost: "0",
      conversions: "0",
      conversionValue: "0"
    }
  });
}

