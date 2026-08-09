import { DateTime } from "luxon";

export const WEBSITE_ANALYTICS_TIMEZONE = "America/New_York" as const;
export const WEBSITE_ANALYTICS_RANGE_DAYS = [1, 7, 14, 30] as const;

export type WebsiteAnalyticsRangeDays =
  (typeof WEBSITE_ANALYTICS_RANGE_DAYS)[number];

export type WebsiteAnalyticsTimeframe = {
  timezone: typeof WEBSITE_ANALYTICS_TIMEZONE;
  since: string;
  through: string;
  generatedAt: string;
  comparison: {
    kind: "previous_equal_period";
    since: string;
    through: string;
  };
};

export function parseWebsiteAnalyticsRangeDays(
  raw: string | null | undefined,
): WebsiteAnalyticsRangeDays | null {
  if (raw == null || raw === "") return 7;
  if (!/^\d+$/u.test(raw)) return null;
  const match = WEBSITE_ANALYTICS_RANGE_DAYS.find(
    (range) => String(range) === raw,
  );
  return match ?? null;
}

export function buildWebsiteAnalyticsWindow(
  rangeDays: WebsiteAnalyticsRangeDays,
  inputNow: DateTime = DateTime.now(),
): {
  startAt: Date;
  timeframe: WebsiteAnalyticsTimeframe;
} {
  const now = inputNow.setZone(WEBSITE_ANALYTICS_TIMEZONE);
  if (!now.isValid) {
    throw new Error("invalid_time");
  }

  const start = now.startOf("day").minus({ days: rangeDays - 1 });
  const comparisonThrough = start.minus({ days: 1 });
  const comparisonStart = comparisonThrough.minus({ days: rangeDays - 1 });
  const since = start.toISODate();
  const through = now.toISODate();
  const comparisonSince = comparisonStart.toISODate();
  const comparisonThroughDate = comparisonThrough.toISODate();
  const generatedAt = now.toUTC().toISO();

  if (
    !since ||
    !through ||
    !comparisonSince ||
    !comparisonThroughDate ||
    !generatedAt
  ) {
    throw new Error("invalid_time");
  }

  return {
    startAt: start.toJSDate(),
    timeframe: {
      timezone: WEBSITE_ANALYTICS_TIMEZONE,
      since,
      through,
      generatedAt,
      comparison: {
        kind: "previous_equal_period",
        since: comparisonSince,
        through: comparisonThroughDate,
      },
    },
  };
}
