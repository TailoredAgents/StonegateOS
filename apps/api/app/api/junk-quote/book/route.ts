import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, instantQuotes, leads, properties } from "@/db";
import { eq } from "drizzle-orm";
import { upsertContact, upsertProperty } from "../../web/persistence";
import { normalizeName, normalizePhone } from "../../web/utils";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ?? process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

function resolveOrigin(requestOrigin: string | null): string {
  if (RAW_ALLOWED_ORIGINS === "*") return "*";
  const allowed = RAW_ALLOWED_ORIGINS.split(",").map((o) => o.trim().replace(/\/+$/u, "")).filter(Boolean);
  if (!allowed.length) return "*";
  const origin = requestOrigin?.trim().replace(/\/+$/u, "") ?? null;
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0] ?? "*";
}

function applyCors(response: NextResponse, requestOrigin: string | null): NextResponse {
  const origin = resolveOrigin(requestOrigin);
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "*");
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
      const contact = await upsertContact(tx, {
        firstName,
        lastName,
        phoneRaw: normalizedPhone.raw,
        phoneE164: normalizedPhone.e164,
        source: "instant_quote"
      });

      const [existingLead] = await tx
        .select({ id: leads.id, propertyId: leads.propertyId, formPayload: leads.formPayload })
        .from(leads)
        .where(eq(leads.instantQuoteId, quote.id))
        .limit(1);

      const addressLine1 = body.addressLine1.trim();
      const city = body.city.trim();
      const state = body.state.trim().toUpperCase();
      const postalCode = body.postalCode.trim();
      const notes = body.notes ?? quote.notes ?? null;

      if (existingLead?.id) {
        const propertyId = existingLead.propertyId;
        let nextPropertyId = propertyId;

        const [currentProperty] = await tx
          .select({ id: properties.id, addressLine1: properties.addressLine1 })
          .from(properties)
          .where(eq(properties.id, propertyId))
          .limit(1);

        const isPlaceholder =
          typeof currentProperty?.addressLine1 === "string" &&
          currentProperty.addressLine1.trim().startsWith("[Instant Quote");

        if (isPlaceholder) {
          try {
            const [updatedProperty] = await tx
              .update(properties)
              .set({
                contactId: contact.id,
                addressLine1,
                city,
                state,
                postalCode,
                gated: false,
                updatedAt: new Date()
              })
              .where(eq(properties.id, propertyId))
              .returning({ id: properties.id });

            if (!updatedProperty?.id) {
              throw new Error("property_update_failed");
            }
          } catch (error) {
            console.warn("[junk-quote-book] placeholder_property_conflict", {
              quoteId: quote.id,
              propertyId,
              error: String(error)
            });
            const upserted = await upsertProperty(tx, {
              contactId: contact.id,
              addressLine1,
              city,
              state,
              postalCode,
              gated: false
            });
            nextPropertyId = upserted.id;

            if (propertyId !== nextPropertyId) {
              const refs = await tx.select({ id: leads.id }).from(leads).where(eq(leads.propertyId, propertyId)).limit(2);
              if (refs.length <= 1) {
                await tx.delete(properties).where(eq(properties.id, propertyId));
              }
            }
          }
        } else {
          const upserted = await upsertProperty(tx, {
            contactId: contact.id,
            addressLine1,
            city,
            state,
            postalCode,
            gated: false
          });
          nextPropertyId = upserted.id;
        }

        const previousPayload =
          existingLead.formPayload && typeof existingLead.formPayload === "object"
            ? (existingLead.formPayload as Record<string, unknown>)
            : {};

        const nextPayload = {
          ...previousPayload,
          booking: {
            addressLine1,
            city,
            state,
            postalCode,
            preferredDate,
            timeWindow,
            notes
          }
        };

        const [updatedLead] = await tx
          .update(leads)
          .set({
            contactId: contact.id,
            propertyId: nextPropertyId,
            notes,
            formPayload: nextPayload,
            updatedAt: new Date()
          })
          .where(eq(leads.id, existingLead.id))
          .returning({ id: leads.id });

        return { lead: { id: updatedLead?.id ?? existingLead.id } };
      }

      const property = await upsertProperty(tx, {
        contactId: contact.id,
        addressLine1,
        city,
        state,
        postalCode,
        gated: false
      });

      const [lead] = await tx
        .insert(leads)
        .values({
          contactId: contact.id,
          propertyId: property.id,
          servicesRequested: quote.jobTypes ?? [],
          notes,
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
            timeWindow,
            notes,
            addressLine1,
            city,
            state,
            postalCode
          }
        })
        .returning({ id: leads.id });

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
