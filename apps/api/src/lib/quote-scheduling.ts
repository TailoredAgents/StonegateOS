import { DateTime } from "luxon";
import crypto from "node:crypto";
import { and, eq, gt, gte, lte, ne, sql } from "drizzle-orm";
import {
  appointmentHolds,
  appointments,
  contacts,
  getDb,
  outboxEvents,
  properties,
  quotes,
} from "@/db";
import {
  getBookingRulesPolicy,
  getBusinessHourWindowsForDate,
  getBusinessHoursPolicy,
  isWithinBusinessHours,
} from "@/lib/policy";
import { getAppointmentCapacity } from "@/lib/appointment-capacity";
import { DEFAULT_TRAVEL_BUFFER_MIN } from "../../app/api/web/scheduling";

const QUOTE_BOOKING_WINDOW_DAYS = 14;
const SLOT_INTERVAL_MINUTES = 60;
const HOLD_WINDOW_MINUTES = 15;

export type QuoteSlot = {
  startAt: string;
  endAt: string;
  label: string;
};

export type QuoteDaySlots = {
  date: string;
  slots: QuoteSlot[];
};

export type PublicQuoteSchedulingRow = {
  id: string;
  status: "pending" | "sent" | "accepted" | "declined";
  quoteNumber: string | null;
  contactId: string;
  propertyId: string;
  services: string[];
  total: unknown;
  jobDurationMinutes: number;
  expiresAt: Date | null;
  acceptedAppointmentId: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPhoneE164: string | null;
  propertyAddressLine1: string;
  propertyCity: string;
  propertyState: string;
  propertyPostalCode: string;
};

type Block = {
  start: Date;
  end: Date;
};

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function overlapsCount(blocks: Block[], start: Date, end: Date): number {
  let count = 0;
  for (const block of blocks) {
    if (overlaps(start, end, block.start, block.end)) count += 1;
  }
  return count;
}

function localDayKey(value: Date, timezone: string): string {
  return DateTime.fromJSDate(value, { zone: "utc" }).setZone(timezone).toISODate() ?? "";
}

function formatSlotLabel(startAt: Date, timezone: string): string {
  return DateTime.fromJSDate(startAt, { zone: "utc" })
    .setZone(timezone)
    .toLocaleString(DateTime.TIME_SIMPLE);
}

export function quoteIsExpired(quote: { expiresAt: Date | null }): boolean {
  return quote.expiresAt ? quote.expiresAt.getTime() < Date.now() : false;
}

export async function loadPublicQuoteForScheduling(
  token: string,
): Promise<PublicQuoteSchedulingRow | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: quotes.id,
      status: quotes.status,
      quoteNumber: quotes.quoteNumber,
      contactId: quotes.contactId,
      propertyId: quotes.propertyId,
      services: quotes.services,
      total: quotes.total,
      jobDurationMinutes: quotes.jobDurationMinutes,
      expiresAt: quotes.expiresAt,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id))
    .where(eq(quotes.shareToken, token))
    .limit(1);

  if (!row?.id || !row.propertyAddressLine1 || !row.propertyCity || !row.propertyState || !row.propertyPostalCode) {
    return null;
  }
  return {
    ...row,
    propertyAddressLine1: row.propertyAddressLine1,
    propertyCity: row.propertyCity,
    propertyState: row.propertyState,
    propertyPostalCode: row.propertyPostalCode,
  };
}

async function loadScheduleBlocks(input: {
  start: Date;
  end: Date;
  fallbackDurationMinutes: number;
  fallbackTravelBufferMinutes: number;
}): Promise<Block[]> {
  const db = getDb();
  const [appointmentRows, holdRows] = await Promise.all([
    db
      .select({
        startAt: appointments.startAt,
        durationMinutes: appointments.durationMinutes,
        travelBufferMinutes: appointments.travelBufferMinutes,
      })
      .from(appointments)
      .where(
        and(
          gte(appointments.startAt, input.start),
          lte(appointments.startAt, input.end),
          ne(appointments.status, "canceled"),
        ),
      ),
    db
      .select({
        startAt: appointmentHolds.startAt,
        durationMinutes: appointmentHolds.durationMinutes,
        travelBufferMinutes: appointmentHolds.travelBufferMinutes,
      })
      .from(appointmentHolds)
      .where(
        and(
          gte(appointmentHolds.startAt, input.start),
          lte(appointmentHolds.startAt, input.end),
          eq(appointmentHolds.status, "active"),
          gt(appointmentHolds.expiresAt, new Date()),
        ),
      ),
  ]);

  return [...appointmentRows, ...holdRows].flatMap((row) => {
    const start = row.startAt;
    if (!(start instanceof Date)) return [];
    const duration =
      (row.durationMinutes ?? input.fallbackDurationMinutes) +
      (row.travelBufferMinutes ?? input.fallbackTravelBufferMinutes);
    return [{ start, end: new Date(start.getTime() + duration * 60_000) }];
  });
}

async function getQuoteScheduleContext(quote: PublicQuoteSchedulingRow) {
  const db = getDb();
  const [businessHours, bookingRules] = await Promise.all([
    getBusinessHoursPolicy(db),
    getBookingRulesPolicy(db),
  ]);
  const timezone =
    businessHours.timezone ||
    process.env["APPOINTMENT_TIMEZONE"] ||
    "America/New_York";
  const durationMinutes = quote.jobDurationMinutes || 120;
  const travelBufferMinutes =
    typeof bookingRules.bufferMinutes === "number" && Number.isFinite(bookingRules.bufferMinutes)
      ? bookingRules.bufferMinutes
      : DEFAULT_TRAVEL_BUFFER_MIN;
  const capacity = getAppointmentCapacity();
  return { businessHours, bookingRules, timezone, durationMinutes, travelBufferMinutes, capacity };
}

export async function getQuoteAvailability(quote: PublicQuoteSchedulingRow): Promise<{
  days: QuoteDaySlots[];
  suggestions: QuoteSlot[];
  durationMinutes: number;
  travelBufferMinutes: number;
  timezone: string;
}> {
  const context = await getQuoteScheduleContext(quote);
  const nowLocal = DateTime.now().setZone(context.timezone);
  const nowUtc = new Date();
  const lookbackStart = new Date(nowUtc.getTime() - 24 * 60 * 60 * 1000);
  const windowEnd = nowUtc;
  windowEnd.setUTCDate(windowEnd.getUTCDate() + QUOTE_BOOKING_WINDOW_DAYS + 1);
  const blocks = await loadScheduleBlocks({
    start: lookbackStart,
    end: windowEnd,
    fallbackDurationMinutes: context.durationMinutes,
    fallbackTravelBufferMinutes: context.travelBufferMinutes,
  });

  const dayTotals = new Map<string, number>();
  for (const block of blocks) {
    const key = localDayKey(block.start, context.timezone);
    dayTotals.set(key, (dayTotals.get(key) ?? 0) + 1);
  }

  const days: QuoteDaySlots[] = [];
  const suggestions: QuoteSlot[] = [];
  for (let day = 0; day < QUOTE_BOOKING_WINDOW_DAYS; day++) {
    const baseDay = nowLocal.plus({ days: day }).startOf("day");
    const dayKey = baseDay.toISODate();
    if (!dayKey) continue;
    const daySlots: QuoteSlot[] = [];
    const windows = getBusinessHourWindowsForDate(baseDay, context.businessHours);
    if (context.bookingRules.maxJobsPerDay > 0 && (dayTotals.get(dayKey) ?? 0) >= context.bookingRules.maxJobsPerDay) {
      days.push({ date: dayKey, slots: daySlots });
      continue;
    }

    for (const window of windows) {
      let cursor = window.start;
      while (cursor.plus({ minutes: context.durationMinutes }) <= window.end) {
        if (cursor > nowLocal.plus({ hours: 2 })) {
          const start = cursor.toUTC().toJSDate();
          const end = new Date(start.getTime() + (context.durationMinutes + context.travelBufferMinutes) * 60_000);
          if (overlapsCount(blocks, start, end) < context.capacity) {
            const slot = {
              startAt: start.toISOString(),
              endAt: new Date(start.getTime() + context.durationMinutes * 60_000).toISOString(),
              label: formatSlotLabel(start, context.timezone),
            };
            daySlots.push(slot);
            if (suggestions.length < 6) suggestions.push(slot);
          }
        }
        cursor = cursor.plus({ minutes: SLOT_INTERVAL_MINUTES });
      }
    }
    days.push({ date: dayKey, slots: daySlots });
  }

  return {
    days,
    suggestions,
    durationMinutes: context.durationMinutes,
    travelBufferMinutes: context.travelBufferMinutes,
    timezone: context.timezone,
  };
}

export async function createQuoteAppointmentHold(
  quote: PublicQuoteSchedulingRow,
  startAtIso: string,
): Promise<{ holdId: string; expiresAt: string }> {
  const startAt = DateTime.fromISO(startAtIso, { setZone: true }).toUTC();
  if (!startAt.isValid) throw new Error("invalid_start_at");
  const start = startAt.toJSDate();
  const context = await getQuoteScheduleContext(quote);
  if (!isWithinBusinessHours(start, context.durationMinutes, context.businessHours)) {
    throw new Error("outside_business_hours");
  }
  const end = new Date(start.getTime() + (context.durationMinutes + context.travelBufferMinutes) * 60_000);
  const blocks = await loadScheduleBlocks({
    start: new Date(start.getTime() - 24 * 60 * 60 * 1000),
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
    fallbackDurationMinutes: context.durationMinutes,
    fallbackTravelBufferMinutes: context.travelBufferMinutes,
  });
  if (overlapsCount(blocks, start, end) >= context.capacity) {
    throw new Error("slot_full");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + HOLD_WINDOW_MINUTES * 60_000);
  const db = getDb();
  const [created] = await db
    .insert(appointmentHolds)
    .values({
      contactId: quote.contactId,
      propertyId: quote.propertyId,
      startAt: start,
      durationMinutes: context.durationMinutes,
      travelBufferMinutes: context.travelBufferMinutes,
      status: "active",
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: appointmentHolds.id, expiresAt: appointmentHolds.expiresAt });
  if (!created?.id) throw new Error("hold_create_failed");
  return { holdId: created.id, expiresAt: created.expiresAt.toISOString() };
}

export async function bookAcceptedQuote(input: {
  quote: PublicQuoteSchedulingRow;
  holdId?: string | null;
  startAtIso: string;
}): Promise<{ appointmentId: string; startAt: string }> {
  if (input.quote.acceptedAppointmentId) {
    return { appointmentId: input.quote.acceptedAppointmentId, startAt: "" };
  }
  const startAt = DateTime.fromISO(input.startAtIso, { setZone: true }).toUTC();
  if (!startAt.isValid) throw new Error("invalid_start_at");
  const start = startAt.toJSDate();
  const context = await getQuoteScheduleContext(input.quote);
  const db = getDb();
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    if (input.holdId) {
      const [hold] = await tx
        .select({
          id: appointmentHolds.id,
          startAt: appointmentHolds.startAt,
          status: appointmentHolds.status,
          expiresAt: appointmentHolds.expiresAt,
          contactId: appointmentHolds.contactId,
          propertyId: appointmentHolds.propertyId,
        })
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, input.holdId))
        .limit(1);
      if (
        !hold ||
        hold.status !== "active" ||
        hold.expiresAt <= now ||
        hold.contactId !== input.quote.contactId ||
        hold.propertyId !== input.quote.propertyId ||
        Math.abs(hold.startAt.getTime() - start.getTime()) > 60_000
      ) {
        throw new Error("hold_invalid");
      }
      await tx
        .update(appointmentHolds)
        .set({ status: "consumed", consumedAt: now, updatedAt: now })
        .where(eq(appointmentHolds.id, hold.id));
    }

    const [appointment] = await tx
      .insert(appointments)
      .values({
        contactId: input.quote.contactId,
        propertyId: input.quote.propertyId,
        type: "job",
        startAt: start,
        durationMinutes: context.durationMinutes,
        travelBufferMinutes: context.travelBufferMinutes,
        status: "confirmed",
        rescheduleToken: crypto.randomUUID(),
        quotedTotalCents: Math.round(Number(input.quote.total ?? 0) * 100),
      })
      .returning({ id: appointments.id });
    if (!appointment?.id) throw new Error("appointment_create_failed");

    await tx.update(quotes).set({
      status: "accepted",
      acceptedAppointmentId: appointment.id,
      updatedAt: now,
    }).where(eq(quotes.id, input.quote.id));

    await tx.insert(outboxEvents).values({
      type: "estimate.requested",
      payload: {
        appointmentId: appointment.id,
        services: input.quote.services,
        quoteId: input.quote.id,
      },
    });

    await tx.insert(outboxEvents).values({
      type: "pipeline.auto_stage_change",
      payload: {
        contactId: input.quote.contactId,
        toStage: "won",
        reason: "quote.accepted.booked",
        meta: { quoteId: input.quote.id, appointmentId: appointment.id },
      },
    });

    return { appointmentId: appointment.id, startAt: start.toISOString() };
  });

  await db
    .update(appointmentHolds)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(appointmentHolds.contactId, input.quote.contactId),
        eq(appointmentHolds.propertyId, input.quote.propertyId),
        eq(appointmentHolds.status, "active"),
        sql`${appointmentHolds.expiresAt} <= ${now}`,
      ),
    );

  return result;
}
