import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, instantQuotes, leads } from "@/db";
import { isAdminRequest } from "../../../../web/admin";
import { and, desc, eq, isNotNull } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { contactId } = await context.params;
  const contactIdTrimmed = typeof contactId === "string" ? contactId.trim() : "";
  if (!contactIdTrimmed || !isUuid(contactIdTrimmed)) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const db = getDb();

  const rows = await db
    .select({
      id: instantQuotes.id,
      createdAt: instantQuotes.createdAt,
      photoUrls: instantQuotes.photoUrls,
      jobTypes: instantQuotes.jobTypes,
      perceivedSize: instantQuotes.perceivedSize
    })
    .from(leads)
    .innerJoin(instantQuotes, eq(leads.instantQuoteId, instantQuotes.id))
    .where(and(eq(leads.contactId, contactIdTrimmed), isNotNull(leads.instantQuoteId)))
    .orderBy(desc(instantQuotes.createdAt))
    .limit(10);

  const quotes = rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    photoUrls: Array.isArray(row.photoUrls) ? row.photoUrls.filter(Boolean) : [],
    jobTypes: Array.isArray(row.jobTypes) ? row.jobTypes.filter(Boolean) : [],
    perceivedSize: row.perceivedSize
  }));

  const flattenedUrls = Array.from(
    new Set(
      quotes
        .flatMap((quote) => quote.photoUrls)
        .map((url) => url.trim())
        .filter((url) => url.length > 0)
    )
  );

  return NextResponse.json({
    ok: true,
    quotes,
    photoUrls: flattenedUrls
  });
}

