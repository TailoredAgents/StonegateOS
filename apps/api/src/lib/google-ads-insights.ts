import { sql } from "drizzle-orm";
import {
  resolveGoogleAdsApiEndpoint,
  resolveGoogleAdsTokenEndpoint,
} from "@myst-os/sdk";
import {
  getDb,
  googleAdsCampaignConversionsDaily,
  googleAdsConversionActions,
  googleAdsInsightsDaily,
  googleAdsSearchTermsDaily,
} from "@/db";

export class GoogleAdsApiError extends Error {
  readonly status: number;
  readonly failureCode: string;

  constructor(status: number, failureCode?: string) {
    const safeFailureCode =
      failureCode ?? `google_ads_provider_http_${String(status)}`;
    super(safeFailureCode);
    this.name = "GoogleAdsApiError";
    this.status = status;
    this.failureCode = safeFailureCode;
  }
}

export type GoogleAdsMutationFailureCertainty =
  | "confirmed_failed"
  | "uncertain";

/**
 * Safe, persistence-ready classification for a Google Ads mutate request.
 * The provider response body is intentionally excluded: it can contain
 * account details and is not needed to decide whether redispatch is safe.
 */
export class GoogleAdsMutationDispatchError extends Error {
  readonly certainty: GoogleAdsMutationFailureCertainty;
  readonly failureCode: string;
  readonly providerStatus: number | null;

  constructor(input: {
    certainty: GoogleAdsMutationFailureCertainty;
    failureCode: string;
    providerStatus?: number | null;
  }) {
    super(input.failureCode);
    this.name = "GoogleAdsMutationDispatchError";
    this.certainty = input.certainty;
    this.failureCode = input.failureCode;
    this.providerStatus = input.providerStatus ?? null;
  }
}

type SyncResult = {
  campaigns: number;
  searchTerms: number;
  conversionActions: number;
  campaignConversions: number;
};

type GoogleAdsKeywordMatchType = "BROAD" | "PHRASE" | "EXACT";

function normalizeCustomerId(value: string, field: string): string {
  const supplied = value.trim();
  if (!supplied) return "";
  if (!/^(?:\d{10}|\d{3}-\d{3}-\d{4})$/u.test(supplied)) {
    throw new Error(`google_ads_invalid_${field}`);
  }
  return supplied.replaceAll("-", "");
}

export function getGoogleAdsConfiguredIds(): {
  customerId: string | null;
  loginCustomerId: string | null;
  apiVersion: string;
} {
  const customerIdRaw = process.env["GOOGLE_ADS_CUSTOMER_ID"] ?? "";
  const customerId = normalizeCustomerId(customerIdRaw, "customer_id");

  const loginCustomerIdRaw = process.env["GOOGLE_ADS_LOGIN_CUSTOMER_ID"] ?? "";
  const loginCustomerId = loginCustomerIdRaw
    ? normalizeCustomerId(loginCustomerIdRaw, "login_customer_id")
    : null;

  // v25 is the current major version as of 2026-08. v20 is already sunset,
  // and v21 reaches its tentative sunset this month. Keep this overrideable
  // for a controlled future upgrade, but never default to a dead endpoint.
  const apiVersionRaw = (process.env["GOOGLE_ADS_API_VERSION"] ?? "v25").trim();
  const apiVersion = apiVersionRaw.startsWith("v")
    ? apiVersionRaw
    : `v${apiVersionRaw}`;

  return {
    customerId: customerId || null,
    loginCustomerId,
    apiVersion,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseConversionActionIdFromResourceName(
  resourceName: string,
): string | null {
  // customers/{customerId}/conversionActions/{conversionActionId}
  const parts = resourceName.split("/").filter((part) => part.length > 0);
  const idx = parts.findIndex((part) => part === "conversionActions");
  if (idx < 0) return null;
  const actionId = parts[idx + 1];
  return actionId && /^\d+$/.test(actionId) ? actionId : null;
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

  const response = await fetch(resolveGoogleAdsTokenEndpoint(process.env), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleAdsApiError(response.status);
  }

  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }

  const token = isRecord(json) ? readString(json["access_token"]) : null;
  if (!token) {
    throw new Error("google_ads_token_missing");
  }
  return token;
}

export async function listGoogleAdsAccessibleCustomers(input: {
  accessToken: string;
}): Promise<string[]> {
  const developerToken = process.env["GOOGLE_ADS_DEVELOPER_TOKEN"] ?? "";
  if (!developerToken) {
    throw new Error("google_ads_not_configured");
  }

  const { apiVersion, loginCustomerId } = getGoogleAdsConfiguredIds();

  const url = resolveGoogleAdsApiEndpoint(
    { kind: "accessible_customers", apiVersion },
    process.env,
  );
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleAdsApiError(response.status);
  }

  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }

  if (!isRecord(json) || !Array.isArray(json["resourceNames"])) {
    throw new Error("google_ads_accessible_customers_invalid_response");
  }
  const names: string[] = [];
  for (const value of json["resourceNames"]) {
    if (typeof value !== "string" || !/^customers\/\d{10}$/u.test(value)) {
      throw new Error("google_ads_accessible_customers_invalid_response");
    }
    names.push(value);
  }
  return names;
}

export async function googleAdsSearchStream(input: {
  customerId: string;
  accessToken: string;
  query: string;
}): Promise<Array<Record<string, unknown>>> {
  const developerToken = process.env["GOOGLE_ADS_DEVELOPER_TOKEN"] ?? "";
  if (!developerToken) {
    throw new Error("google_ads_not_configured");
  }

  // As of Jan 2026, googleads.googleapis.com no longer serves v17 (returns 404 HTML).
  // Default to a currently served version; still overrideable via env var.
  const { apiVersion, loginCustomerId } = getGoogleAdsConfiguredIds();

  const url = resolveGoogleAdsApiEndpoint(
    {
      kind: "search_stream",
      apiVersion,
      customerId: input.customerId,
    },
    process.env,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: input.query,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404 && contentType.includes("text/html")) {
      throw new Error(`google_ads_endpoint_not_found:${apiVersion}`);
    }
    throw new GoogleAdsApiError(response.status);
  }

  const text = await response.text();
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
    if (!isRecord(chunk)) {
      throw new Error("google_ads_invalid_response");
    }
    const results = chunk["results"];
    if (!Array.isArray(results)) {
      throw new Error("google_ads_invalid_response");
    }
    for (const row of results) {
      if (!isRecord(row)) {
        throw new Error("google_ads_invalid_response");
      }
      rows.push(row);
    }
  }

  return rows;
}

async function googleAdsMutate(input: {
  customerId: string;
  accessToken: string;
  body: Record<string, unknown>;
}): Promise<{ body: Record<string, unknown>; status: number }> {
  const developerToken = process.env["GOOGLE_ADS_DEVELOPER_TOKEN"] ?? "";
  if (!developerToken) {
    throw new Error("google_ads_not_configured");
  }

  const { apiVersion, loginCustomerId } = getGoogleAdsConfiguredIds();

  let url: string;
  try {
    url = resolveGoogleAdsApiEndpoint(
      {
        kind: "mutate_customer_negative_criteria",
        apiVersion,
        customerId: input.customerId,
      },
      process.env,
    );
  } catch {
    throw new GoogleAdsMutationDispatchError({
      certainty: "confirmed_failed",
      failureCode: "google_ads_mutation_endpoint_invalid",
    });
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "developer-token": developerToken,
        ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // Once fetch begins, a timeout or connection failure cannot prove that
    // Google did not accept the mutation. The caller must quarantine it.
    throw new GoogleAdsMutationDispatchError({
      certainty: "uncertain",
      failureCode: "google_ads_mutation_transport_uncertain",
    });
  }

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404 && contentType.includes("text/html")) {
      throw new GoogleAdsMutationDispatchError({
        certainty: "confirmed_failed",
        failureCode: `google_ads_endpoint_not_found:${apiVersion}`,
        providerStatus: response.status,
      });
    }
    const uncertain = response.status >= 500 || response.status === 408;
    throw new GoogleAdsMutationDispatchError({
      certainty: uncertain ? "uncertain" : "confirmed_failed",
      failureCode: uncertain
        ? `google_ads_mutation_provider_uncertain:${response.status}`
        : `google_ads_mutation_rejected:${response.status}`,
      providerStatus: response.status,
    });
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new GoogleAdsMutationDispatchError({
      certainty: "uncertain",
      failureCode: "google_ads_mutation_response_unreadable",
      providerStatus: response.status,
    });
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!isRecord(json)) {
    throw new GoogleAdsMutationDispatchError({
      certainty: "uncertain",
      failureCode: "google_ads_mutation_invalid_success_response",
      providerStatus: response.status,
    });
  }

  return { body: json, status: response.status };
}

export function normalizeGoogleAdsNegativeKeywordTerm(input: string): {
  term: string;
  matchType: GoogleAdsKeywordMatchType;
} {
  let term = input.trim();
  if (term.startsWith("[") && term.endsWith("]") && term.length > 2) {
    term = term.slice(1, -1).trim();
    return { term, matchType: "EXACT" };
  }
  if (term.startsWith('"') && term.endsWith('"') && term.length > 2) {
    term = term.slice(1, -1).trim();
    return { term, matchType: "PHRASE" };
  }
  if (/\s/.test(term)) {
    return { term, matchType: "PHRASE" };
  }
  return { term, matchType: "BROAD" };
}

function readResourceName(
  result: unknown,
  expectedCustomerId: string,
): string | null {
  if (!isRecord(result)) return null;
  const resourceName = result["resourceName"];
  if (typeof resourceName !== "string") return null;
  const match = resourceName.match(
    /^customers\/(\d{10})\/customerNegativeCriteria\/(\d+)$/u,
  );
  return match?.[1] === expectedCustomerId ? resourceName : null;
}

export async function applyCustomerNegativeKeyword(input: {
  customerId: string;
  accessToken: string;
  term: string;
}): Promise<{
  resourceName: string;
  term: string;
  matchType: GoogleAdsKeywordMatchType;
  providerStatus: number;
}> {
  const customerId = normalizeCustomerId(input.customerId, "customer_id");
  if (!customerId) {
    throw new Error("google_ads_invalid_customer_id");
  }
  const normalized = normalizeGoogleAdsNegativeKeywordTerm(input.term);
  const term = normalized.term;

  if (!term) {
    throw new Error("google_ads_negative_term_empty");
  }
  if (term.length > 80) {
    throw new Error("google_ads_negative_term_too_long");
  }

  const body = {
    operations: [
      {
        create: {
          keyword: {
            text: term,
            matchType: normalized.matchType,
          },
        },
      },
    ],
    partialFailure: false,
  };

  const response = await googleAdsMutate({
    customerId,
    accessToken: input.accessToken,
    body,
  });

  const results = Array.isArray(response.body["results"])
    ? (response.body["results"] as unknown[])
    : [];
  const resourceName =
    results.length === 1 ? readResourceName(results[0], customerId) : null;
  if (!resourceName) {
    throw new GoogleAdsMutationDispatchError({
      certainty: "uncertain",
      failureCode: "google_ads_mutation_invalid_resource_name",
      providerStatus: response.status,
    });
  }

  return {
    resourceName,
    term,
    matchType: normalized.matchType,
    providerStatus: response.status,
  };
}

function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function syncGoogleAdsInsightsDaily(input: {
  since: string;
  until: string;
}): Promise<SyncResult> {
  const { customerId } = getGoogleAdsConfiguredIds();
  if (!customerId) {
    throw new Error("google_ads_not_configured");
  }
  if (customerId.length !== 10) {
    throw new Error(`google_ads_invalid_customer_id:${customerId}`);
  }

  if (
    !isIsoDateString(input.since) ||
    !isIsoDateString(input.until) ||
    input.since > input.until
  ) {
    throw new Error("google_ads_invalid_date_range");
  }

  const accessToken = await getGoogleAdsAccessToken();
  const db = getDb();
  const fetchedAt = new Date();

  // 1) Conversion actions (used to label conversions later as calls vs bookings).
  const conversionActionQuery = `
    SELECT
      conversion_action.resource_name,
      conversion_action.id,
      conversion_action.name,
      conversion_action.category,
      conversion_action.type,
      conversion_action.status
    FROM conversion_action
    WHERE conversion_action.status != 'REMOVED'
  `.trim();

  const conversionActionRows = await googleAdsSearchStream({
    customerId,
    accessToken,
    query: conversionActionQuery,
  });

  const conversionActionValues = conversionActionRows
    .map((row) => {
      const conversionAction = isRecord(row["conversionAction"])
        ? row["conversionAction"]
        : isRecord(row["conversion_action"])
          ? row["conversion_action"]
          : null;

      const resourceName = readString(
        conversionAction?.["resourceName"] ??
          conversionAction?.["resource_name"],
      );
      const actionId = readString(conversionAction?.["id"]);
      const name = readString(conversionAction?.["name"]);
      if (!resourceName || !actionId || !name) return null;

      return {
        customerId,
        resourceName,
        actionId,
        name,
        category: readString(conversionAction?.["category"]),
        type: readString(conversionAction?.["type"]),
        status: readString(conversionAction?.["status"]),
        raw: row,
        fetchedAt,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  if (conversionActionValues.length > 0) {
    await db
      .insert(googleAdsConversionActions)
      .values(conversionActionValues)
      .onConflictDoUpdate({
        target: [
          googleAdsConversionActions.customerId,
          googleAdsConversionActions.actionId,
        ],
        set: {
          resourceName: sql`excluded.resource_name`,
          name: sql`excluded.name`,
          category: sql`excluded.category`,
          type: sql`excluded.type`,
          status: sql`excluded.status`,
          raw: sql`excluded.raw`,
          fetchedAt,
        },
      });
  }

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

  const campaignRows = await googleAdsSearchStream({
    customerId,
    accessToken,
    query: campaignQuery,
  });

  const campaignValues = campaignRows
    .map((row) => {
      const segments = isRecord(row["segments"]) ? row["segments"] : null;
      const metrics = isRecord(row["metrics"]) ? row["metrics"] : null;
      const campaign = isRecord(row["campaign"]) ? row["campaign"] : null;
      const dateStart = readString(segments?.["date"]);
      const campaignId = readString(campaign?.["id"]);
      if (!dateStart || !campaignId) return null;

      const costMicros = readNumber(
        metrics?.["costMicros"] ?? metrics?.["cost_micros"],
      );
      return {
        customerId,
        dateStart,
        campaignId,
        campaignName: readString(campaign?.["name"]),
        impressions: Math.trunc(readNumber(metrics?.["impressions"])),
        clicks: Math.trunc(readNumber(metrics?.["clicks"])),
        cost: microsToDollars(costMicros),
        conversions: floatToNumeric(metrics?.["conversions"]),
        conversionValue: floatToNumeric(
          metrics?.["conversionsValue"] ?? metrics?.["conversions_value"],
        ),
        raw: row,
        fetchedAt,
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
          googleAdsInsightsDaily.campaignId,
        ],
        set: {
          campaignName: sql`excluded.campaign_name`,
          impressions: sql`excluded.impressions`,
          clicks: sql`excluded.clicks`,
          cost: sql`excluded.cost`,
          conversions: sql`excluded.conversions`,
          conversionValue: sql`excluded.conversion_value`,
          raw: sql`excluded.raw`,
          fetchedAt,
        },
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

  const searchTermRows = await googleAdsSearchStream({
    customerId,
    accessToken,
    query: searchTermsQuery,
  });

  const searchTermValues = searchTermRows
    .map((row) => {
      const segments = isRecord(row["segments"]) ? row["segments"] : null;
      const metrics = isRecord(row["metrics"]) ? row["metrics"] : null;
      const campaign = isRecord(row["campaign"]) ? row["campaign"] : null;
      const adGroup = isRecord(row["adGroup"]) ? row["adGroup"] : null;
      const searchTermView = isRecord(row["searchTermView"])
        ? row["searchTermView"]
        : isRecord(row["search_term_view"])
          ? row["search_term_view"]
          : null;

      const dateStart = readString(segments?.["date"]);
      const campaignId = readString(campaign?.["id"]);
      const adGroupId = readString(adGroup?.["id"]);
      const searchTerm = readString(
        searchTermView?.["searchTerm"] ?? searchTermView?.["search_term"],
      );
      if (!dateStart || !campaignId || !adGroupId || !searchTerm) return null;

      const costMicros = readNumber(
        metrics?.["costMicros"] ?? metrics?.["cost_micros"],
      );

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
        conversionValue: floatToNumeric(
          metrics?.["conversionsValue"] ?? metrics?.["conversions_value"],
        ),
        raw: row,
        fetchedAt,
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
          googleAdsSearchTermsDaily.searchTerm,
        ],
        set: {
          impressions: sql`excluded.impressions`,
          clicks: sql`excluded.clicks`,
          cost: sql`excluded.cost`,
          conversions: sql`excluded.conversions`,
          conversionValue: sql`excluded.conversion_value`,
          raw: sql`excluded.raw`,
          fetchedAt,
        },
      });
  }

  // 2) Campaign conversions broken down by conversion action.
  const campaignConversionsQuery = `
    SELECT
      segments.date,
      campaign.id,
      segments.conversion_action,
      segments.conversion_action_name,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE
      segments.date BETWEEN '${input.since}' AND '${input.until}'
      AND campaign.status != 'REMOVED'
  `.trim();

  const campaignConversionRows = await googleAdsSearchStream({
    customerId,
    accessToken,
    query: campaignConversionsQuery,
  });

  const campaignConversionValues = campaignConversionRows
    .map((row) => {
      const segments = isRecord(row["segments"]) ? row["segments"] : null;
      const metrics = isRecord(row["metrics"]) ? row["metrics"] : null;
      const campaign = isRecord(row["campaign"]) ? row["campaign"] : null;

      const dateStart = readString(segments?.["date"]);
      const campaignId = readString(campaign?.["id"]);

      const conversionActionResource = readString(
        segments?.["conversionAction"] ?? segments?.["conversion_action"],
      );
      const conversionActionName = readString(
        segments?.["conversionActionName"] ??
          segments?.["conversion_action_name"],
      );

      if (!dateStart || !campaignId || !conversionActionResource) return null;
      const conversionActionId = parseConversionActionIdFromResourceName(
        conversionActionResource,
      );
      if (!conversionActionId) return null;

      return {
        customerId,
        dateStart,
        campaignId,
        conversionActionId,
        conversionActionName,
        conversions: floatToNumeric(metrics?.["conversions"]),
        conversionValue: floatToNumeric(
          metrics?.["conversionsValue"] ?? metrics?.["conversions_value"],
        ),
        raw: row,
        fetchedAt,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  if (campaignConversionValues.length > 0) {
    await db
      .insert(googleAdsCampaignConversionsDaily)
      .values(campaignConversionValues)
      .onConflictDoUpdate({
        target: [
          googleAdsCampaignConversionsDaily.customerId,
          googleAdsCampaignConversionsDaily.dateStart,
          googleAdsCampaignConversionsDaily.campaignId,
          googleAdsCampaignConversionsDaily.conversionActionId,
        ],
        set: {
          conversionActionName: sql`excluded.conversion_action_name`,
          conversions: sql`excluded.conversions`,
          conversionValue: sql`excluded.conversion_value`,
          raw: sql`excluded.raw`,
          fetchedAt,
        },
      });
  }

  return {
    campaigns: campaignValues.length,
    searchTerms: searchTermValues.length,
    conversionActions: conversionActionValues.length,
    campaignConversions: campaignConversionValues.length,
  };
}
