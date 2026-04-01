import { NextRequest, NextResponse } from "next/server";
import { appointments, getDb, instantQuotes } from "@/db";
import { desc, eq, gte, sql } from "drizzle-orm";
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

  const [summaryRow] = await db
    .select({
      totalQuotes: sql<number>`count(*)::int`,
      mediaInformedQuotes: sql<number>`count(*) filter (where ${mediaInformedExpr})::int`,
      bookedQuotes: sql<number>`count(*) filter (where ${bookedFromQuoteExpr})::int`,
      mediaInformedBookedQuotes: sql<number>`count(*) filter (where ${mediaInformedExpr} and ${bookedFromQuoteExpr})::int`,
      mediaHighConfidenceQuotes: sql<number>`
        count(*) filter (where ${mediaInformedExpr} and ${mediaConfidenceExpr} = 'high')::int
      `,
      mediaHighConfidenceBookedQuotes: sql<number>`
        count(*) filter (where ${mediaInformedExpr} and ${mediaConfidenceExpr} = 'high' and ${bookedFromQuoteExpr})::int
      `,
      mediaLowConfidenceQuotes: sql<number>`
        count(*) filter (where ${mediaInformedExpr} and ${mediaConfidenceExpr} = 'low')::int
      `,
      mediaLowConfidenceBookedQuotes: sql<number>`
        count(*) filter (where ${mediaInformedExpr} and ${mediaConfidenceExpr} = 'low' and ${bookedFromQuoteExpr})::int
      `,
      mediaMissingViewsQuotes: sql<number>`
        count(*) filter (where ${mediaInformedExpr} and ${mediaMissingViewsExpr})::int
      `,
      mediaMissingViewsBookedQuotes: sql<number>`
        count(*) filter (where ${mediaInformedExpr} and ${mediaMissingViewsExpr} and ${bookedFromQuoteExpr})::int
      `,
    })
    .from(instantQuotes)
    .where(gte(instantQuotes.createdAt, summaryWindowStart));

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
    return NextResponse.json({
      quotes: rows,
      summary: buildSummary(summaryRow, summaryWindowStart),
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
  }));

  return NextResponse.json({
    quotes,
    summary: buildSummary(summaryRow, summaryWindowStart),
  });
}

function buildSummary(
  row:
    | {
        totalQuotes: number;
        mediaInformedQuotes: number;
        bookedQuotes: number;
        mediaInformedBookedQuotes: number;
        mediaHighConfidenceQuotes: number;
        mediaHighConfidenceBookedQuotes: number;
        mediaLowConfidenceQuotes: number;
        mediaLowConfidenceBookedQuotes: number;
        mediaMissingViewsQuotes: number;
        mediaMissingViewsBookedQuotes: number;
      }
    | undefined,
  windowStart: Date,
) {
  const totalQuotes = row?.totalQuotes ?? 0;
  const mediaInformedQuotes = row?.mediaInformedQuotes ?? 0;
  const bookedQuotes = row?.bookedQuotes ?? 0;
  const mediaInformedBookedQuotes = row?.mediaInformedBookedQuotes ?? 0;
  const mediaHighConfidenceQuotes = row?.mediaHighConfidenceQuotes ?? 0;
  const mediaHighConfidenceBookedQuotes = row?.mediaHighConfidenceBookedQuotes ?? 0;
  const mediaLowConfidenceQuotes = row?.mediaLowConfidenceQuotes ?? 0;
  const mediaLowConfidenceBookedQuotes = row?.mediaLowConfidenceBookedQuotes ?? 0;
  const mediaMissingViewsQuotes = row?.mediaMissingViewsQuotes ?? 0;
  const mediaMissingViewsBookedQuotes = row?.mediaMissingViewsBookedQuotes ?? 0;
  const standardQuotes = Math.max(0, totalQuotes - mediaInformedQuotes);
  const standardBookedQuotes = Math.max(0, bookedQuotes - mediaInformedBookedQuotes);

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
    },
    standard: {
      quotes: standardQuotes,
      bookedQuotes: standardBookedQuotes,
      bookRate: standardQuotes > 0 ? Number((standardBookedQuotes / standardQuotes).toFixed(4)) : 0,
    },
  };
}
