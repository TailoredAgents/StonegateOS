import { NextRequest, NextResponse } from "next/server";
import { DateTime } from "luxon";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getDb, appointments, instantQuotes, leads, outboxEvents, properties } from "@/db";
import { and, eq, gte, isNotNull, lte, ne, sql } from "drizzle-orm";
import { upsertContact, upsertProperty } from "../../web/persistence";
import { APPOINTMENT_TIME_ZONE, DEFAULT_TRAVEL_BUFFER_MIN } from "../../web/scheduling";
import { normalizeName, normalizePhone } from "../../web/utils";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ?? process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

const WINDOW_DAYS = 14;
const START_HOUR = 8;
const END_HOUR = 18;
const SLOT_INTERVAL_MIN = 60;
const DEFAULT_CAPACITY = 2;

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

class BookingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function overlapsCount(blocks: Array<{ start: Date; end: Date }>, start: Date, end: Date): number {
  let count = 0;
  for (const block of blocks) {
    if (overlaps(start, end, block.start, block.end)) count += 1;
  }
  return count;
}

function deriveDurationMinutes(quote: { aiResult: unknown; perceivedSize: string }): number {
  const ai = isRecord(quote.aiResult) ? quote.aiResult : null;
  const priceHigh = typeof ai?.["priceHigh"] === "number" ? ai["priceHigh"] : null;
  const maxUnits =
    typeof priceHigh === "number" && Number.isFinite(priceHigh) && priceHigh > 0 ? Math.round(priceHigh / 200) : null;

  const fallbackUnits = (() => {
    switch (quote.perceivedSize) {
      case "few_items":
      case "small_area":
        return 2;
      case "one_room_or_half_garage":
        return 3;
      case "big_cleanout":
        return 6;
      default:
        return 3;
    }
  })();

  const units = maxUnits ?? fallbackUnits;
  if (units <= 2) return 120;
  if (units <= 4) return 180;
  const loads = Math.max(2, Math.ceil(units / 4));
  return loads * 240;
}

const BookingSchema = z.object({
  instantQuoteId: z.string().uuid(),
  name: z.string().min(2),
  phone: z.string().min(7),
  addressLine1: z.string().min(5),
  city: z.string().min(2),
  state: z.string().min(2).max(2),
  postalCode: z.string().min(3),
  startAt: z.string().datetime(),
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

    const travelBufferMinutes = DEFAULT_TRAVEL_BUFFER_MIN;
    const durationMinutes = deriveDurationMinutes({ aiResult: quote.aiResult, perceivedSize: quote.perceivedSize });

    const startAt = new Date(body.startAt);
    if (Number.isNaN(startAt.getTime())) {
      return corsJson({ error: "invalid_startAt" }, requestOrigin, { status: 400 });
    }

    const nowLocal = DateTime.now().setZone(APPOINTMENT_TIME_ZONE);
    const startLocal = DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(APPOINTMENT_TIME_ZONE);
    if (!startLocal.isValid) {
      return corsJson({ error: "invalid_startAt" }, requestOrigin, { status: 400 });
    }
    if (startLocal < nowLocal) {
      return corsJson({ error: "start_in_past" }, requestOrigin, { status: 400 });
    }
    if (startLocal > nowLocal.plus({ days: WINDOW_DAYS }).endOf("day")) {
      return corsJson({ error: "outside_booking_window" }, requestOrigin, { status: 400 });
    }
    if (startLocal.weekday === 7) {
      return corsJson({ error: "unavailable_day" }, requestOrigin, { status: 400 });
    }
    if (startLocal.minute % SLOT_INTERVAL_MIN !== 0) {
      return corsJson({ error: "invalid_start_time" }, requestOrigin, { status: 400 });
    }
    const minutesOfDay = startLocal.hour * 60 + startLocal.minute;
    if (minutesOfDay < START_HOUR * 60 || minutesOfDay + durationMinutes > END_HOUR * 60) {
      return corsJson({ error: "outside_business_hours" }, requestOrigin, { status: 400 });
    }

    let normalizedPhone: { raw: string; e164: string };
    try {
      const norm = normalizePhone(body.phone);
      normalizedPhone = { raw: norm.raw, e164: norm.e164 };
    } catch {
      return corsJson({ error: "invalid_phone" }, requestOrigin, { status: 400 });
    }

    const { firstName, lastName } = normalizeName(body.name);

    const leadResult = await db.transaction(async (tx) => {
      const bookingDayKey = startLocal.toFormat("yyyyLLdd");
      const bookingLockKey = Number(bookingDayKey);
      if (Number.isFinite(bookingLockKey) && bookingLockKey > 0) {
        await tx.execute(sql`select pg_advisory_xact_lock(${bookingLockKey})`);
      }

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

      let leadId: string;
      let propertyId: string;

      if (existingLead?.id) {
        propertyId = existingLead.propertyId;
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
              const refs = await tx
                .select({ id: leads.id })
                .from(leads)
                .where(eq(leads.propertyId, propertyId))
                .limit(2);
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
            startAt: startAt.toISOString(),
            durationMinutes,
            travelBufferMinutes,
            timezone: APPOINTMENT_TIME_ZONE,
            notes
          }
        } satisfies Record<string, unknown>;

        const [updatedLead] = await tx
          .update(leads)
          .set({
            contactId: contact.id,
            propertyId: nextPropertyId,
            notes,
            status: "scheduled",
            formPayload: nextPayload,
            updatedAt: new Date()
          })
          .where(eq(leads.id, existingLead.id))
          .returning({ id: leads.id });

        leadId = updatedLead?.id ?? existingLead.id;
        propertyId = nextPropertyId;
      } else {
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
            status: "scheduled",
            source: "instant_quote",
            instantQuoteId: quote.id,
            formPayload: {
              instantQuoteId: quote.id,
              perceivedSize: quote.perceivedSize,
              jobTypes: quote.jobTypes,
              photoUrls: quote.photoUrls,
              aiResult: quote.aiResult,
              booking: {
                startAt: startAt.toISOString(),
                durationMinutes,
                travelBufferMinutes,
                timezone: APPOINTMENT_TIME_ZONE
              },
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

        leadId = lead.id;
        propertyId = property.id;
      }

      const [existingAppt] = await tx
        .select({ id: appointments.id, startAt: appointments.startAt })
        .from(appointments)
        .where(and(eq(appointments.leadId, leadId), ne(appointments.status, "canceled")))
        .limit(1);

      const slotEnd = new Date(startAt.getTime() + durationMinutes * 60_000);
      const lookbackStart = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
      const lookaheadEnd = new Date(slotEnd.getTime() + 24 * 60 * 60 * 1000);

      const nearbyAppts = await tx
        .select({
          id: appointments.id,
          startAt: appointments.startAt,
          durationMinutes: appointments.durationMinutes,
          travelBufferMinutes: appointments.travelBufferMinutes,
          status: appointments.status
        })
        .from(appointments)
        .where(
          and(
            isNotNull(appointments.startAt),
            gte(appointments.startAt, lookbackStart),
            lte(appointments.startAt, lookaheadEnd),
            ne(appointments.status, "canceled")
          )
        );

      const blocks = nearbyAppts
        .filter((row) => row.startAt && row.id !== existingAppt?.id)
        .map((row) => {
          const start = row.startAt as Date;
          const dur = (row.durationMinutes ?? durationMinutes) + (row.travelBufferMinutes ?? travelBufferMinutes);
          return { start, end: new Date(start.getTime() + dur * 60_000) };
        });

      if (overlapsCount(blocks, startAt, slotEnd) >= DEFAULT_CAPACITY) {
        throw new BookingError("slot_full", 409);
      }

      let appointmentId: string;
      let outboxType: "estimate.requested" | "estimate.rescheduled" | null = null;

      if (existingAppt?.id) {
        const existingIso =
          existingAppt.startAt instanceof Date ? existingAppt.startAt.toISOString() : null;
        const nextIso = startAt.toISOString();
        const startChanged = existingIso !== nextIso;

        const [updated] = await tx
          .update(appointments)
          .set({
            contactId: contact.id,
            propertyId,
            startAt,
            durationMinutes,
            travelBufferMinutes,
            status: "confirmed",
            updatedAt: new Date()
          })
          .where(eq(appointments.id, existingAppt.id))
          .returning({ id: appointments.id });

        appointmentId = updated?.id ?? existingAppt.id;
        outboxType = startChanged ? "estimate.rescheduled" : null;
      } else {
        const [created] = await tx
          .insert(appointments)
          .values({
            contactId: contact.id,
            propertyId,
            leadId,
            type: "estimate",
            startAt,
            durationMinutes,
            travelBufferMinutes,
            status: "confirmed",
            rescheduleToken: nanoid(24)
          })
          .returning({ id: appointments.id });

        if (!created?.id) {
          throw new Error("appointment_create_failed");
        }
        appointmentId = created.id;
        outboxType = "estimate.requested";
      }

      if (outboxType) {
        await tx.insert(outboxEvents).values({
          type: outboxType,
          payload: {
            appointmentId,
            leadId,
            services: quote.jobTypes ?? [],
            notes
          }
        });
      }

      return { leadId, appointmentId, startAt: startAt.toISOString() };
    });

    return corsJson(
      { ok: true, leadId: leadResult.leadId, appointmentId: leadResult.appointmentId, startAt: leadResult.startAt },
      requestOrigin
    );
  } catch (error) {
    if (error instanceof BookingError) {
      return corsJson({ error: error.code }, request.headers.get("origin"), { status: error.status });
    }
    const errorId = nanoid(10);
    console.error("[junk-quote-book] server_error", { errorId, error });
    return corsJson({ error: "server_error", errorId }, request.headers.get("origin"), { status: 500 });
  }
}
