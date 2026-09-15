import { z } from "zod";

const metric = z.number().finite().nonnegative();
const metrics = {
  // The Advertiser API returns spend in major currency units, not cents.
  spend: metric.nullable(),
  impressions: metric.nullable(),
  clicks: metric.nullable(),
  attributedConversions: metric.nullable(),
  bookingConversions: metric.nullable(),
  phoneInquiryConversions: metric.nullable(),
  costPerConversion: metric.nullable(),
};

const reportSchema = z.object({
  ok: z.literal(true),
  configured: z.literal(true),
  account: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    timeZone: z.string().min(1),
  }),
  timeframe: z.object({
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    timezone: z.string().min(1),
    generatedAt: z.string().datetime({ offset: true }),
  }),
  fetchedAt: z.string().datetime({ offset: true }),
  totals: z.object(metrics),
  campaigns: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      status: z.string().nullable(),
      ...metrics,
    }),
  ),
  conversionBreakdownAvailable: z.boolean(),
});

export type OpenAiAdsCampaignReport = z.infer<typeof reportSchema>;
export type OpenAiAdsCampaignReportState =
  | { kind: "ready"; report: OpenAiAdsCampaignReport }
  | { kind: "not_configured" | "unavailable" | "forbidden" };

/** Incomplete/provider-error responses cannot become convincing zero-filled totals. */
export function parseOpenAiAdsCampaignReport(
  value: unknown,
): OpenAiAdsCampaignReport | null {
  const result = reportSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function formatOpenAiAdsReportCount(value: number | null): string {
  return value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
        value,
      );
}

export function formatOpenAiAdsReportMoney(
  value: number | null,
  currency: string,
): string {
  if (value === null) return "Unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    value,
  );
}

export function formatOpenAiAdsReportDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function formatOpenAiAdsReportTimestamp(
  value: string,
  timeZone: string,
): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone,
    }).format(new Date(value));
  } catch {
    return (
      new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(value)) + " UTC"
    );
  }
}

export function openAiAdsReportActivityState(
  report: OpenAiAdsCampaignReport,
): "active" | "none" | "unavailable" {
  const { spend, impressions, clicks, attributedConversions } = report.totals;
  if (
    (spend ?? 0) > 0 ||
    (impressions ?? 0) > 0 ||
    (clicks ?? 0) > 0 ||
    (attributedConversions ?? 0) > 0
  )
    return "active";
  return spend === 0 && impressions === 0 && clicks === 0
    ? "none"
    : "unavailable";
}
