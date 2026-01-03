import { sql } from "drizzle-orm";
import { getDb, metaAdsInsightsDaily } from "@/db";

export class MetaGraphApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`meta_graph_api_error:${status}`);
    this.status = status;
    this.body = body;
  }
}

type MetaInsightsRow = {
  date_start?: string;
  date_stop?: string;
  account_id?: string;
  account_currency?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  impressions?: string;
  clicks?: string;
  reach?: string;
  spend?: string;
};

type MetaInsightsResponse = {
  data?: MetaInsightsRow[];
  paging?: { next?: string };
};

type SyncResult = {
  processed: number;
  pages: number;
};

function parseIntLike(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseMoneyLike(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return "0.00";
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return "0.00";
    return parsed.toFixed(2);
  }
  return "0.00";
}

function normalizeAdAccountId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("act_")) return trimmed;
  return `act_${trimmed}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function syncMetaAdsInsightsDaily(input: {
  since: string;
  until: string;
}): Promise<SyncResult> {
  const accessToken =
    process.env["FB_MARKETING_ACCESS_TOKEN"] ??
    process.env["FB_LEADGEN_ACCESS_TOKEN"] ??
    "";
  const adAccountIdRaw = process.env["FB_AD_ACCOUNT_ID"] ?? "";

  if (!accessToken || !adAccountIdRaw) {
    throw new Error("meta_ads_insights_not_configured");
  }

  const adAccountId = normalizeAdAccountId(adAccountIdRaw);
  const accountIdValue = adAccountId.replace(/^act_/, "");
  const fields = [
    "date_start",
    "date_stop",
    "account_id",
    "account_currency",
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    "impressions",
    "clicks",
    "reach",
    "spend"
  ].join(",");

  const baseUrl = new URL(`https://graph.facebook.com/v24.0/${adAccountId}/insights`);
  baseUrl.searchParams.set("access_token", accessToken);
  baseUrl.searchParams.set("level", "ad");
  baseUrl.searchParams.set("time_increment", "1");
  baseUrl.searchParams.set("fields", fields);
  baseUrl.searchParams.set("limit", "500");
  baseUrl.searchParams.set("time_range[since]", input.since);
  baseUrl.searchParams.set("time_range[until]", input.until);

  const db = getDb();
  let nextUrl: string | null = baseUrl.toString();
  let processed = 0;
  let pages = 0;

  while (nextUrl) {
    pages += 1;
    const response: Response = await fetch(nextUrl, { method: "GET" });
    const text: string = await response.text();
    if (!response.ok) {
      throw new MetaGraphApiError(response.status, text);
    }

    const json: MetaInsightsResponse | null = (() => {
      try {
        return JSON.parse(text) as MetaInsightsResponse;
      } catch {
        return null;
      }
    })();

    if (!json || !Array.isArray(json.data)) {
      throw new Error("meta_ads_insights_invalid_response");
    }

    const rows = json.data;
    if (rows.length > 0) {
      const now = new Date();
      const values = rows
        .map((row: MetaInsightsRow) => {
          const dateStart = typeof row.date_start === "string" ? row.date_start : null;
          const entityId = typeof row.ad_id === "string" ? row.ad_id : null;
          if (!dateStart || !entityId) {
            return null;
          }

          const raw = isRecord(row) ? (row as Record<string, unknown>) : {};

          return {
            accountId: accountIdValue,
            level: "ad",
            entityId,
            dateStart,
            dateStop: typeof row.date_stop === "string" ? row.date_stop : null,
            currency: typeof row.account_currency === "string" ? row.account_currency : null,
            campaignId: typeof row.campaign_id === "string" ? row.campaign_id : null,
            campaignName: typeof row.campaign_name === "string" ? row.campaign_name : null,
            adsetId: typeof row.adset_id === "string" ? row.adset_id : null,
            adsetName: typeof row.adset_name === "string" ? row.adset_name : null,
            adId: typeof row.ad_id === "string" ? row.ad_id : null,
            adName: typeof row.ad_name === "string" ? row.ad_name : null,
            impressions: parseIntLike(row.impressions),
            clicks: parseIntLike(row.clicks),
            reach: parseIntLike(row.reach),
            spend: parseMoneyLike(row.spend),
            raw,
            fetchedAt: now
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));

      if (values.length > 0) {
        await db
          .insert(metaAdsInsightsDaily)
          .values(values)
          .onConflictDoUpdate({
            target: [
              metaAdsInsightsDaily.accountId,
              metaAdsInsightsDaily.level,
              metaAdsInsightsDaily.entityId,
              metaAdsInsightsDaily.dateStart
            ],
            set: {
              dateStop: sql`excluded.date_stop`,
              currency: sql`excluded.currency`,
              campaignId: sql`excluded.campaign_id`,
              campaignName: sql`excluded.campaign_name`,
              adsetId: sql`excluded.adset_id`,
              adsetName: sql`excluded.adset_name`,
              adId: sql`excluded.ad_id`,
              adName: sql`excluded.ad_name`,
              impressions: sql`excluded.impressions`,
              clicks: sql`excluded.clicks`,
              reach: sql`excluded.reach`,
              spend: sql`excluded.spend`,
              raw: sql`excluded.raw`,
              fetchedAt: now
            }
          });
        processed += values.length;
      }
    }

    nextUrl = typeof json.paging?.next === "string" ? json.paging.next : null;
  }

  return { processed, pages };
}
