import { sql } from "drizzle-orm";
import { getDb, googleAdsInsightsDaily, googleAdsSearchTermsDaily } from "@/db";

export class GoogleAdsApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`google_ads_api_error:${status}`);
    this.status = status;
    this.body = body;
  }
}

type SyncResult = {
  campaigns: number;
  searchTerms: number;
};

function normalizeCustomerId(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function readNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function microsToDollars(micros: number): string {
  const dollars = micros / 1_000_000;
  return Number.isFinite(dollars) ? dollars.toFixed(2) : "0.00";
}

function floatToNumeric(value: unknown): string {
  const num = readNumber(value);
  return Number.isFinite(num) ? num.toFixed(2) : "0.00";
}

export async function getGoogleAdsAccessToken(): Promise<string> {
  const clientId = process.env["GOOGLE_ADS_CLIENT_ID"] ?? "";
  const clientSecret = process.env["GOOGLE_ADS_CLIENT_SECRET"] ?? "";
  const refreshToken = process.env["GOOGLE_ADS_REFRESH_TOKEN"] ?? "";

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("google_ads_not_configured");
  }

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("refresh_token", refreshToken);
  body.set("grant_type", "refresh_token");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const text = await response.text();
  if (!response.ok) {
    throw new GoogleAdsApiError(response.status, text);
  }

  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  const token = json && typeof json.access_token === "string" ? json.access_token : null;
  if (!token) {
    throw new Error("google_ads_token_missing");
  }
  return token;
}

async function googleAdsSearchStream(input: {
  customerId: string;
  accessToken: string;
  query: string;
}): Promise<Array<Record<string, unknown>>> {
  const developerToken = process.env["GOOGLE_ADS_DEVELOPER_TOKEN"] ?? "";
  if (!developerToken) {
    throw new Error("google_ads_not_configured");
  }

  const apiVersionRaw = (process.env["GOOGLE_ADS_API_VERSION"] ?? "v17").trim();
  const apiVersion = apiVersionRaw.startsWith("v") ? apiVersionRaw : `v${apiVersionRaw}`;

  const loginCustomerIdRaw = process.env["GOOGLE_ADS_LOGIN_CUSTOMER_ID"] ?? "";
  const loginCustomerId = loginCustomerIdRaw ? normalizeCustomerId(loginCustomerIdRaw) : null;

  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${input.customerId}/googleAds:searchStream`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: input.query
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new GoogleAdsApiError(response.status, text);
  }

  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!Array.isArray(json)) {
    throw new Error("google_ads_invalid_response");
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const chunk of json) {
    if (!isRecord(chunk)) continue;
    const results = chunk["results"];
    if (!Array.isArray(results)) continue;
    for (const row of results) {
      if (isRecord(row)) rows.push(row);
    }
  }

  return rows;
}

function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function syncGoogleAdsInsightsDaily(input: { since: string; until: string }): Promise<SyncResult> {
  const customerIdRaw = process.env["GOOGLE_ADS_CUSTOMER_ID"] ?? "";
  const customerId = normalizeCustomerId(customerIdRaw);
  if (!customerId) {
    throw new Error("google_ads_not_configured");
  }

  if (!isIsoDateString(input.since) || !isIsoDateString(input.until) || input.since > input.until) {
    throw new Error("google_ads_invalid_date_range");
  }

  const accessToken = await getGoogleAdsAccessToken();
  const db = getDb();
  const fetchedAt = new Date();

  const campaignQuery = `
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE
      segments.date BETWEEN '${input.since}' AND '${input.until}'
      AND campaign.status != 'REMOVED'
  `.trim();

  const campaignRows = await googleAdsSearchStream({ customerId, accessToken, query: campaignQuery });

  const campaignValues = campaignRows
    .map((row) => {
      const segments = isRecord(row["segments"]) ? (row["segments"] as Record<string, unknown>) : null;
      const metrics = isRecord(row["metrics"]) ? (row["metrics"] as Record<string, unknown>) : null;
      const campaign = isRecord(row["campaign"]) ? (row["campaign"] as Record<string, unknown>) : null;
      const dateStart = readString(segments?.["date"]);
      const campaignId = readString(campaign?.["id"]);
      if (!dateStart || !campaignId) return null;

      const costMicros = readNumber(metrics?.["costMicros"] ?? metrics?.["cost_micros"]);
      return {
        customerId,
        dateStart,
        campaignId,
        campaignName: readString(campaign?.["name"]),
        impressions: Math.trunc(readNumber(metrics?.["impressions"])),
        clicks: Math.trunc(readNumber(metrics?.["clicks"])),
        cost: microsToDollars(costMicros),
        conversions: floatToNumeric(metrics?.["conversions"]),
        conversionValue: floatToNumeric(metrics?.["conversionsValue"] ?? metrics?.["conversions_value"]),
        raw: row,
        fetchedAt
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  if (campaignValues.length > 0) {
    await db
      .insert(googleAdsInsightsDaily)
      .values(campaignValues)
      .onConflictDoUpdate({
        target: [
          googleAdsInsightsDaily.customerId,
          googleAdsInsightsDaily.dateStart,
          googleAdsInsightsDaily.campaignId
        ],
        set: {
          campaignName: sql`excluded.campaign_name`,
          impressions: sql`excluded.impressions`,
          clicks: sql`excluded.clicks`,
          cost: sql`excluded.cost`,
          conversions: sql`excluded.conversions`,
          conversionValue: sql`excluded.conversion_value`,
          raw: sql`excluded.raw`,
          fetchedAt
        }
      });
  }

  const searchTermsQuery = `
    SELECT
      segments.date,
      campaign.id,
      ad_group.id,
      search_term_view.search_term,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM search_term_view
    WHERE
      segments.date BETWEEN '${input.since}' AND '${input.until}'
      AND campaign.status != 'REMOVED'
  `.trim();

  const searchTermRows = await googleAdsSearchStream({ customerId, accessToken, query: searchTermsQuery });

  const searchTermValues = searchTermRows
    .map((row) => {
      const segments = isRecord(row["segments"]) ? (row["segments"] as Record<string, unknown>) : null;
      const metrics = isRecord(row["metrics"]) ? (row["metrics"] as Record<string, unknown>) : null;
      const campaign = isRecord(row["campaign"]) ? (row["campaign"] as Record<string, unknown>) : null;
      const adGroup = isRecord(row["adGroup"]) ? (row["adGroup"] as Record<string, unknown>) : null;
      const searchTermView = isRecord(row["searchTermView"])
        ? (row["searchTermView"] as Record<string, unknown>)
        : isRecord(row["searchTermView"] ?? null)
          ? (row["searchTermView"] as Record<string, unknown>)
          : null;

      const dateStart = readString(segments?.["date"]);
      const campaignId = readString(campaign?.["id"]);
      const adGroupId = readString(adGroup?.["id"]);
      const searchTerm = readString(searchTermView?.["searchTerm"] ?? searchTermView?.["search_term"]);
      if (!dateStart || !campaignId || !adGroupId || !searchTerm) return null;

      const costMicros = readNumber(metrics?.["costMicros"] ?? metrics?.["cost_micros"]);

      return {
        customerId,
        dateStart,
        campaignId,
        adGroupId,
        searchTerm,
        impressions: Math.trunc(readNumber(metrics?.["impressions"])),
        clicks: Math.trunc(readNumber(metrics?.["clicks"])),
        cost: microsToDollars(costMicros),
        conversions: floatToNumeric(metrics?.["conversions"]),
        conversionValue: floatToNumeric(metrics?.["conversionsValue"] ?? metrics?.["conversions_value"]),
        raw: row,
        fetchedAt
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  if (searchTermValues.length > 0) {
    await db
      .insert(googleAdsSearchTermsDaily)
      .values(searchTermValues)
      .onConflictDoUpdate({
        target: [
          googleAdsSearchTermsDaily.customerId,
          googleAdsSearchTermsDaily.dateStart,
          googleAdsSearchTermsDaily.campaignId,
          googleAdsSearchTermsDaily.adGroupId,
          googleAdsSearchTermsDaily.searchTerm
        ],
        set: {
          impressions: sql`excluded.impressions`,
          clicks: sql`excluded.clicks`,
          cost: sql`excluded.cost`,
          conversions: sql`excluded.conversions`,
          conversionValue: sql`excluded.conversion_value`,
          raw: sql`excluded.raw`,
          fetchedAt
        }
      });
  }

  return { campaigns: campaignValues.length, searchTerms: searchTermValues.length };
}
