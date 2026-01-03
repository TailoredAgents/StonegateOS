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
  const startAt = new Date(`${since}T00:00:00.000Z`);
  const endAt = new Date(`${until}T00:00:00.000Z`);
  endAt.setUTCDate(endAt.getUTCDate() + 1);

  const db = getDb();

  const insightsByCampaign = await db
    .select({
      campaignId: metaAdsInsightsDaily.campaignId,
      campaignName: sql<string | null>`max(${metaAdsInsightsDaily.campaignName})`,
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
    .groupBy(metaAdsInsightsDaily.campaignId);

  const leadsByCampaign = await db
    .select({
      campaignId: sql<string | null>`(${leads.formPayload} ->> 'campaignId')`,
      count: sql<number>`count(*)`
    })
    .from(leads)
    .where(and(eq(leads.source, "facebook_lead"), gte(leads.createdAt, startAt), lt(leads.createdAt, endAt)))
    .groupBy(sql`(${leads.formPayload} ->> 'campaignId')`);

  const leadsMap = new Map<string | null, number>();
  for (const row of leadsByCampaign) {
    leadsMap.set(row.campaignId ?? null, Number(row.count ?? 0));
  }

  const campaigns = insightsByCampaign
    .map((row) => {
      const spend = toNumber(row.spend);
      const leadsCount = leadsMap.get(row.campaignId ?? null) ?? 0;
      return {
        campaignId: row.campaignId ?? null,
        campaignName: row.campaignName ?? null,
        spend,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        reach: Number(row.reach ?? 0),
        leads: leadsCount,
        costPerLead: leadsCount > 0 ? spend / leadsCount : null
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const totals = campaigns.reduce(
    (acc, row) => {
      acc.spend += row.spend;
      acc.impressions += row.impressions;
      acc.clicks += row.clicks;
      acc.reach += row.reach;
      acc.leads += row.leads;
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, reach: 0, leads: 0 }
  );

  return NextResponse.json({
    ok: true,
    since,
    until,
    totals: {
      ...totals,
      costPerLead: totals.leads > 0 ? totals.spend / totals.leads : null
    },
    campaigns
  });
}

