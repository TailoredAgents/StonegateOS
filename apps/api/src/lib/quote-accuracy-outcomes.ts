import { getDb } from "@/db";
import { sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type QuoteConfidence = "high" | "medium" | "low" | "unknown";
type QuoteOutcome = "within" | "above" | "below";

type QuoteAccuracyRow = {
  confidence: QuoteConfidence;
  outcome: QuoteOutcome;
  outsideByCents: number;
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

export type QuoteAccuracyOutcomeSummary = {
  windowStart: string;
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

function tendsAboveRange(summary: QuoteAccuracyOutcomeSummary): boolean {
  if (summary.attempts < 8) return false;
  return summary.aboveRangeRate >= 0.25 && summary.aboveRangeRate >= summary.belowRangeRate + 0.05;
}

function highConfidenceTrustworthy(summary: QuoteAccuracyOutcomeSummary): boolean {
  const high = summary.byConfidence.high;
  if (high.quotes < 4) return false;
  return high.withinRangeRate >= 0.7 && high.aboveRangeRate <= 0.2;
}

function lowConfidenceNeedsTightening(summary: QuoteAccuracyOutcomeSummary): boolean {
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

function keepQuoteProvisional(summary: QuoteAccuracyOutcomeSummary): boolean {
  if (summary.attempts < 8) return false;
  return summary.withinRangeRate < 0.65 || tendsAboveRange(summary);
}

export async function loadQuoteAccuracyOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<QuoteAccuracyOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const rows = (await db.execute(
    sql`
      select
        appt.final_total_cents as "finalTotalCents",
        coalesce((iq.ai_result ->> 'priceLowDiscounted')::int, (iq.ai_result ->> 'priceLow')::int) as "displayLow",
        coalesce((iq.ai_result ->> 'priceHighDiscounted')::int, (iq.ai_result ->> 'priceHigh')::int) as "displayHigh",
        coalesce(iq.ai_result -> 'mediaAnalysis' ->> 'confidence', 'unknown') as "confidence"
      from appointments appt
      join instant_quotes iq on iq.id = appt.instant_quote_id
      where appt.status = 'completed'
        and appt.final_total_cents is not null
        and coalesce(appt.completed_at, appt.created_at) >= ${windowStart}
      order by coalesce(appt.completed_at, appt.created_at) desc
      limit 1000
    `,
  )) as Array<{
    finalTotalCents?: number | null;
    displayLow?: number | null;
    displayHigh?: number | null;
    confidence?: string | null;
  }>;

  const normalizedRows: QuoteAccuracyRow[] = rows
    .map((row) => {
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
        return null;
      }

      if (finalTotalCents < displayLowCents) {
        return {
          confidence: normalizeConfidence(row.confidence),
          outcome: "below" as const,
          outsideByCents: displayLowCents - finalTotalCents,
        };
      }

      if (finalTotalCents > displayHighCents) {
        return {
          confidence: normalizeConfidence(row.confidence),
          outcome: "above" as const,
          outsideByCents: finalTotalCents - displayHighCents,
        };
      }

      return {
        confidence: normalizeConfidence(row.confidence),
        outcome: "within" as const,
        outsideByCents: 0,
      };
    })
    .filter((row): row is QuoteAccuracyRow => row !== null);

  const overall = summarize(normalizedRows);
  const byConfidence = {
    high: summarize(normalizedRows.filter((row) => row.confidence === "high")),
    medium: summarize(normalizedRows.filter((row) => row.confidence === "medium")),
    low: summarize(normalizedRows.filter((row) => row.confidence === "low")),
    unknown: summarize(normalizedRows.filter((row) => row.confidence === "unknown")),
  };

  const summary: QuoteAccuracyOutcomeSummary = {
    windowStart: windowStart.toISOString(),
    attempts: overall.quotes,
    withinRange: overall.withinRange,
    withinRangeRate: overall.withinRangeRate,
    aboveRange: overall.aboveRange,
    aboveRangeRate: overall.aboveRangeRate,
    belowRange: overall.belowRange,
    belowRangeRate: overall.belowRangeRate,
    averageOutsideByCents: overall.averageOutsideByCents,
    byConfidence,
    learned: {
      lowConfidenceNeedsTightening: false,
      keepQuoteProvisional: false,
      tendsAboveRange: false,
      highConfidenceTrustworthy: false,
    },
  };

  summary.learned.tendsAboveRange = tendsAboveRange(summary);
  summary.learned.highConfidenceTrustworthy = highConfidenceTrustworthy(summary);
  summary.learned.lowConfidenceNeedsTightening = lowConfidenceNeedsTightening(summary);
  summary.learned.keepQuoteProvisional = keepQuoteProvisional(summary);
  return summary;
}

export function shouldTightenLowConfidenceQuoteEstimates(
  summary: QuoteAccuracyOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.lowConfidenceNeedsTightening === true;
}

export function shouldKeepQuoteEstimateProvisional(
  summary: QuoteAccuracyOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.keepQuoteProvisional === true;
}

export function doesQuoteAccuracyTrendAboveRange(
  summary: QuoteAccuracyOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.tendsAboveRange === true;
}
