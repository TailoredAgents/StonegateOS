import { NextRequest, NextResponse } from "next/server";
import { getDb, instantQuotes } from "@/db";
import { desc, eq, sql } from "drizzle-orm";
import { loadMediaQuoteOutcomeSummary, loadQuoteInsightMap } from "@/lib/media-quote-outcomes";
import { loadObjectionSaveOutcomeSummary } from "@/lib/objection-save-outcomes";
import { loadQuoteFollowupOutcomeSummary } from "@/lib/quote-followup-outcomes";
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
  const summary = await loadMediaQuoteOutcomeSummary(db);
  const objectionSummary = await loadObjectionSaveOutcomeSummary(db);
  const followupSummary = await loadQuoteFollowupOutcomeSummary(db);
  const bookedFromQuoteExpr = sql<boolean>`
    exists(
      select 1
      from appointments appt
      where appt.instant_quote_id = ${instantQuotes.id}
        and appt.status <> 'canceled'
    )
  `;

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
        isMediaInformed: sql<boolean>`
          coalesce(${instantQuotes.aiResult} -> 'mediaAnalysis' ->> 'source', '') like 'vision%'
        `,
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
      objectionSummary,
      followupSummary,
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
      hasBookedAppointment: bookedFromQuoteExpr,
    })
    .from(instantQuotes)
    .orderBy(desc(instantQuotes.createdAt))
    .limit(limit);
  const quoteInsights = await loadQuoteInsightMap(db, rows.map((row) => row.id));

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
    objectionSummary,
    followupSummary,
  });
}
