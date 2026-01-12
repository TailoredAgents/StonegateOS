import { NextRequest, NextResponse } from "next/server";
import { DateTime } from "luxon";
import { nanoid } from "nanoid";
import { z } from "zod";
import { appointmentHolds, getDb, appointments, instantQuotes, leads, outboxEvents, properties } from "@/db";
import { and, eq, gt, gte, isNotNull, lte, ne, sql } from "drizzle-orm";
import { upsertContact, upsertProperty } from "../../web/persistence";
import {
  getBusinessHourWindowsForDate,
  getBusinessHoursPolicy,
  getBookingRulesPolicy,
  getItemPoliciesPolicy,
  getOutOfAreaMessage,
  getServiceAreaPolicy,
  getStandardJobPolicy,
  isPostalCodeAllowed,
  normalizePostalCode
} from "@/lib/policy";
import { buildStandardJobMessage, evaluateStandardJob } from "@/lib/standard-job";
import { APPOINTMENT_TIME_ZONE, DEFAULT_TRAVEL_BUFFER_MIN } from "../../web/scheduling";
import { normalizeName, normalizePhone } from "../../web/utils";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ?? process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

const WINDOW_DAYS = 14;
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

function firstRowId(result: unknown): string | null {
  if (Array.isArray(result)) {
    const id = (result[0] as any)?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  if (isRecord(result) && Array.isArray((result as any).rows)) {
    const id = (result as any).rows[0]?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}

function extractPgMeta(error: unknown): { code?: string; constraint?: string } {
  const direct = isRecord(error) ? error : null;
  const directCode = direct && typeof direct["code"] === "string" ? direct["code"] : undefined;
  const directConstraint =
    direct && typeof direct["constraint_name"] === "string" ? direct["constraint_name"] : undefined;
  if (directCode || directConstraint) return { code: directCode, constraint: directConstraint };

  const cause = direct && isRecord(direct["cause"]) ? (direct["cause"] as Record<string, unknown>) : null;
  const causeCode = cause && typeof cause["code"] === "string" ? cause["code"] : undefined;
  const causeConstraint = cause && typeof cause["constraint_name"] === "string" ? cause["constraint_name"] : undefined;
  return { code: causeCode, constraint: causeConstraint };
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
  holdId: z.string().uuid().optional().nullable(),
  name: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email().optional().nullable(),
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
    const holdId = typeof body.holdId === "string" && body.holdId.length ? body.holdId : null;
    const normalizedPostalCode = normalizePostalCode(body.postalCode);
    const serviceArea = await getServiceAreaPolicy();
    if (normalizedPostalCode && !isPostalCodeAllowed(normalizedPostalCode, serviceArea)) {
      return corsJson(
        {
          error: await getOutOfAreaMessage("web")
        },
        requestOrigin,
        { status: 400 }
      );
    }
    const db = getDb();
    const bookingRules = await getBookingRulesPolicy(db);
    const businessHours = await getBusinessHoursPolicy(db);
    const schedulingZone = businessHours.timezone || APPOINTMENT_TIME_ZONE;

    const [quote] = await db.select().from(instantQuotes).where(eq(instantQuotes.id, body.instantQuoteId)).limit(1);
    if (!quote) {
      return corsJson({ error: "quote_not_found" }, requestOrigin, { status: 404 });
    }

    const standardPolicy = await getStandardJobPolicy(db);
    const itemPolicy = await getItemPoliciesPolicy(db);
    const evaluation = evaluateStandardJob(
      {
        jobTypes: quote.jobTypes ?? [],
        perceivedSize: quote.perceivedSize,
        notes: body.notes ?? quote.notes ?? null,
        aiResult: quote.aiResult
      },
      standardPolicy,
      itemPolicy
    );

    const standardJobReview = evaluation.isStandard
      ? null
      : {
          required: true,
          message: buildStandardJobMessage(evaluation),
          evaluation
        };

    const travelBufferMinutes =
      typeof bookingRules.bufferMinutes === "number" && Number.isFinite(bookingRules.bufferMinutes)
        ? bookingRules.bufferMinutes
        : DEFAULT_TRAVEL_BUFFER_MIN;
    const durationMinutes = deriveDurationMinutes({ aiResult: quote.aiResult, perceivedSize: quote.perceivedSize });

    const startAt = new Date(body.startAt);
    if (Number.isNaN(startAt.getTime())) {
      return corsJson({ error: "invalid_startAt" }, requestOrigin, { status: 400 });
    }

    const nowLocal = DateTime.now().setZone(schedulingZone);
    const startLocal = DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(schedulingZone);
    if (!startLocal.isValid) {
      return corsJson({ error: "invalid_startAt" }, requestOrigin, { status: 400 });
    }
    if (startLocal < nowLocal) {
      return corsJson({ error: "start_in_past" }, requestOrigin, { status: 400 });
    }
    const bookingWindowDays =
      typeof bookingRules.bookingWindowDays === "number" && bookingRules.bookingWindowDays > 0
        ? Math.min(Math.floor(bookingRules.bookingWindowDays), 90)
        : WINDOW_DAYS;
    if (startLocal > nowLocal.plus({ days: bookingWindowDays }).endOf("day")) {
      return corsJson({ error: "outside_booking_window" }, requestOrigin, { status: 400 });
    }
    const windows = getBusinessHourWindowsForDate(startLocal, businessHours);
    if (!windows.length) {
      return corsJson({ error: "unavailable_day" }, requestOrigin, { status: 400 });
    }
    const endLocal = startLocal.plus({ minutes: durationMinutes });
    const window = windows.find((entry) => startLocal >= entry.start && endLocal <= entry.end);
    if (!window) {
      return corsJson({ error: "outside_business_hours" }, requestOrigin, { status: 400 });
    }
    const slotOffset = Math.round(startLocal.diff(window.start, "minutes").minutes);
    if (!Number.isFinite(slotOffset) || slotOffset % SLOT_INTERVAL_MIN !== 0) {
      return corsJson({ error: "invalid_start_time" }, requestOrigin, { status: 400 });
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

      const now = new Date();
      if (holdId) {
        const [hold] = await tx
          .select({
            id: appointmentHolds.id,
            startAt: appointmentHolds.startAt,
            expiresAt: appointmentHolds.expiresAt,
            status: appointmentHolds.status,
            instantQuoteId: appointmentHolds.instantQuoteId
          })
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, holdId))
          .limit(1);

        if (!hold) {
          throw new BookingError("hold_not_found", 404);
        }
        if (hold.status !== "active" || hold.expiresAt <= now) {
          throw new BookingError("hold_expired", 409);
        }
        if (hold.instantQuoteId && hold.instantQuoteId !== quote.id) {
          throw new BookingError("hold_mismatch", 409);
        }
        if (hold.startAt.getTime() !== startAt.getTime()) {
          throw new BookingError("hold_mismatch", 409);
        }
      }

      if (bookingRules.maxJobsPerDay > 0) {
        const dayStartUtc = startLocal.startOf("day").toUTC().toJSDate();
        const dayEndUtc = startLocal.endOf("day").toUTC().toJSDate();
        const [dayCount] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(appointments)
          .where(
            and(
              isNotNull(appointments.startAt),
              gte(appointments.startAt, dayStartUtc),
              lte(appointments.startAt, dayEndUtc),
              ne(appointments.status, "canceled")
            )
          );
        const holdConditions = [
          gte(appointmentHolds.startAt, dayStartUtc),
          lte(appointmentHolds.startAt, dayEndUtc),
          eq(appointmentHolds.status, "active"),
          gt(appointmentHolds.expiresAt, now)
        ];
        if (holdId) {
          holdConditions.push(ne(appointmentHolds.id, holdId));
        }
        const [holdCount] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(appointmentHolds)
          .where(and(...holdConditions));

        const totalCount = Number(dayCount?.count ?? 0) + Number(holdCount?.count ?? 0);
        if (totalCount >= bookingRules.maxJobsPerDay) {
          throw new BookingError("day_full", 409);
        }
      }

      const contact = await upsertContact(tx, {
        firstName,
        lastName,
        phoneRaw: normalizedPhone.raw,
        phoneE164: normalizedPhone.e164,
        email: body.email ?? null,
        source: "instant_quote"
      });

      const safeUpsertPropertyId = async (input: {
        contactId: string;
        addressLine1: string;
        city: string;
        state: string;
        postalCode: string;
        gated: boolean;
      }): Promise<{ id: string }> => {
        const trimmedAddress = input.addressLine1.trim();
        const trimmedCity = input.city.trim();
        const normalizedState = input.state.trim().toUpperCase();
        const trimmedPostalCode = input.postalCode.trim();
        const gated = Boolean(input.gated);

        const [existingByAddress] = await tx
          .select({ id: properties.id })
          .from(properties)
          .where(
            and(
              eq(properties.addressLine1, trimmedAddress),
              eq(properties.postalCode, trimmedPostalCode),
              eq(properties.state, normalizedState)
            )
          )
          .limit(1);

        if (existingByAddress?.id) {
          await tx
            .update(properties)
            .set({
              contactId: input.contactId,
              city: trimmedCity,
              gated,
              updatedAt: new Date()
            })
            .where(eq(properties.id, existingByAddress.id));

          return { id: existingByAddress.id };
        }

        await tx.execute(sql`savepoint junk_quote_book_property_upsert`);
        try {
          const property = await upsertProperty(tx, {
            contactId: input.contactId,
            addressLine1: trimmedAddress,
            city: trimmedCity,
            state: normalizedState,
            postalCode: trimmedPostalCode,
            gated
          });
          await tx.execute(sql`release savepoint junk_quote_book_property_upsert`);
          return { id: property.id };
        } catch (error) {
          const meta = extractPgMeta(error);
          await tx.execute(sql`rollback to savepoint junk_quote_book_property_upsert`);
          await tx.execute(sql`release savepoint junk_quote_book_property_upsert`);

          if (meta.code !== "23505" || (meta.constraint && meta.constraint !== "properties_address_key")) {
            throw error;
          }

          const [existing] = await tx
            .select({ id: properties.id })
            .from(properties)
            .where(
              and(
                eq(properties.addressLine1, trimmedAddress),
                eq(properties.postalCode, trimmedPostalCode),
                eq(properties.state, normalizedState)
              )
            )
            .limit(1);

          if (!existing?.id) throw error;

          await tx
            .update(properties)
            .set({
              contactId: input.contactId,
              city: trimmedCity,
              gated,
              updatedAt: new Date()
            })
            .where(eq(properties.id, existing.id));

          return { id: existing.id };
        }
      };

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
          // If the placeholder property is updated to a real address that already exists, Postgres will raise a
          // constraint error and the whole transaction becomes "aborted" unless we roll back to a savepoint.
          await tx.execute(sql`savepoint junk_quote_book_property_update`);
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
            await tx.execute(sql`release savepoint junk_quote_book_property_update`);
          } catch (error) {
            await tx.execute(sql`rollback to savepoint junk_quote_book_property_update`);
            await tx.execute(sql`release savepoint junk_quote_book_property_update`);
            const meta = extractPgMeta(error);
            console.warn("[junk-quote-book] placeholder_property_conflict", {
              quoteId: quote.id,
              propertyId,
              code: meta.code,
              constraint: meta.constraint,
              error: String(error)
            });
            const upserted = await safeUpsertPropertyId({
              contactId: contact.id,
              addressLine1,
              city,
              state,
              postalCode,
              gated: false
            });
            nextPropertyId = upserted.id;
          }
        } else {
          const upserted = await safeUpsertPropertyId({
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
            timezone: schedulingZone,
            notes
          },
          standardJobReview
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
        const property = await safeUpsertPropertyId({
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
              standardJobReview,
              booking: {
                startAt: startAt.toISOString(),
                durationMinutes,
                travelBufferMinutes,
                timezone: schedulingZone
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

        await tx.insert(outboxEvents).values({
          type: "lead.alert",
          payload: {
            leadId: lead.id,
            source: "instant_quote"
          }
        });

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

      const holdOverlapConditions = [
        gte(appointmentHolds.startAt, lookbackStart),
        lte(appointmentHolds.startAt, lookaheadEnd),
        eq(appointmentHolds.status, "active"),
        gt(appointmentHolds.expiresAt, now)
      ];
      if (holdId) {
        holdOverlapConditions.push(ne(appointmentHolds.id, holdId));
      }
      const nearbyHolds = await tx
        .select({
          id: appointmentHolds.id,
          startAt: appointmentHolds.startAt,
          durationMinutes: appointmentHolds.durationMinutes,
          travelBufferMinutes: appointmentHolds.travelBufferMinutes
        })
        .from(appointmentHolds)
        .where(and(...holdOverlapConditions));

      const blocks = nearbyAppts
        .filter((row) => row.startAt && row.id !== existingAppt?.id)
        .map((row) => {
          const start = row.startAt as Date;
          const dur = (row.durationMinutes ?? durationMinutes) + (row.travelBufferMinutes ?? travelBufferMinutes);
          return { start, end: new Date(start.getTime() + dur * 60_000) };
        });

      const holdBlocks = nearbyHolds
        .filter((row) => row.startAt)
        .map((row) => {
          const start = row.startAt as Date;
          const dur = (row.durationMinutes ?? durationMinutes) + (row.travelBufferMinutes ?? travelBufferMinutes);
          return { start, end: new Date(start.getTime() + dur * 60_000) };
        });

      blocks.push(...holdBlocks);

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
        const rescheduleToken = nanoid(24);
        const rawResult = await tx.execute(sql`
          insert into "appointments" (
            "contact_id",
            "property_id",
            "lead_id",
            "type",
            "start_at",
            "duration_min",
            "status",
            "reschedule_token",
            "travel_buffer_min"
          )
          values (
            ${contact.id},
            ${propertyId},
            ${leadId},
            ${"estimate"},
            ${startAt.toISOString()},
            ${durationMinutes},
            ${"confirmed"},
            ${rescheduleToken},
            ${travelBufferMinutes}
          )
          returning "id"
        `);

        const insertedId = firstRowId(rawResult);
        if (!insertedId) {
          throw new Error("appointment_create_failed");
        }

        appointmentId = insertedId;
        outboxType = "estimate.requested";
      }

      if (outboxType) {
        const customerName = `${firstName} ${lastName}`.trim();
        await tx.insert(outboxEvents).values({
          type: outboxType,
          payload: {
            appointmentId,
            leadId,
            services: quote.jobTypes ?? [],
            notes,
            customerPhone: normalizedPhone.e164,
            customerEmail: body.email ?? null,
            customerName
          }
        });
      }

      if (holdId) {
        await tx
          .update(appointmentHolds)
          .set({
            status: "consumed",
            consumedAt: new Date(),
            contactId: contact.id,
            leadId,
            propertyId,
            updatedAt: new Date()
          })
          .where(eq(appointmentHolds.id, holdId));
      }

      return { leadId, appointmentId, startAt: startAt.toISOString() };
    });

    return corsJson(
      {
        ok: true,
        leadId: leadResult.leadId,
        appointmentId: leadResult.appointmentId,
        startAt: leadResult.startAt,
        standardJobReview
      },
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
