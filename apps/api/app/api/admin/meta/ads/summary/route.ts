import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, gte, lt, lte, sql } from "drizzle-orm";
import { getDb, leads, metaAdsInsightsDaily } from "@/db";
import { isAdminRequest } from "../../../../web/admin";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseRange(request: NextRequest): { since: string; until: string } {
  const sinceParam = request.nextUrl.searchParams.get("since");
  const untilParam = request.nextUrl.searchParams.get("until");
  if (sinceParam && untilParam && isIsoDateString(sinceParam) && isIsoDateString(untilParam) && sinceParam <= untilParam) {
    return { since: sinceParam, until: untilParam };
  }

  const now = new Date();
  const until = isoDate(now);
  const sinceDate = new Date(now);
  sinceDate.setDate(sinceDate.getDate() - 29);
  const since = isoDate(sinceDate);
  return { since, until };
}

function parseLevel(request: NextRequest): "campaign" | "ad" {
  const level = request.nextUrl.searchParams.get("level");
  if (level === "ad") return "ad";
  return "campaign";
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { since, until } = parseRange(request);
  const level = parseLevel(request);
  const startAt = new Date(`${since}T00:00:00.000Z`);
  const endAt = new Date(`${until}T00:00:00.000Z`);
  endAt.setUTCDate(endAt.getUTCDate() + 1);

  const db = getDb();

  const idColumn = level === "ad" ? metaAdsInsightsDaily.adId : metaAdsInsightsDaily.campaignId;
  const nameColumn = level === "ad" ? metaAdsInsightsDaily.adName : metaAdsInsightsDaily.campaignName;

  const insights = await db
    .select({
      id: idColumn,
      name: sql<string | null>`max(${nameColumn})`,
      campaignId: sql<string | null>`max(${metaAdsInsightsDaily.campaignId})`,
      campaignName: sql<string | null>`max(${metaAdsInsightsDaily.campaignName})`,
      adsetId: sql<string | null>`max(${metaAdsInsightsDaily.adsetId})`,
      adsetName: sql<string | null>`max(${metaAdsInsightsDaily.adsetName})`,
      spend: sql<string>`coalesce(sum(${metaAdsInsightsDaily.spend}), 0)`,
      impressions: sql<number>`coalesce(sum(${metaAdsInsightsDaily.impressions}), 0)`,
      clicks: sql<number>`coalesce(sum(${metaAdsInsightsDaily.clicks}), 0)`,
      reach: sql<number>`coalesce(sum(${metaAdsInsightsDaily.reach}), 0)`
    })
    .from(metaAdsInsightsDaily)
    .where(
      and(
        eq(metaAdsInsightsDaily.level, "ad"),
        gte(metaAdsInsightsDaily.dateStart, since),
        lte(metaAdsInsightsDaily.dateStart, until)
      )
    )
    .groupBy(idColumn);

  const leadKeyExpr =
    level === "ad"
      ? sql<string | null>`(${leads.formPayload} ->> 'adId')`
      : sql<string | null>`(${leads.formPayload} ->> 'campaignId')`;

  const leadsByKey = await db
    .select({
      key: leadKeyExpr,
      leads: sql<number>`count(*)`,
      conversions: sql<number>`sum(case when ${leads.status} = 'scheduled' then 1 else 0 end)`
    })
    .from(leads)
    .where(and(eq(leads.source, "facebook_lead"), gte(leads.createdAt, startAt), lt(leads.createdAt, endAt)))
    .groupBy(leadKeyExpr);

  const leadsMap = new Map<string | null, { leads: number; conversions: number }>();
  for (const row of leadsByKey) {
    leadsMap.set(row.key ?? null, {
      leads: Number(row.leads ?? 0),
      conversions: Number(row.conversions ?? 0)
    });
  }

  const items = insights
    .map((row) => {
      const stats = leadsMap.get(row.id ?? null) ?? { leads: 0, conversions: 0 };
      const spend = toNumber(row.spend);
      const leadsCount = stats.leads;
      const convCount = stats.conversions;
      return {
        id: row.id ?? null,
        name: row.name ?? null,
        campaignId: row.campaignId ?? null,
        campaignName: row.campaignName ?? null,
        adsetId: row.adsetId ?? null,
        adsetName: row.adsetName ?? null,
        spend,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        reach: Number(row.reach ?? 0),
        leads: leadsCount,
        conversions: convCount,
        costPerLead: leadsCount > 0 ? spend / leadsCount : null,
        costPerConversion: convCount > 0 ? spend / convCount : null
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const totals = items.reduce(
    (acc, row) => {
      acc.spend += row.spend;
      acc.impressions += row.impressions;
      acc.clicks += row.clicks;
      acc.reach += row.reach;
      acc.leads += row.leads;
      acc.conversions += row.conversions ?? 0;
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, reach: 0, leads: 0, conversions: 0 }
  );

  return NextResponse.json({
    ok: true,
    level,
    since,
    until,
    totals: {
      ...totals,
      costPerLead: totals.leads > 0 ? totals.spend / totals.leads : null,
      costPerConversion: totals.conversions > 0 ? totals.spend / totals.conversions : null
    },
    items,
    ...(level === "campaign" ? { campaigns: items } : {}),
    ...(level === "ad" ? { ads: items } : {})
  });
}
