import { getDb } from "@/db";
import { sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type QuoteConfidence = "high" | "medium" | "low" | "unknown";
type QuoteOutcome = "within" | "above" | "below";
type ServiceFamily = "junk" | "demo" | "brush" | "unknown";
type SourceFamily = "facebook" | "public_site" | "other" | "unknown";

type QuoteAccuracyRow = {
  confidence: QuoteConfidence;
  outcome: QuoteOutcome;
  outsideByCents: number;
  serviceFamily: ServiceFamily;
  sourceFamily: SourceFamily;
};

type AccuracyBucket = {
  quotes: number;
  withinRange: number;
  withinRangeRate: number;
  aboveRange: number;
  aboveRangeRate: number;
  belowRange: number;
  belowRangeRate: number;
  averageOutsideByCents: number;
};

type QuoteAccuracyOutcomeSlice = {
  attempts: number;
  withinRange: number;
  withinRangeRate: number;
  aboveRange: number;
  aboveRangeRate: number;
  belowRange: number;
  belowRangeRate: number;
  averageOutsideByCents: number;
  byConfidence: Record<QuoteConfidence, AccuracyBucket>;
  learned: {
    lowConfidenceNeedsTightening: boolean;
    keepQuoteProvisional: boolean;
    tendsAboveRange: boolean;
    highConfidenceTrustworthy: boolean;
  };
};

export type QuoteAccuracyLearningScope = {
  serviceFamily?: ServiceFamily | null;
  sourceFamily?: SourceFamily | null;
};

export type QuoteAccuracyOutcomeSummary = QuoteAccuracyOutcomeSlice & {
  windowStart: string;
  byServiceFamily: Record<ServiceFamily, QuoteAccuracyOutcomeSlice>;
  bySourceFamily: Record<SourceFamily, QuoteAccuracyOutcomeSlice>;
};

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function normalizeConfidence(value: string | null | undefined): QuoteConfidence {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  return "unknown";
}

function summarize(rows: QuoteAccuracyRow[]): AccuracyBucket {
  const quotes = rows.length;
  const withinRange = rows.filter((row) => row.outcome === "within").length;
  const aboveRange = rows.filter((row) => row.outcome === "above").length;
  const belowRange = rows.filter((row) => row.outcome === "below").length;
  const outsideRows = rows.filter((row) => row.outcome !== "within");
  const totalOutsideByCents = outsideRows.reduce((sum, row) => sum + row.outsideByCents, 0);

  return {
    quotes,
    withinRange,
    withinRangeRate: toRate(withinRange, quotes),
    aboveRange,
    aboveRangeRate: toRate(aboveRange, quotes),
    belowRange,
    belowRangeRate: toRate(belowRange, quotes),
    averageOutsideByCents:
      outsideRows.length > 0 ? Math.round(totalOutsideByCents / outsideRows.length) : 0,
  };
}

function tendsAboveRange(summary: QuoteAccuracyOutcomeSlice): boolean {
  if (summary.attempts < 8) return false;
  return summary.aboveRangeRate >= 0.25 && summary.aboveRangeRate >= summary.belowRangeRate + 0.05;
}

function highConfidenceTrustworthy(summary: QuoteAccuracyOutcomeSlice): boolean {
  const high = summary.byConfidence.high;
  if (high.quotes < 4) return false;
  return high.withinRangeRate >= 0.7 && high.aboveRangeRate <= 0.2;
}

function lowConfidenceNeedsTightening(summary: QuoteAccuracyOutcomeSlice): boolean {
  const low = summary.byConfidence.low;
  const medium = summary.byConfidence.medium;
  const high = summary.byConfidence.high;

  if (low.quotes >= 4) {
    if (low.withinRangeRate <= 0.55) return true;
    if (high.quotes >= 4 && low.withinRangeRate <= high.withinRangeRate - 0.15) return true;
    if (low.aboveRangeRate >= 0.3) return true;
  }

  if (medium.quotes >= 6) {
    if (medium.withinRangeRate <= 0.55) return true;
    if (high.quotes >= 4 && medium.withinRangeRate <= high.withinRangeRate - 0.2) return true;
  }

  return false;
}

function keepQuoteProvisional(summary: QuoteAccuracyOutcomeSlice): boolean {
  if (summary.attempts < 8) return false;
  return summary.withinRangeRate < 0.65 || tendsAboveRange(summary);
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

function buildSlice(rows: QuoteAccuracyRow[]): QuoteAccuracyOutcomeSlice {
  const overall = summarize(rows);
  const slice: QuoteAccuracyOutcomeSlice = {
    attempts: overall.quotes,
    withinRange: overall.withinRange,
    withinRangeRate: overall.withinRangeRate,
    aboveRange: overall.aboveRange,
    aboveRangeRate: overall.aboveRangeRate,
    belowRange: overall.belowRange,
    belowRangeRate: overall.belowRangeRate,
    averageOutsideByCents: overall.averageOutsideByCents,
    byConfidence: {
      high: summarize(rows.filter((row) => row.confidence === "high")),
      medium: summarize(rows.filter((row) => row.confidence === "medium")),
      low: summarize(rows.filter((row) => row.confidence === "low")),
      unknown: summarize(rows.filter((row) => row.confidence === "unknown")),
    },
    learned: {
      lowConfidenceNeedsTightening: false,
      keepQuoteProvisional: false,
      tendsAboveRange: false,
      highConfidenceTrustworthy: false,
    },
  };

  slice.learned.tendsAboveRange = tendsAboveRange(slice);
  slice.learned.highConfidenceTrustworthy = highConfidenceTrustworthy(slice);
  slice.learned.lowConfidenceNeedsTightening = lowConfidenceNeedsTightening(slice);
  slice.learned.keepQuoteProvisional = keepQuoteProvisional(slice);
  return slice;
}

function emptySlice(): QuoteAccuracyOutcomeSlice {
  return buildSlice([]);
}

function resolveScopedSummary(
  summary: QuoteAccuracyOutcomeSummary | null | undefined,
  scope?: QuoteAccuracyLearningScope | null,
): QuoteAccuracyOutcomeSlice {
  if (!summary) return emptySlice();
  if (scope?.serviceFamily && summary.byServiceFamily[scope.serviceFamily].attempts >= 4) {
    return summary.byServiceFamily[scope.serviceFamily];
  }
  if (scope?.sourceFamily && summary.bySourceFamily[scope.sourceFamily].attempts >= 4) {
    return summary.bySourceFamily[scope.sourceFamily];
  }
  return summary;
}

export async function loadQuoteAccuracyOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<QuoteAccuracyOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const rows = (await db.execute(
    sql`
      select
        appt.final_total_cents as "finalTotalCents",
        coalesce((iq.ai_result ->> 'priceLowDiscounted')::int, (iq.ai_result ->> 'priceLow')::int) as "displayLow",
        coalesce((iq.ai_result ->> 'priceHighDiscounted')::int, (iq.ai_result ->> 'priceHigh')::int) as "displayHigh",
        coalesce(iq.ai_result -> 'mediaAnalysis' ->> 'confidence', 'unknown') as "confidence",
        iq.source as "quoteSource",
        lead.source as "leadSource",
        iq.job_types as "jobTypes",
        lead.services_requested as "leadServices"
      from appointments appt
      join leads lead on lead.id = appt.lead_id
      join instant_quotes iq on iq.id = lead.instant_quote_id
      where appt.status = 'completed'
        and appt.final_total_cents is not null
        and coalesce(appt.completed_at, appt.created_at) >= ${windowStartIso}
      order by coalesce(appt.completed_at, appt.created_at) desc
      limit 1000
    `,
  )) as Array<{
    finalTotalCents?: number | null;
    displayLow?: number | null;
    displayHigh?: number | null;
    confidence?: string | null;
    quoteSource?: string | null;
    leadSource?: string | null;
    jobTypes?: string[] | null;
    leadServices?: string[] | null;
  }>;

  const normalizedRows: QuoteAccuracyRow[] = [];
  for (const row of rows) {
    const finalTotalCents = row.finalTotalCents ?? null;
    const displayLowCents =
      typeof row.displayLow === "number" && Number.isFinite(row.displayLow) ? Math.round(row.displayLow * 100) : null;
    const displayHighCents =
      typeof row.displayHigh === "number" && Number.isFinite(row.displayHigh) ? Math.round(row.displayHigh * 100) : null;

    if (
      finalTotalCents == null ||
      displayLowCents == null ||
      displayHighCents == null ||
      displayLowCents <= 0 ||
      displayHighCents <= 0 ||
      displayHighCents < displayLowCents
    ) {
      continue;
    }

    const baseRow = {
      confidence: normalizeConfidence(row.confidence),
      serviceFamily: classifyServiceFamily(
        [
          ...(Array.isArray(row.jobTypes) ? row.jobTypes : []),
          ...(Array.isArray(row.leadServices) ? row.leadServices : []),
        ].filter((item): item is string => typeof item === "string" && item.trim().length > 0),
      ),
      sourceFamily: classifySourceFamily(row.leadSource ?? row.quoteSource ?? null),
    };

    if (finalTotalCents < displayLowCents) {
      normalizedRows.push({
        ...baseRow,
        outcome: "below",
        outsideByCents: displayLowCents - finalTotalCents,
      });
      continue;
    }

    if (finalTotalCents > displayHighCents) {
      normalizedRows.push({
        ...baseRow,
        outcome: "above",
        outsideByCents: finalTotalCents - displayHighCents,
      });
      continue;
    }

    normalizedRows.push({
      ...baseRow,
      outcome: "within",
      outsideByCents: 0,
    });
  }

  const summary: QuoteAccuracyOutcomeSummary = {
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
  return summary;
}

export function shouldTightenLowConfidenceQuoteEstimates(
  summary: QuoteAccuracyOutcomeSummary | null | undefined,
  scope?: QuoteAccuracyLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.lowConfidenceNeedsTightening === true;
}

export function shouldKeepQuoteEstimateProvisional(
  summary: QuoteAccuracyOutcomeSummary | null | undefined,
  scope?: QuoteAccuracyLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.keepQuoteProvisional === true;
}

export function doesQuoteAccuracyTrendAboveRange(
  summary: QuoteAccuracyOutcomeSummary | null | undefined,
  scope?: QuoteAccuracyLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.tendsAboveRange === true;
}
