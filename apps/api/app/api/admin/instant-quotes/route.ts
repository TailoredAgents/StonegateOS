import { NextRequest, NextResponse } from "next/server";
import { appointments, getDb, instantQuotes, leads, mediaJobAnalyses } from "@/db";
import { desc, eq, gte, inArray, sql } from "drizzle-orm";
import { isAdminRequest } from "../../web/admin";

function parseLimit(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 25;
  return Math.max(1, Math.floor(parsed));
}

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  const { searchParams } = request.nextUrl;
  const id = searchParams.get("id");
  const limit = Math.min(parseLimit(searchParams.get("limit")), 50);
  const summaryWindowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const mediaInformedExpr = sql<boolean>`
    coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'source', '') like 'vision%'
  `;
  const mediaConfidenceExpr = sql<string>`
    coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'confidence', '')
  `;
  const mediaMissingViewsExpr = sql<boolean>`
    case
      when jsonb_typeof(${instantQuotes.aiResult} -> 'mediaAnalysis' -> 'missingViews') = 'array'
        then jsonb_array_length(${instantQuotes.aiResult} -> 'mediaAnalysis' -> 'missingViews') > 0
      else false
    end
  `;
  const bookedFromQuoteExpr = sql<boolean>`
    exists(
      select 1
      from ${appointments} appt
      where appt.instant_quote_id = ${instantQuotes.id}
        and appt.status <> 'canceled'
    )
  `;
  const summaryCandidates = dedupeQuoteInsights(
    await db
      .select({
        id: instantQuotes.id,
        createdAt: instantQuotes.createdAt,
        isMediaInformed: mediaInformedExpr,
        hasBookedAppointment: bookedFromQuoteExpr,
        originalConfidence: mediaConfidenceExpr,
        originalMissingViewCount: sql<number>`
          case
            when jsonb_typeof(${instantQuotes.aiResult} -> 'mediaAnalysis' -> 'missingViews') = 'array'
              then jsonb_array_length(${instantQuotes.aiResult} -> 'mediaAnalysis' -> 'missingViews')
            else 0
          end
        `,
        currentAnalysisUpdatedAt: mediaJobAnalyses.updatedAt,
        currentAnalysisConfidence: mediaJobAnalyses.confidence,
        currentMissingViewCount: sql<number>`coalesce(array_length(${mediaJobAnalyses.missingViews}, 1), 0)`,
      })
      .from(instantQuotes)
      .leftJoin(leads, eq(leads.instantQuoteId, instantQuotes.id))
      .leftJoin(mediaJobAnalyses, eq(mediaJobAnalyses.contactId, leads.contactId))
      .where(gte(instantQuotes.createdAt, summaryWindowStart)),
  );
  const summary = buildSummary(summaryCandidates, summaryWindowStart);

  if (id) {
    const rows = await db
      .select({
        id: instantQuotes.id,
        createdAt: instantQuotes.createdAt,
        source: instantQuotes.source,
        contactName: instantQuotes.contactName,
        contactPhone: instantQuotes.contactPhone,
        timeframe: instantQuotes.timeframe,
        zip: instantQuotes.zip,
        jobTypes: instantQuotes.jobTypes,
        perceivedSize: instantQuotes.perceivedSize,
        notes: instantQuotes.notes,
        photoUrls: instantQuotes.photoUrls,
        aiResult: instantQuotes.aiResult,
        isMediaInformed: mediaInformedExpr,
        hasBookedAppointment: bookedFromQuoteExpr,
      })
      .from(instantQuotes)
      .where(eq(instantQuotes.id, id))
      .orderBy(desc(instantQuotes.createdAt))
      .limit(1);
    const quoteInsights = await loadQuoteInsightMap(db, rows.map((row) => row.id));
    return NextResponse.json({
      quotes: rows.map((row) => ({
        ...row,
        tightenedAfterMoreMedia: quoteInsights.get(row.id)?.tightenedAfterMoreMedia ?? false,
      })),
      summary,
    });
  }

  const rows = await db
    .select({
      id: instantQuotes.id,
      createdAt: instantQuotes.createdAt,
      source: instantQuotes.source,
      contactName: instantQuotes.contactName,
      contactPhone: instantQuotes.contactPhone,
      timeframe: instantQuotes.timeframe,
      zip: instantQuotes.zip,
      jobTypes: instantQuotes.jobTypes,
      perceivedSize: instantQuotes.perceivedSize,
      photoCount: sql<number>`coalesce(array_length(${instantQuotes.photoUrls}, 1), 0)`,
      loadFractionEstimate: sql<number>`coalesce((${instantQuotes.aiResult} ->> 'loadFractionEstimate')::float8, 0)`,
      priceLow: sql<number>`coalesce((${instantQuotes.aiResult} ->> 'priceLow')::int, 0)`,
      priceHigh: sql<number>`coalesce((${instantQuotes.aiResult} ->> 'priceHigh')::int, 0)`,
      priceLowDiscounted: sql<number | null>`(${instantQuotes.aiResult} ->> 'priceLowDiscounted')::int`,
      priceHighDiscounted: sql<number | null>`(${instantQuotes.aiResult} ->> 'priceHighDiscounted')::int`,
      discountPercent: sql<number | null>`(${instantQuotes.aiResult} ->> 'discountPercent')::float8`,
      displayTierLabel: sql<string>`coalesce(${instantQuotes.aiResult} ->> 'displayTierLabel', '')`,
      reasonSummary: sql<string>`coalesce(${instantQuotes.aiResult} ->> 'reasonSummary', '')`,
      needsInPersonEstimate: sql<boolean>`coalesce((${instantQuotes.aiResult} ->> 'needsInPersonEstimate')::boolean, false)`,
      addOnTotal: sql<number>`coalesce((${instantQuotes.aiResult} ->> 'addOnTotal')::int, 0)`,
      mediaAnalysisSource: sql<string>`coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'source', '')`,
      mediaVisibleVolumeRange: sql<string>`coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'visibleVolumeRange', '')`,
      mediaMergedVolumeRange: sql<string>`coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'mergedVolumeRange', '')`,
      mediaConfidence: sql<string>`coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'confidence', '')`,
      hasBookedAppointment: bookedFromQuoteExpr
    })
    .from(instantQuotes)
    .orderBy(desc(instantQuotes.createdAt))
    .limit(limit);
  const quoteInsights = await loadQuoteInsightMap(
    db,
    rows.map((row) => row.id),
  );

  const quotes = rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    source: row.source,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    timeframe: row.timeframe,
    zip: row.zip,
    jobTypes: row.jobTypes,
    perceivedSize: row.perceivedSize,
    photoCount: row.photoCount,
    aiResult: {
      loadFractionEstimate: row.loadFractionEstimate,
      priceLow: row.priceLow,
      priceHigh: row.priceHigh,
      priceLowDiscounted: row.priceLowDiscounted ?? undefined,
      priceHighDiscounted: row.priceHighDiscounted ?? undefined,
      discountPercent: row.discountPercent ?? undefined,
      addOnTotal: row.addOnTotal || undefined,
      displayTierLabel: row.displayTierLabel,
      reasonSummary: row.reasonSummary,
      needsInPersonEstimate: row.needsInPersonEstimate,
      mediaAnalysis:
        row.mediaAnalysisSource.trim().length > 0
          ? {
              source: row.mediaAnalysisSource,
              visibleVolumeRange: row.mediaVisibleVolumeRange || undefined,
              mergedVolumeRange: row.mediaMergedVolumeRange || undefined,
              confidence:
                row.mediaConfidence === "low" || row.mediaConfidence === "medium" || row.mediaConfidence === "high"
                  ? row.mediaConfidence
                  : undefined,
            }
          : undefined,
    },
    isMediaInformed: row.mediaAnalysisSource.startsWith("vision"),
    hasBookedAppointment: row.hasBookedAppointment,
    tightenedAfterMoreMedia: quoteInsights.get(row.id)?.tightenedAfterMoreMedia ?? false,
  }));

  return NextResponse.json({
    quotes,
    summary,
  });
}

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

type QuoteInsight = {
  id: string;
  createdAt: Date;
  isMediaInformed: boolean;
  hasBookedAppointment: boolean;
  originalConfidence: "low" | "medium" | "high" | null;
  originalMissingViewCount: number;
  tightenedAfterMoreMedia: boolean;
};

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
  if (
    !isWeakOriginalMedia({
      isMediaInformed: row.isMediaInformed,
      originalConfidence,
      originalMissingViewCount: row.originalMissingViewCount,
    })
  ) {
    return false;
  }
  if (!(row.currentAnalysisUpdatedAt instanceof Date) || row.currentAnalysisUpdatedAt.getTime() <= row.createdAt.getTime()) {
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

async function loadQuoteInsightMap(
  db: ReturnType<typeof getDb>,
  quoteIds: string[],
): Promise<Map<string, QuoteInsight>> {
  const ids = [...new Set(quoteIds.filter((id) => typeof id === "string" && id.trim().length > 0))];
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: instantQuotes.id,
      createdAt: instantQuotes.createdAt,
      isMediaInformed: mediaInformedExprForHelper(),
      hasBookedAppointment: bookedFromQuoteExprForHelper(),
      originalConfidence: mediaConfidenceExprForHelper(),
      originalMissingViewCount: originalMissingViewCountExprForHelper(),
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

function mediaInformedExprForHelper() {
  return sql<boolean>`coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'source', '') like 'vision%'`;
}

function mediaConfidenceExprForHelper() {
  return sql<string>`coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'confidence', '')`;
}

function originalMissingViewCountExprForHelper() {
  return sql<number>`
    case
      when jsonb_typeof(${instantQuotes.aiResult} -> 'mediaAnalysis' -> 'missingViews') = 'array'
        then jsonb_array_length(${instantQuotes.aiResult} -> 'mediaAnalysis' -> 'missingViews')
      else 0
    end
  `;
}

function bookedFromQuoteExprForHelper() {
  return sql<boolean>`
    exists(
      select 1
      from ${appointments} appt
      where appt.instant_quote_id = ${instantQuotes.id}
        and appt.status <> 'canceled'
    )
  `;
}

function buildSummary(rows: QuoteInsight[], windowStart: Date) {
  const totalQuotes = rows.length;
  const mediaInformedQuotes = rows.filter((row) => row.isMediaInformed).length;
  const bookedQuotes = rows.filter((row) => row.hasBookedAppointment).length;
  const mediaInformedBookedQuotes = rows.filter((row) => row.isMediaInformed && row.hasBookedAppointment).length;
  const mediaHighConfidenceQuotes = rows.filter((row) => row.isMediaInformed && row.originalConfidence === "high").length;
  const mediaHighConfidenceBookedQuotes = rows.filter(
    (row) => row.isMediaInformed && row.originalConfidence === "high" && row.hasBookedAppointment,
  ).length;
  const mediaLowConfidenceQuotes = rows.filter((row) => row.isMediaInformed && row.originalConfidence === "low").length;
  const mediaLowConfidenceBookedQuotes = rows.filter(
    (row) => row.isMediaInformed && row.originalConfidence === "low" && row.hasBookedAppointment,
  ).length;
  const mediaMissingViewsQuotes = rows.filter(
    (row) => row.isMediaInformed && row.originalMissingViewCount > 0,
  ).length;
  const mediaMissingViewsBookedQuotes = rows.filter(
    (row) => row.isMediaInformed && row.originalMissingViewCount > 0 && row.hasBookedAppointment,
  ).length;
  const standardQuotes = Math.max(0, totalQuotes - mediaInformedQuotes);
  const standardBookedQuotes = Math.max(0, bookedQuotes - mediaInformedBookedQuotes);
  const weakMediaQuotes = rows.filter((row) =>
    isWeakOriginalMedia({
      isMediaInformed: row.isMediaInformed,
      originalConfidence: row.originalConfidence,
      originalMissingViewCount: row.originalMissingViewCount,
    }),
  );
  const tightenedWeakMediaQuotes = weakMediaQuotes.filter((row) => row.tightenedAfterMoreMedia);
  const unresolvedWeakMediaQuotes = weakMediaQuotes.filter((row) => !row.tightenedAfterMoreMedia);

  return {
    windowStart: windowStart.toISOString(),
    totalQuotes,
    bookedQuotes,
    mediaInformed: {
      quotes: mediaInformedQuotes,
      bookedQuotes: mediaInformedBookedQuotes,
      bookRate:
        mediaInformedQuotes > 0 ? Number((mediaInformedBookedQuotes / mediaInformedQuotes).toFixed(4)) : 0,
      highConfidence: {
        quotes: mediaHighConfidenceQuotes,
        bookedQuotes: mediaHighConfidenceBookedQuotes,
        bookRate:
          mediaHighConfidenceQuotes > 0
            ? Number((mediaHighConfidenceBookedQuotes / mediaHighConfidenceQuotes).toFixed(4))
            : 0,
      },
      lowConfidence: {
        quotes: mediaLowConfidenceQuotes,
        bookedQuotes: mediaLowConfidenceBookedQuotes,
        bookRate:
          mediaLowConfidenceQuotes > 0 ? Number((mediaLowConfidenceBookedQuotes / mediaLowConfidenceQuotes).toFixed(4)) : 0,
      },
      missingViews: {
        quotes: mediaMissingViewsQuotes,
        bookedQuotes: mediaMissingViewsBookedQuotes,
        bookRate:
          mediaMissingViewsQuotes > 0
            ? Number((mediaMissingViewsBookedQuotes / mediaMissingViewsQuotes).toFixed(4))
            : 0,
      },
      weakQuotes: {
        quotes: weakMediaQuotes.length,
        bookedQuotes: weakMediaQuotes.filter((row) => row.hasBookedAppointment).length,
        bookRate:
          weakMediaQuotes.length > 0
            ? Number(
                (
                  weakMediaQuotes.filter((row) => row.hasBookedAppointment).length / weakMediaQuotes.length
                ).toFixed(4),
              )
            : 0,
      },
      tightenedAfterMoreMedia: {
        quotes: tightenedWeakMediaQuotes.length,
        bookedQuotes: tightenedWeakMediaQuotes.filter((row) => row.hasBookedAppointment).length,
        bookRate:
          tightenedWeakMediaQuotes.length > 0
            ? Number(
                (
                  tightenedWeakMediaQuotes.filter((row) => row.hasBookedAppointment).length /
                  tightenedWeakMediaQuotes.length
                ).toFixed(4),
              )
            : 0,
      },
      unresolvedWeakMedia: {
        quotes: unresolvedWeakMediaQuotes.length,
        bookedQuotes: unresolvedWeakMediaQuotes.filter((row) => row.hasBookedAppointment).length,
        bookRate:
          unresolvedWeakMediaQuotes.length > 0
            ? Number(
                (
                  unresolvedWeakMediaQuotes.filter((row) => row.hasBookedAppointment).length /
                  unresolvedWeakMediaQuotes.length
                ).toFixed(4),
              )
            : 0,
      },
    },
    standard: {
      quotes: standardQuotes,
      bookedQuotes: standardBookedQuotes,
      bookRate: standardQuotes > 0 ? Number((standardBookedQuotes / standardQuotes).toFixed(4)) : 0,
    },
  };
}
