import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, contacts, properties, leads, instantQuotes } from "@/db";
import { eq } from "drizzle-orm";
import { normalizeName, normalizePhone } from "../../web/utils";

const BookingSchema = z.object({
  instantQuoteId: z.string().uuid(),
  name: z.string().min(2),
  phone: z.string().min(7),
  addressLine1: z.string().min(5),
  city: z.string().min(2),
  state: z.string().min(2).max(2),
  postalCode: z.string().min(3),
  preferredDate: z.string().optional().nullable(),
  timeWindow: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

export async function POST(request: NextRequest) {
  try {
    const parsed = BookingSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", details: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;
    const db = getDb();

    const [quote] = await db.select().from(instantQuotes).where(eq(instantQuotes.id, body.instantQuoteId)).limit(1);
    if (!quote) {
      return NextResponse.json({ error: "quote_not_found" }, { status: 404 });
    }

    let normalizedPhone: { raw: string; e164: string };
    try {
      const norm = normalizePhone(body.phone);
      normalizedPhone = { raw: norm.raw, e164: norm.e164 };
    } catch {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }

    const { firstName, lastName } = normalizeName(body.name);
    const preferredDate = body.preferredDate ?? null;
    const timeWindow = body.timeWindow ?? null;

    const leadResult = await db.transaction(async (tx) => {
      const [contact] = await tx
        .insert(contacts)
        .values({
          firstName,
          lastName,
          phone: normalizedPhone.raw,
          phoneE164: normalizedPhone.e164,
          source: "instant_quote",
          createdAt: new Date(),
          updatedAt: new Date()
        })
        .returning();

      const [property] = await tx
        .insert(properties)
        .values({
          contactId: contact.id,
          addressLine1: body.addressLine1.trim(),
          city: body.city.trim(),
          state: body.state.trim().toUpperCase(),
          postalCode: body.postalCode.trim(),
          gated: false
        })
        .returning();

      const [lead] = await tx
        .insert(leads)
        .values({
          contactId: contact.id,
          propertyId: property.id,
          servicesRequested: quote.jobTypes ?? [],
          notes: body.notes ?? quote.notes ?? null,
          status: "new",
          source: "instant_quote",
          instantQuoteId: quote.id,
          formPayload: {
            instantQuoteId: quote.id,
            perceivedSize: quote.perceivedSize,
            jobTypes: quote.jobTypes,
            photoUrls: quote.photoUrls,
            aiResult: quote.aiResult,
            preferredDate,
            timeWindow
          }
        })
        .returning();

      return { lead };
    });

    return NextResponse.json({ ok: true, leadId: leadResult.lead.id });
  } catch (error) {
    console.error("[junk-quote-book] server_error", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
