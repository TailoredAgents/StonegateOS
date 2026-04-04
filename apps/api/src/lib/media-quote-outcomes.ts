import { appointments, getDb, instantQuotes, leads, mediaJobAnalyses } from "@/db";
import { eq, gte, inArray, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;

export type MediaQuoteOutcomeSummary = {
  windowStart: string;
  totalQuotes: number;
  bookedQuotes: number;
  mediaInformed: {
    quotes: number;
    bookedQuotes: number;
    bookRate: number;
    highConfidence: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
    lowConfidence: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
    missingViews: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
    weakQuotes: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
    tightenedAfterMoreMedia: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
    unresolvedWeakMedia: {
      quotes: number;
      bookedQuotes: number;
      bookRate: number;
    };
  };
  standard: {
    quotes: number;
    bookedQuotes: number;
    bookRate: number;
  };
};

export type QuoteInsight = {
  id: string;
  createdAt: Date;
  isMediaInformed: boolean;
  hasBookedAppointment: boolean;
  originalConfidence: "low" | "medium" | "high" | null;
  originalMissingViewCount: number;
  tightenedAfterMoreMedia: boolean;
};

type QuoteInsightRow = {
  id: string;
  createdAt: Date;
  isMediaInformed: boolean;
  hasBookedAppointment: boolean;
  originalConfidence: string;
  originalMissingViewCount: number;
  currentAnalysisUpdatedAt: Date | null;
  currentAnalysisConfidence: string | null;
  currentMissingViewCount: number;
};

function normalizeDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mediaInformedExpr() {
  return sql<boolean>`coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'source', '') like 'vision%'`;
}

function mediaConfidenceExpr() {
  return sql<string>`coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'confidence', '')`;
}

function originalMissingViewCountExpr() {
  return sql<number>`
    case
      when jsonb_typeof(${instantQuotes.aiResult} -> 'mediaAnalysis' -> 'missingViews') = 'array'
        then jsonb_array_length(${instantQuotes.aiResult} -> 'mediaAnalysis' -> 'missingViews')
      else 0
    end
  `;
}

function bookedFromQuoteExpr() {
  return sql<boolean>`
    exists(
      select 1
      from ${leads} lead
      join ${appointments} appt on appt.lead_id = lead.id
      where lead.instant_quote_id = ${instantQuotes.id}
        and appt.status <> 'canceled'
    )
  `;
}

function normalizeConfidence(value: string | null | undefined): "low" | "medium" | "high" | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "low" || normalized === "medium" || normalized === "high" ? normalized : null;
}

function isWeakOriginalMedia(input: {
  isMediaInformed: boolean;
  originalConfidence: "low" | "medium" | "high" | null;
  originalMissingViewCount: number;
}): boolean {
  return input.isMediaInformed && (input.originalConfidence === "low" || input.originalMissingViewCount > 0);
}

function computeTightenedAfterMoreMedia(row: QuoteInsightRow): boolean {
  const originalConfidence = normalizeConfidence(row.originalConfidence);
  const currentConfidence = normalizeConfidence(row.currentAnalysisConfidence);
  const createdAt = normalizeDate(row.createdAt);
  const currentAnalysisUpdatedAt = normalizeDate(row.currentAnalysisUpdatedAt);
  if (
    !isWeakOriginalMedia({
      isMediaInformed: row.isMediaInformed,
      originalConfidence,
      originalMissingViewCount: row.originalMissingViewCount,
    })
  ) {
    return false;
  }
  if (!createdAt || !currentAnalysisUpdatedAt || currentAnalysisUpdatedAt.getTime() <= createdAt.getTime()) {
    return false;
  }
  if (row.currentMissingViewCount > 0) return false;
  return currentConfidence === "medium" || currentConfidence === "high";
}

function dedupeQuoteInsights(rows: QuoteInsightRow[]): QuoteInsight[] {
  const byId = new Map<string, QuoteInsight>();
  for (const row of rows) {
    const next: QuoteInsight = {
      id: row.id,
      createdAt: row.createdAt,
      isMediaInformed: row.isMediaInformed,
      hasBookedAppointment: row.hasBookedAppointment,
      originalConfidence: normalizeConfidence(row.originalConfidence),
      originalMissingViewCount: row.originalMissingViewCount,
      tightenedAfterMoreMedia: computeTightenedAfterMoreMedia(row),
    };
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, next);
      continue;
    }
    byId.set(row.id, {
      ...existing,
      hasBookedAppointment: existing.hasBookedAppointment || next.hasBookedAppointment,
      tightenedAfterMoreMedia: existing.tightenedAfterMoreMedia || next.tightenedAfterMoreMedia,
    });
  }
  return [...byId.values()];
}

function toRate(booked: number, total: number): number {
  return total > 0 ? Number((booked / total).toFixed(4)) : 0;
}

function buildSummary(rows: QuoteInsight[], windowStart: Date): MediaQuoteOutcomeSummary {
  const totalQuotes = rows.length;
  const mediaInformedRows = rows.filter((row) => row.isMediaInformed);
  const mediaInformedQuotes = mediaInformedRows.length;
  const bookedQuotes = rows.filter((row) => row.hasBookedAppointment).length;
  const mediaInformedBookedQuotes = mediaInformedRows.filter((row) => row.hasBookedAppointment).length;
  const mediaHighConfidenceRows = mediaInformedRows.filter((row) => row.originalConfidence === "high");
  const mediaLowConfidenceRows = mediaInformedRows.filter((row) => row.originalConfidence === "low");
  const mediaMissingViewsRows = mediaInformedRows.filter((row) => row.originalMissingViewCount > 0);
  const standardQuotes = Math.max(0, totalQuotes - mediaInformedQuotes);
  const standardBookedQuotes = Math.max(0, bookedQuotes - mediaInformedBookedQuotes);
  const weakMediaRows = mediaInformedRows.filter((row) =>
    isWeakOriginalMedia({
      isMediaInformed: row.isMediaInformed,
      originalConfidence: row.originalConfidence,
      originalMissingViewCount: row.originalMissingViewCount,
    }),
  );
  const tightenedWeakMediaRows = weakMediaRows.filter((row) => row.tightenedAfterMoreMedia);
  const unresolvedWeakMediaRows = weakMediaRows.filter((row) => !row.tightenedAfterMoreMedia);

  return {
    windowStart: windowStart.toISOString(),
    totalQuotes,
    bookedQuotes,
    mediaInformed: {
      quotes: mediaInformedQuotes,
      bookedQuotes: mediaInformedBookedQuotes,
      bookRate: toRate(mediaInformedBookedQuotes, mediaInformedQuotes),
      highConfidence: {
        quotes: mediaHighConfidenceRows.length,
        bookedQuotes: mediaHighConfidenceRows.filter((row) => row.hasBookedAppointment).length,
        bookRate: toRate(
          mediaHighConfidenceRows.filter((row) => row.hasBookedAppointment).length,
          mediaHighConfidenceRows.length,
        ),
      },
      lowConfidence: {
        quotes: mediaLowConfidenceRows.length,
        bookedQuotes: mediaLowConfidenceRows.filter((row) => row.hasBookedAppointment).length,
        bookRate: toRate(
          mediaLowConfidenceRows.filter((row) => row.hasBookedAppointment).length,
          mediaLowConfidenceRows.length,
        ),
      },
      missingViews: {
        quotes: mediaMissingViewsRows.length,
        bookedQuotes: mediaMissingViewsRows.filter((row) => row.hasBookedAppointment).length,
        bookRate: toRate(
          mediaMissingViewsRows.filter((row) => row.hasBookedAppointment).length,
          mediaMissingViewsRows.length,
        ),
      },
      weakQuotes: {
        quotes: weakMediaRows.length,
        bookedQuotes: weakMediaRows.filter((row) => row.hasBookedAppointment).length,
        bookRate: toRate(
          weakMediaRows.filter((row) => row.hasBookedAppointment).length,
          weakMediaRows.length,
        ),
      },
      tightenedAfterMoreMedia: {
        quotes: tightenedWeakMediaRows.length,
        bookedQuotes: tightenedWeakMediaRows.filter((row) => row.hasBookedAppointment).length,
        bookRate: toRate(
          tightenedWeakMediaRows.filter((row) => row.hasBookedAppointment).length,
          tightenedWeakMediaRows.length,
        ),
      },
      unresolvedWeakMedia: {
        quotes: unresolvedWeakMediaRows.length,
        bookedQuotes: unresolvedWeakMediaRows.filter((row) => row.hasBookedAppointment).length,
        bookRate: toRate(
          unresolvedWeakMediaRows.filter((row) => row.hasBookedAppointment).length,
          unresolvedWeakMediaRows.length,
        ),
      },
    },
    standard: {
      quotes: standardQuotes,
      bookedQuotes: standardBookedQuotes,
      bookRate: toRate(standardBookedQuotes, standardQuotes),
    },
  };
}

export async function loadQuoteInsightMap(
  db: DbExecutor,
  quoteIds: string[],
): Promise<Map<string, QuoteInsight>> {
  const ids = [...new Set(quoteIds.filter((id) => typeof id === "string" && id.trim().length > 0))];
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: instantQuotes.id,
      createdAt: instantQuotes.createdAt,
      isMediaInformed: mediaInformedExpr(),
      hasBookedAppointment: bookedFromQuoteExpr(),
      originalConfidence: mediaConfidenceExpr(),
      originalMissingViewCount: originalMissingViewCountExpr(),
      currentAnalysisUpdatedAt: mediaJobAnalyses.updatedAt,
      currentAnalysisConfidence: mediaJobAnalyses.confidence,
      currentMissingViewCount: sql<number>`coalesce(array_length(${mediaJobAnalyses.missingViews}, 1), 0)`,
    })
    .from(instantQuotes)
    .leftJoin(leads, eq(leads.instantQuoteId, instantQuotes.id))
    .leftJoin(mediaJobAnalyses, eq(mediaJobAnalyses.contactId, leads.contactId))
    .where(inArray(instantQuotes.id, ids));
  return new Map(dedupeQuoteInsights(rows).map((row) => [row.id, row]));
}

export async function loadMediaQuoteOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<MediaQuoteOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: instantQuotes.id,
      createdAt: instantQuotes.createdAt,
      isMediaInformed: mediaInformedExpr(),
      hasBookedAppointment: bookedFromQuoteExpr(),
      originalConfidence: mediaConfidenceExpr(),
      originalMissingViewCount: originalMissingViewCountExpr(),
      currentAnalysisUpdatedAt: mediaJobAnalyses.updatedAt,
      currentAnalysisConfidence: mediaJobAnalyses.confidence,
      currentMissingViewCount: sql<number>`coalesce(array_length(${mediaJobAnalyses.missingViews}, 1), 0)`,
    })
    .from(instantQuotes)
    .leftJoin(leads, eq(leads.instantQuoteId, instantQuotes.id))
    .leftJoin(mediaJobAnalyses, eq(mediaJobAnalyses.contactId, leads.contactId))
    .where(gte(instantQuotes.createdAt, windowStart));
  return buildSummary(dedupeQuoteInsights(rows), windowStart);
}

export function shouldPreferTighteningWeakMedia(summary: MediaQuoteOutcomeSummary): boolean {
  const tightened = summary.mediaInformed.tightenedAfterMoreMedia;
  const unresolved = summary.mediaInformed.unresolvedWeakMedia;
  if (tightened.quotes < 3) return false;
  if (tightened.bookRate <= unresolved.bookRate) return false;
  return tightened.bookRate - unresolved.bookRate >= 0.05;
}
