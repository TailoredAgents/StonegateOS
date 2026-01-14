import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { z } from "zod";
import { and, eq, gt, gte, isNotNull, lte, ne, sql } from "drizzle-orm";
import { appointmentHolds, appointments, getDb, instantQuotes, leads } from "@/db";
import {
  getBusinessHourWindowsForDate,
  getBusinessHoursPolicy,
  getBookingRulesPolicy,
  getItemPoliciesPolicy,
  getStandardJobPolicy,
  normalizePostalCode
} from "@/lib/policy";
import { buildStandardJobMessage, evaluateStandardJob } from "@/lib/standard-job";
import { APPOINTMENT_TIME_ZONE, DEFAULT_TRAVEL_BUFFER_MIN } from "../../web/scheduling";

const RAW_ALLOWED_ORIGINS =
  process.env["CORS_ALLOW_ORIGINS"] ?? process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "*";

const WINDOW_DAYS = 14;
const SLOT_INTERVAL_MIN = 60;
const DEFAULT_CAPACITY = 2;
const HOLD_WINDOW_MINUTES = 15;

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

const HoldSchema = z.object({
  instantQuoteId: z.string().uuid(),
  startAt: z.string().datetime(),
  addressLine1: z.string().min(5),
  city: z.string().min(2),
  state: z.string().min(2).max(2),
  postalCode: z.string().min(3)
});

class HoldError extends Error {
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

export async function POST(request: NextRequest): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  try {
    const parsed = HoldSchema.safeParse(await request.json());
    if (!parsed.success) {
      return corsJson({ ok: false, error: "invalid_payload", details: parsed.error.flatten() }, requestOrigin, {
        status: 400
      });
    }

    const body = parsed.data;
    const normalizedState = body.state.trim().toUpperCase();
    if (normalizedState !== "GA") {
      return corsJson(
        {
          ok: false,
          error: "out_of_area",
          message: "Thanks for reaching out. We currently serve Georgia only."
        },
        requestOrigin,
        { status: 400 }
      );
    }
    const normalizedPostalCode = normalizePostalCode(body.postalCode);
    void normalizedPostalCode;

    const db = getDb();
    const bookingRules = await getBookingRulesPolicy(db);
    const businessHours = await getBusinessHoursPolicy(db);
    const schedulingZone = businessHours.timezone || APPOINTMENT_TIME_ZONE;

    const [quote] = await db
      .select({
        id: instantQuotes.id,
        aiResult: instantQuotes.aiResult,
        perceivedSize: instantQuotes.perceivedSize,
        jobTypes: instantQuotes.jobTypes,
        notes: instantQuotes.notes
      })
      .from(instantQuotes)
      .where(eq(instantQuotes.id, body.instantQuoteId))
      .limit(1);

    if (!quote) {
      return corsJson({ ok: false, error: "quote_not_found" }, requestOrigin, { status: 404 });
    }

    const standardPolicy = await getStandardJobPolicy(db);
    const itemPolicy = await getItemPoliciesPolicy(db);
    const evaluation = evaluateStandardJob(
      {
        jobTypes: quote.jobTypes ?? [],
        perceivedSize: quote.perceivedSize,
        notes: quote.notes ?? null,
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

    const durationMinutes = deriveDurationMinutes(quote);
    const travelBufferMinutes =
      typeof bookingRules.bufferMinutes === "number" && Number.isFinite(bookingRules.bufferMinutes)
        ? bookingRules.bufferMinutes
        : DEFAULT_TRAVEL_BUFFER_MIN;

    const startAt = new Date(body.startAt);
    if (Number.isNaN(startAt.getTime())) {
      return corsJson({ ok: false, error: "invalid_startAt" }, requestOrigin, { status: 400 });
    }

    const nowLocal = DateTime.now().setZone(schedulingZone);
    const startLocal = DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(schedulingZone);
    if (!startLocal.isValid) {
      return corsJson({ ok: false, error: "invalid_startAt" }, requestOrigin, { status: 400 });
    }
    if (startLocal < nowLocal) {
      return corsJson({ ok: false, error: "start_in_past" }, requestOrigin, { status: 400 });
    }
    const bookingWindowDays =
      typeof bookingRules.bookingWindowDays === "number" && bookingRules.bookingWindowDays > 0
        ? Math.min(Math.floor(bookingRules.bookingWindowDays), 90)
        : WINDOW_DAYS;
    if (startLocal > nowLocal.plus({ days: bookingWindowDays }).endOf("day")) {
      return corsJson({ ok: false, error: "outside_booking_window" }, requestOrigin, { status: 400 });
    }
    const windows = getBusinessHourWindowsForDate(startLocal, businessHours);
    if (!windows.length) {
      return corsJson({ ok: false, error: "unavailable_day" }, requestOrigin, { status: 400 });
    }
    const endLocal = startLocal.plus({ minutes: durationMinutes });
    const window = windows.find((entry) => startLocal >= entry.start && endLocal <= entry.end);
    if (!window) {
      return corsJson({ ok: false, error: "outside_business_hours" }, requestOrigin, { status: 400 });
    }
    const slotOffset = Math.round(startLocal.diff(window.start, "minutes").minutes);
    if (!Number.isFinite(slotOffset) || slotOffset % SLOT_INTERVAL_MIN !== 0) {
      return corsJson({ ok: false, error: "invalid_start_time" }, requestOrigin, { status: 400 });
    }

    const [leadRow] = await db
      .select({ id: leads.id, contactId: leads.contactId, propertyId: leads.propertyId })
      .from(leads)
      .where(eq(leads.instantQuoteId, quote.id))
      .limit(1);

    const holdResult = await db.transaction(async (tx) => {
      const bookingDayKey = startLocal.toFormat("yyyyLLdd");
      const bookingLockKey = Number(bookingDayKey);
      if (Number.isFinite(bookingLockKey) && bookingLockKey > 0) {
        await tx.execute(sql`select pg_advisory_xact_lock(${bookingLockKey})`);
      }

      const now = new Date();

      await tx
        .update(appointmentHolds)
        .set({ status: "released", updatedAt: now })
        .where(and(eq(appointmentHolds.instantQuoteId, quote.id), eq(appointmentHolds.status, "active")));

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

        const [holdCount] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(appointmentHolds)
          .where(
            and(
              gte(appointmentHolds.startAt, dayStartUtc),
              lte(appointmentHolds.startAt, dayEndUtc),
              eq(appointmentHolds.status, "active"),
              gt(appointmentHolds.expiresAt, now)
            )
          );

        const totalCount = Number(dayCount?.count ?? 0) + Number(holdCount?.count ?? 0);
        if (totalCount >= bookingRules.maxJobsPerDay) {
          throw new HoldError("day_full", 409);
        }
      }

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

      const nearbyHolds = await tx
        .select({
          id: appointmentHolds.id,
          startAt: appointmentHolds.startAt,
          durationMinutes: appointmentHolds.durationMinutes,
          travelBufferMinutes: appointmentHolds.travelBufferMinutes
        })
        .from(appointmentHolds)
        .where(
          and(
            gte(appointmentHolds.startAt, lookbackStart),
            lte(appointmentHolds.startAt, lookaheadEnd),
            eq(appointmentHolds.status, "active"),
            gt(appointmentHolds.expiresAt, now)
          )
        );

      const blocks = nearbyAppts
        .filter((row) => row.startAt)
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
        throw new HoldError("slot_full", 409);
      }

      const expiresAt = new Date(now.getTime() + HOLD_WINDOW_MINUTES * 60_000);

      const [created] = await tx
        .insert(appointmentHolds)
        .values({
          instantQuoteId: quote.id,
          leadId: leadRow?.id ?? null,
          contactId: leadRow?.contactId ?? null,
          propertyId: leadRow?.propertyId ?? null,
          startAt,
          durationMinutes,
          travelBufferMinutes,
          status: "active",
          expiresAt
        })
        .returning({ id: appointmentHolds.id, expiresAt: appointmentHolds.expiresAt });

      if (!created?.id || !created.expiresAt) {
        throw new Error("hold_create_failed");
      }

      return { holdId: created.id, expiresAt: created.expiresAt.toISOString() };
    });

    return corsJson({ ok: true, ...holdResult, standardJobReview }, requestOrigin);
  } catch (error) {
    if (error instanceof HoldError) {
      return corsJson({ ok: false, error: error.code }, requestOrigin, { status: error.status });
    }
    console.error("[junk-quote-hold] server_error", error);
    return corsJson({ ok: false, error: "server_error" }, requestOrigin, { status: 500 });
  }
}
