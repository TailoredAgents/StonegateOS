import { getDb } from "@/db";
import { sql } from "drizzle-orm";
import { getQuoteFollowupLearningScope, type QuoteFollowupLearningScope } from "@/lib/quote-followup-outcomes";

type DbExecutor = ReturnType<typeof getDb>;
type BookingWindow = "under_6h" | "same_day" | "day_1_3" | "after_3d";
type ServiceFamily = "junk" | "demo" | "brush" | "unknown";
type SourceFamily = "facebook" | "public_site" | "other" | "unknown";

type HotWindowRow = {
  booked: boolean;
  bookingWindow: BookingWindow | null;
  serviceFamily: ServiceFamily;
  sourceFamily: SourceFamily;
};

type OutcomeBucket = {
  quotes: number;
  bookedQuotes: number;
  bookRate: number;
};

type QuoteHotWindowSlice = {
  quotes: number;
  bookedQuotes: number;
  bookRate: number;
  byWindow: Record<BookingWindow, OutcomeBucket>;
  learned: {
    hotWindow: "under_6h" | "same_day" | "day_1_3" | "slow_burn" | null;
    urgencyDecayFast: boolean;
    sameDayStillStrong: boolean;
  };
};

export type QuoteHotWindowOutcomeSummary = QuoteHotWindowSlice & {
  windowStart: string;
  byServiceFamily: Record<ServiceFamily, QuoteHotWindowSlice>;
  bySourceFamily: Record<SourceFamily, QuoteHotWindowSlice>;
};

function normalizeDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarizeBucket(rows: HotWindowRow[]): OutcomeBucket {
  const quotes = rows.length;
  const bookedQuotes = rows.filter((row) => row.booked).length;
  return {
    quotes,
    bookedQuotes,
    bookRate: toRate(bookedQuotes, quotes),
  };
}

function classifyServiceFamily(jobTypes: string[]): ServiceFamily {
  const normalized = jobTypes.map((value) => value.toLowerCase());
  if (normalized.some((value) => value.includes("demo"))) return "demo";
  if (normalized.some((value) => value.includes("brush") || value.includes("land"))) return "brush";
  if (normalized.length > 0) return "junk";
  return "unknown";
}

function classifySourceFamily(source: string | null | undefined): SourceFamily {
  const normalized = typeof source === "string" ? source.trim().toLowerCase() : "";
  if (!normalized) return "unknown";
  if (normalized.includes("facebook")) return "facebook";
  if (
    normalized.includes("public_site") ||
    normalized.includes("website") ||
    normalized === "demo_quote" ||
    normalized === "brush_quote" ||
    normalized === "junk_quote"
  ) {
    return "public_site";
  }
  return "other";
}

function emptySlice(): QuoteHotWindowSlice {
  return buildSlice([]);
}

function dominantHotWindow(slice: QuoteHotWindowSlice): QuoteHotWindowSlice["learned"]["hotWindow"] {
  const windows: Array<{ key: BookingWindow; rate: number; quotes: number }> = [
    { key: "under_6h", rate: slice.byWindow.under_6h.bookRate, quotes: slice.byWindow.under_6h.quotes },
    { key: "same_day", rate: slice.byWindow.same_day.bookRate, quotes: slice.byWindow.same_day.quotes },
    { key: "day_1_3", rate: slice.byWindow.day_1_3.bookRate, quotes: slice.byWindow.day_1_3.quotes },
    { key: "after_3d", rate: slice.byWindow.after_3d.bookRate, quotes: slice.byWindow.after_3d.quotes },
  ];
  const viable = windows.filter((window) => window.quotes >= 4);
  if (viable.length === 0) return null;
  viable.sort((a, b) => b.rate - a.rate);
  if (viable[0]?.key === "after_3d") return "slow_burn";
  return viable[0]?.key ?? null;
}

function urgencyDecayFast(slice: QuoteHotWindowSlice): boolean {
  if (slice.quotes < 8) return false;
  return (
    slice.byWindow.under_6h.bookRate >= 0.08 &&
    slice.byWindow.day_1_3.bookRate + 0.05 <= slice.byWindow.same_day.bookRate &&
    slice.byWindow.after_3d.bookRate + 0.05 <= slice.byWindow.day_1_3.bookRate
  );
}

function sameDayStillStrong(slice: QuoteHotWindowSlice): boolean {
  if (slice.byWindow.same_day.quotes < 4) return false;
  return slice.byWindow.same_day.bookRate >= 0.08 || slice.byWindow.under_6h.bookRate >= 0.1;
}

function buildSlice(rows: HotWindowRow[]): QuoteHotWindowSlice {
  const slice: QuoteHotWindowSlice = {
    quotes: rows.length,
    bookedQuotes: rows.filter((row) => row.booked).length,
    bookRate: toRate(rows.filter((row) => row.booked).length, rows.length),
    byWindow: {
      under_6h: summarizeBucket(rows.filter((row) => row.bookingWindow === "under_6h")),
      same_day: summarizeBucket(rows.filter((row) => row.bookingWindow === "same_day")),
      day_1_3: summarizeBucket(rows.filter((row) => row.bookingWindow === "day_1_3")),
      after_3d: summarizeBucket(rows.filter((row) => row.bookingWindow === "after_3d")),
    },
    learned: {
      hotWindow: null,
      urgencyDecayFast: false,
      sameDayStillStrong: false,
    },
  };
  slice.learned.hotWindow = dominantHotWindow(slice);
  slice.learned.urgencyDecayFast = urgencyDecayFast(slice);
  slice.learned.sameDayStillStrong = sameDayStillStrong(slice);
  return slice;
}

function resolveScopedSummary(
  summary: QuoteHotWindowOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): QuoteHotWindowSlice {
  if (!summary) return emptySlice();
  if (scope?.serviceFamily && summary.byServiceFamily[scope.serviceFamily].quotes >= 4) {
    return summary.byServiceFamily[scope.serviceFamily];
  }
  if (scope?.sourceFamily && summary.bySourceFamily[scope.sourceFamily].quotes >= 4) {
    return summary.bySourceFamily[scope.sourceFamily];
  }
  return summary;
}

export async function loadQuoteHotWindowOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<QuoteHotWindowOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const rows = (await db.execute(
    sql`
      select
        iq.id as "quoteId",
        iq.created_at as "quoteCreatedAt",
        iq.source as "quoteSource",
        lead.source as "leadSource",
        iq.job_types as "jobTypes",
        lead.services_requested as "leadServices",
        (
          select min(appt.created_at)
          from leads lead_for_appt
          join appointments appt on appt.lead_id = lead_for_appt.id
          where lead_for_appt.instant_quote_id = iq.id
            and appt.status <> 'canceled'
        ) as "bookedAt"
      from instant_quotes iq
      left join leads lead on lead.instant_quote_id = iq.id
      where iq.created_at >= ${windowStartIso}
      order by iq.created_at desc
      limit 2000
    `,
  )) as Array<{
    quoteId?: string | null;
    quoteCreatedAt?: Date | null;
    quoteSource?: string | null;
    leadSource?: string | null;
    jobTypes?: string[] | null;
    leadServices?: string[] | null;
    bookedAt?: Date | null;
  }>;

  const normalizedRows: HotWindowRow[] = rows
    .map((row) => {
      const quoteCreatedAt = normalizeDate(row.quoteCreatedAt);
      if (!quoteCreatedAt) return null;
      const bookedAt = normalizeDate(row.bookedAt);
      const booked = Boolean(bookedAt);
      const ageHours =
        booked && bookedAt
          ? (bookedAt.getTime() - quoteCreatedAt.getTime()) / 3_600_000
          : null;
      const bookingWindow: BookingWindow | null =
        ageHours == null
          ? null
          : ageHours <= 6
            ? "under_6h"
            : ageHours <= 24
              ? "same_day"
              : ageHours <= 72
                ? "day_1_3"
                : "after_3d";

      return {
        booked,
        bookingWindow,
        serviceFamily: classifyServiceFamily(
          [
            ...(Array.isArray(row.jobTypes) ? row.jobTypes : []),
            ...(Array.isArray(row.leadServices) ? row.leadServices : []),
          ].filter((item): item is string => typeof item === "string" && item.trim().length > 0),
        ),
        sourceFamily: classifySourceFamily(row.leadSource ?? row.quoteSource ?? null),
      };
    })
    .filter((row): row is HotWindowRow => Boolean(row));

  return {
    windowStart: windowStart.toISOString(),
    ...buildSlice(normalizedRows),
    byServiceFamily: {
      junk: buildSlice(normalizedRows.filter((row) => row.serviceFamily === "junk")),
      demo: buildSlice(normalizedRows.filter((row) => row.serviceFamily === "demo")),
      brush: buildSlice(normalizedRows.filter((row) => row.serviceFamily === "brush")),
      unknown: buildSlice(normalizedRows.filter((row) => row.serviceFamily === "unknown")),
    },
    bySourceFamily: {
      facebook: buildSlice(normalizedRows.filter((row) => row.sourceFamily === "facebook")),
      public_site: buildSlice(normalizedRows.filter((row) => row.sourceFamily === "public_site")),
      other: buildSlice(normalizedRows.filter((row) => row.sourceFamily === "other")),
      unknown: buildSlice(normalizedRows.filter((row) => row.sourceFamily === "unknown")),
    },
  };
}

export function getLearnedQuoteHotWindow(
  summary: QuoteHotWindowOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): QuoteHotWindowSlice["learned"]["hotWindow"] {
  return resolveScopedSummary(summary, scope).learned.hotWindow;
}

export function doesQuoteUrgencyDecayFast(
  summary: QuoteHotWindowOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.urgencyDecayFast;
}

export function isSameDayQuoteWindowStillStrong(
  summary: QuoteHotWindowOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.sameDayStillStrong;
}
