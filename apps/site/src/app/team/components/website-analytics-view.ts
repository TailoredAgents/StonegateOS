import { teamSurfaceHref } from "../surface-registry";

export const WEBSITE_ANALYTICS_RANGES = [1, 7, 14, 30] as const;
export type WebsiteAnalyticsRange = (typeof WEBSITE_ANALYTICS_RANGES)[number];
export type WebsiteAnalyticsPanel = "summary" | "funnel" | "errors" | "vitals";

export type AdvertisingContext = {
  reportId: string | null;
  campaignId: string | null;
};

export function isWebsiteAnalyticsRange(
  raw: string | null | undefined,
): raw is `${WebsiteAnalyticsRange}` {
  return WEBSITE_ANALYTICS_RANGES.some((range) => String(range) === raw);
}

export function normalizeWebsiteAnalyticsRange(
  raw: string | null | undefined,
): WebsiteAnalyticsRange {
  return isWebsiteAnalyticsRange(raw)
    ? (Number(raw) as WebsiteAnalyticsRange)
    : 7;
}

function normalizeContextId(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.length > 120) return null;
  return /^[a-z0-9._:-]+$/iu.test(trimmed) ? trimmed : null;
}

export function normalizeAdvertisingContext(input: {
  reportId?: string | null;
  campaignId?: string | null;
}): AdvertisingContext {
  return {
    reportId: normalizeContextId(input.reportId),
    campaignId: normalizeContextId(input.campaignId),
  };
}

export function websiteAnalyticsHref(input: {
  rangeDays: WebsiteAnalyticsRange;
  advertising?: AdvertisingContext;
  retryPanel?: WebsiteAnalyticsPanel;
  retryToken?: string;
  panel?: WebsiteAnalyticsPanel;
}): ReturnType<typeof teamSurfaceHref> {
  return teamSurfaceHref("web-analytics", {
    query: {
      waRangeDays: String(input.rangeDays),
      gaReportId: input.advertising?.reportId,
      gaCampaignId: input.advertising?.campaignId,
      waRetry: input.retryPanel,
      waRetryToken: input.retryToken,
    },
    hash: input.panel,
  });
}

export function advertisingContextHref(
  advertising: AdvertisingContext,
): ReturnType<typeof teamSurfaceHref> {
  return teamSurfaceHref("google-ads", {
    query: {
      gaReportId: advertising.reportId,
      gaCampaignId: advertising.campaignId,
    },
  });
}
