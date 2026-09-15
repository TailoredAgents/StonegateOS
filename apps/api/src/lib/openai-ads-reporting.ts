import { isControlledProviderTestRuntime } from "@myst-os/sdk";
import { z } from "zod";
import type { WebsiteAnalyticsTimeframe } from "@/lib/web-analytics-reporting";

type Environment = Readonly<Record<string, string | undefined>>;
const MAX_REPORT_PAGES = 5;
const PAGE_SIZE = 2000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const OPENAI_ADS_REPORTING_TIMEOUT_MS = 8000;

export class OpenAiAdsReportingError extends Error {
  constructor(
    readonly code: string,
    readonly status: 502 | 503 = 502,
  ) {
    super(code);
    this.name = "OpenAiAdsReportingError";
  }
}

const amount = z.number().finite().nonnegative();
const count = amount.int().safe();
const metricsSchema = z.object({
  // Null and omitted metrics are unavailable, never an inferred 0.
  impressions: count.nullish(),
  clicks: count.nullish(),
  spend: amount.nullish(),
  conversions: amount.nullish(),
  cpa: amount.nullish(),
});
const campaignSchema = metricsSchema.extend({
  campaign_id: z.string().min(1).max(256),
  campaign_name: z.string().max(512).nullish(),
  campaign_status: z.string().max(64).nullish(),
});
const pageSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.unknown()).max(PAGE_SIZE),
  has_more: z.boolean(),
  last_id: z.string().min(1).max(8192).nullish(),
});
const accountSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(512),
  currency_code: z.string().regex(/^[A-Z]{3}$/u),
  timezone: z.string().min(1).max(128),
});

export type OpenAiAdsReportMetrics = {
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  attributedConversions: number | null;
  bookingConversions: null;
  phoneInquiryConversions: null;
  costPerConversion: number | null;
};

export type OpenAiAdsReport = {
  ok: true;
  configured: true;
  account: { id: string; name: string; currency: string; timeZone: string };
  timeframe: WebsiteAnalyticsTimeframe;
  fetchedAt: string;
  totals: OpenAiAdsReportMetrics;
  campaigns: Array<
    OpenAiAdsReportMetrics & { id: string; name: string; status: string | null }
  >;
  conversionBreakdownAvailable: false;
  notes: string[];
};

function invalidResponse(): never {
  throw new OpenAiAdsReportingError("openai_ads_reporting_invalid_response");
}

function metrics(
  row: z.infer<typeof metricsSchema> | null,
): OpenAiAdsReportMetrics {
  return {
    spend: row?.spend ?? null,
    impressions: row?.impressions ?? null,
    clicks: row?.clicks ?? null,
    attributedConversions: row?.conversions ?? null,
    bookingConversions: null,
    phoneInquiryConversions: null,
    costPerConversion:
      row?.conversions && row.conversions > 0 ? (row.cpa ?? null) : null,
  };
}

/** Read only complete GET responses, with one deadline for the entire report. */
async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > MAX_RESPONSE_BYTES) invalidResponse();
  const reader = response.body?.getReader();
  if (!reader) invalidResponse();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        invalidResponse();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch {
    invalidResponse();
  }
}

function insightsParameters(
  scope: "campaign" | "ad_account",
  timeframe: WebsiteAnalyticsTimeframe,
): URLSearchParams {
  const parameters = new URLSearchParams({
    aggregation_level: scope,
    time_granularity: "none",
    limit: String(PAGE_SIZE),
  });
  parameters.set(
    "time_ranges[]",
    JSON.stringify({
      type: "date_range",
      since: timeframe.since,
      until: timeframe.through,
      timezone: timeframe.timezone,
    }),
  );
  const fields = [
    `${scope}.id`,
    `${scope}.name`,
    `${scope}.impressions`,
    `${scope}.clicks`,
    `${scope}.spend`,
    "conversions",
    "cpa",
  ];
  if (scope === "campaign") fields.push("campaign.status");
  for (const field of fields) parameters.append("fields[]", field);
  parameters.append("includes[]", "zero_impression_items");
  return parameters;
}

/**
 * The Advertiser key is separate from the conversion delivery key. Only fixed
 * GET endpoints may receive it; provider errors never expose headers or bodies.
 */
export async function getOpenAiAdsReport(
  timeframe: WebsiteAnalyticsTimeframe,
  options: {
    environment?: Environment;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  } = {},
): Promise<OpenAiAdsReport> {
  const environment = options.environment ?? process.env;
  const apiKey = environment["OPENAI_ADS_API_KEY"]?.trim();
  if (!apiKey)
    throw new OpenAiAdsReportingError(
      "openai_ads_reporting_not_configured",
      503,
    );
  try {
    if (isControlledProviderTestRuntime(environment))
      throw new Error("test_runtime");
  } catch {
    throw new OpenAiAdsReportingError(
      "openai_ads_reporting_test_runtime_blocked",
      503,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OPENAI_ADS_REPORTING_TIMEOUT_MS,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request(
    path: "/ad_account" | "/ad_account/insights",
    parameters?: URLSearchParams,
  ): Promise<unknown> {
    const url = new URL(`https://api.ads.openai.com/v1${path}`);
    if (parameters) url.search = parameters.toString();
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "StonegateOS-Reporting/1.0",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new OpenAiAdsReportingError(
        `openai_ads_reporting_http_${response.status}`,
        response.status === 429 || response.status >= 500 ? 503 : 502,
      );
    }
    return readJson(response);
  }

  async function campaignRows(): Promise<
    Array<z.infer<typeof campaignSchema>>
  > {
    const parameters = insightsParameters("campaign", timeframe);
    const result: Array<z.infer<typeof campaignSchema>> = [];
    const cursors = new Set<string>();
    const campaignIds = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_REPORT_PAGES; pageNumber += 1) {
      const parsed = pageSchema.safeParse(
        await request("/ad_account/insights", parameters),
      );
      if (!parsed.success) invalidResponse();
      for (const value of parsed.data.data) {
        const row = campaignSchema.safeParse(value);
        if (!row.success || campaignIds.has(row.data.campaign_id))
          invalidResponse();
        campaignIds.add(row.data.campaign_id);
        result.push(row.data);
      }
      if (!parsed.data.has_more) return result;
      const cursor = parsed.data.last_id;
      if (!cursor || cursors.has(cursor) || parsed.data.data.length === 0)
        invalidResponse();
      cursors.add(cursor);
      parameters.set("after", cursor);
    }
    throw new OpenAiAdsReportingError("openai_ads_reporting_incomplete");
  }

  try {
    const [rawAccount, rawTotals, rows] = await Promise.all([
      request("/ad_account"),
      request(
        "/ad_account/insights",
        insightsParameters("ad_account", timeframe),
      ),
      campaignRows(),
    ]);
    const account = accountSchema.safeParse(rawAccount);
    const totalsPage = pageSchema.safeParse(rawTotals);
    if (
      !account.success ||
      !totalsPage.success ||
      totalsPage.data.has_more ||
      totalsPage.data.data.length > 1
    )
      invalidResponse();
    const totalsRow = totalsPage.data.data[0];
    const totals =
      totalsRow === undefined ? null : metricsSchema.safeParse(totalsRow);
    if (totals && !totals.success) invalidResponse();
    return {
      ok: true,
      configured: true,
      account: {
        id: account.data.id,
        name: account.data.name,
        currency: account.data.currency_code,
        timeZone: account.data.timezone,
      },
      timeframe,
      fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
      totals: metrics(totals?.data ?? null),
      campaigns: rows.map((row) => ({
        id: row.campaign_id,
        name: row.campaign_name || "Unnamed campaign",
        status: row.campaign_status ?? null,
        ...metrics(row),
      })),
      conversionBreakdownAvailable: false,
      notes: [
        "Spend is in the account currency. The current day is a partial reporting period.",
        "Impressions and clicks can appear before finalized spend. Conversions update daily; allow at least one day for attribution.",
        "Attributed conversions combine click-through outcomes configured on each campaign. Reporting starts when event settings are attached; a caller who books can count as two outcomes.",
        "Booking and phone-inquiry counts are not separately available from this report. Missing metrics remain unavailable.",
      ],
    };
  } catch (error) {
    if (error instanceof OpenAiAdsReportingError) throw error;
    throw new OpenAiAdsReportingError(
      controller.signal.aborted
        ? "openai_ads_reporting_timeout"
        : "openai_ads_reporting_unavailable",
      503,
    );
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
