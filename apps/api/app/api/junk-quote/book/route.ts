import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, contacts, properties, leads, instantQuotes } from "@/db";
import { eq } from "drizzle-orm";
import { normalizeName, normalizePhone } from "../../web/utils";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ?? process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

function resolveOrigin(requestOrigin: string | null): string {
  if (RAW_ALLOWED_ORIGINS === "*") return "*";
  const allowed = RAW_ALLOWED_ORIGINS.split(",").map((o) => o.trim().replace(/\/+$/u, "")).filter(Boolean);
  if (!allowed.length) return "*";
  const origin = requestOrigin?.trim().replace(/\/+$/u, "") ?? null;
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0];
}

function applyCors(response: NextResponse, requestOrigin: string | null): NextResponse {
  const origin = resolveOrigin(requestOrigin);
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function corsJson(body: unknown, requestOrigin: string | null, init?: ResponseInit): NextResponse {
  return applyCors(NextResponse.json(body, init), requestOrigin);
}

export function OPTIONS(request: NextRequest): NextResponse {
  return applyCors(new NextResponse(null, { status: 204 }), request.headers.get("origin"));
}

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
    const requestOrigin = request.headers.get("origin");
    const parsed = BookingSchema.safeParse(await request.json());
    if (!parsed.success) {
      return corsJson({ error: "invalid_payload", details: parsed.error.flatten() }, requestOrigin, { status: 400 });
    }
    const body = parsed.data;
    const db = getDb();

    const [quote] = await db.select().from(instantQuotes).where(eq(instantQuotes.id, body.instantQuoteId)).limit(1);
    if (!quote) {
      return corsJson({ error: "quote_not_found" }, requestOrigin, { status: 404 });
    }

    let normalizedPhone: { raw: string; e164: string };
    try {
      const norm = normalizePhone(body.phone);
      normalizedPhone = { raw: norm.raw, e164: norm.e164 };
    } catch {
      return corsJson({ error: "invalid_phone" }, requestOrigin, { status: 400 });
    }

    const { firstName, lastName } = normalizeName(body.name);
    const preferredDate = body.preferredDate ?? null;
    const timeWindow = body.timeWindow ?? null;

    const leadResult = await db.transaction(async (tx) => {
      const insertedContacts = await tx
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
      const contact = insertedContacts[0];
      if (!contact) {
        throw new Error("contact_insert_failed");
      }

      const insertedProperties = await tx
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
      const property = insertedProperties[0];
      if (!property) {
        throw new Error("property_insert_failed");
      }

      const insertedLeads = await tx
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

      const lead = insertedLeads[0];
      if (!lead) {
        throw new Error("lead_insert_failed");
      }

      return { lead };
    });

    return corsJson({ ok: true, leadId: leadResult.lead.id }, requestOrigin);
  } catch (error) {
    console.error("[junk-quote-book] server_error", error);
    return corsJson({ error: "server_error" }, request.headers.get("origin"), { status: 500 });
  }
}
