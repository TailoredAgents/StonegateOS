import { NextRequest, NextResponse } from "next/server";
import { getDb, instantQuotes } from "@/db";
import { desc, eq, sql } from "drizzle-orm";
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

  if (id) {
    const rows = await db
      .select()
      .from(instantQuotes)
      .where(eq(instantQuotes.id, id))
      .orderBy(desc(instantQuotes.createdAt))
      .limit(1);
    return NextResponse.json({ quotes: rows });
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
      needsInPersonEstimate: sql<boolean>`coalesce((${instantQuotes.aiResult} ->> 'needsInPersonEstimate')::boolean, false)`
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
      displayTierLabel: row.displayTierLabel,
      reasonSummary: row.reasonSummary,
      needsInPersonEstimate: row.needsInPersonEstimate
    }
  }));

  return NextResponse.json({ quotes });
}
