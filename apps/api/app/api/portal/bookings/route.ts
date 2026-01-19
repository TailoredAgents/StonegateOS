import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { nanoid } from "nanoid";
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { availabilityWindows } from "@myst-os/pricing";
import { sendSmsMessage } from "@/lib/messaging";
import {
  appointmentHolds,
  appointmentNotes,
  appointments,
  contacts,
  getDb,
  partnerBookings,
  partnerRateCards,
  partnerRateItems,
  policySettings,
  properties
} from "@/db";
import { requirePartnerSession } from "@/lib/partner-portal-auth";
import { APPOINTMENT_TIME_ZONE, resolveAppointmentTiming } from "../../web/scheduling";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeServiceKey(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  return raw.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function resolveDevonPhone(db: ReturnType<typeof getDb>): Promise<string | null> {
  const config = await getSalesScorecardConfig(db);
  const memberId = config.defaultAssigneeMemberId?.trim().length ? config.defaultAssigneeMemberId.trim() : null;
  if (!memberId) return null;

  const [row] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, "team_member_phones"))
    .limit(1);

  const value = row?.value;
  if (!isRecord(value)) return null;
  const phones = value["phones"];
  if (!isRecord(phones)) return null;
  const phone = phones[memberId];
  return typeof phone === "string" && phone.trim().length > 0 ? phone.trim() : null;
}

function earliestPartnerBookableDate(now: Date): DateTime {
  const local = DateTime.fromJSDate(now, { zone: APPOINTMENT_TIME_ZONE });
  return local.plus({ days: 1 }).startOf("day");
}

function formatLocalDateTime(date: Date): string {
  return DateTime.fromJSDate(date, { zone: "utc" }).setZone(APPOINTMENT_TIME_ZONE).toLocaleString(DateTime.DATETIME_MED);
}

async function countOverlappingAppointments(input: {
  db: ReturnType<typeof getDb>;
  startAtUtc: Date;
  durationMinutes: number;
}): Promise<number> {
  const endAtUtc = new Date(input.startAtUtc.getTime() + input.durationMinutes * 60 * 1000);

  const [apptRow] = await input.db
    .select({ count: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "confirmed"),
        isNull(appointments.completedAt),
        // startAt < end && (startAt + duration) > start
        lt(appointments.startAt, endAtUtc),
        gt(
          sql`${appointments.startAt} + (${appointments.durationMinutes} * interval '1 minute')`,
          input.startAtUtc
        )
      )
    );

  const [holdRow] = await input.db
    .select({ count: sql<number>`count(*)::int` })
    .from(appointmentHolds)
    .where(
      and(
        eq(appointmentHolds.status, "active"),
        gt(appointmentHolds.expiresAt, new Date()),
        lt(appointmentHolds.startAt, endAtUtc),
        gt(
          sql`${appointmentHolds.startAt} + (${appointmentHolds.durationMinutes} * interval '1 minute')`,
          input.startAtUtc
        )
      )
    );

  return (apptRow?.count ?? 0) + (holdRow?.count ?? 0);
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: partnerBookings.id,
      appointmentId: partnerBookings.appointmentId,
      propertyId: partnerBookings.propertyId,
      serviceKey: partnerBookings.serviceKey,
      tierKey: partnerBookings.tierKey,
      amountCents: partnerBookings.amountCents,
      createdAt: partnerBookings.createdAt,
      appointmentStartAt: appointments.startAt,
      appointmentDuration: appointments.durationMinutes,
      appointmentStatus: appointments.status,
      propertyAddress: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostal: properties.postalCode
    })
    .from(partnerBookings)
    .innerJoin(appointments, eq(partnerBookings.appointmentId, appointments.id))
    .leftJoin(properties, eq(partnerBookings.propertyId, properties.id))
    .where(eq(partnerBookings.orgContactId, auth.partnerUser.orgContactId))
    .orderBy(asc(appointments.startAt));

  return NextResponse.json({
    ok: true,
    bookings: rows.map((row) => ({
      id: row.id,
      appointmentId: row.appointmentId,
      propertyId: row.propertyId,
      serviceKey: row.serviceKey,
      tierKey: row.tierKey,
      amountCents: row.amountCents,
      createdAt: row.createdAt.toISOString(),
      appointment: {
        startAt: row.appointmentStartAt ? row.appointmentStartAt.toISOString() : null,
        durationMinutes: row.appointmentDuration,
        status: row.appointmentStatus
      },
      property: row.propertyId
        ? {
            addressLine1: row.propertyAddress,
            city: row.propertyCity,
            state: row.propertyState,
            postalCode: row.propertyPostal
          }
        : null
    }))
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const propertyId = readString(payload?.["propertyId"]);
  const preferredDate = readString(payload?.["preferredDate"]);
  const timeWindowId = readString(payload?.["timeWindowId"]);
  const serviceKey = normalizeServiceKey(payload?.["serviceKey"]);
  const tierKey = readString(payload?.["tierKey"]) || null;
  const notes = readString(payload?.["notes"]) || null;

  if (!propertyId || !preferredDate || !timeWindowId || !serviceKey) {
    return NextResponse.json({ ok: false, error: "missing_required_fields" }, { status: 400 });
  }

  const window = availabilityWindows.find((w) => w.id === timeWindowId) ?? null;
  if (!window) {
    return NextResponse.json({ ok: false, error: "invalid_time_window" }, { status: 400 });
  }
  if (window.startHour < 8 || window.endHour > 19) {
    return NextResponse.json({ ok: false, error: "outside_business_hours" }, { status: 400 });
  }

  const db = getDb();
  const [property] = await db
    .select({
      id: properties.id,
      contactId: properties.contactId,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode
    })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.contactId, auth.partnerUser.orgContactId)))
    .limit(1);

  if (!property?.id) {
    return NextResponse.json({ ok: false, error: "property_not_found" }, { status: 404 });
  }

  const { startAt, durationMinutes } = resolveAppointmentTiming(preferredDate, timeWindowId);
  if (!startAt) {
    return NextResponse.json({ ok: false, error: "invalid_date" }, { status: 400 });
  }

  const now = new Date();
  const earliest = earliestPartnerBookableDate(now);
  const startLocal = DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(APPOINTMENT_TIME_ZONE);
  if (startLocal < earliest) {
    return NextResponse.json({ ok: false, error: "partner_cutoff_next_business_day" }, { status: 400 });
  }

  const overlaps = await countOverlappingAppointments({ db, startAtUtc: startAt, durationMinutes });
  if (overlaps >= 2) {
    return NextResponse.json({ ok: false, error: "slot_full" }, { status: 409 });
  }

  let amountCents: number | null = null;
  if (tierKey) {
    const [card] = await db
      .select({ id: partnerRateCards.id })
      .from(partnerRateCards)
      .where(eq(partnerRateCards.orgContactId, auth.partnerUser.orgContactId))
      .limit(1);
    if (card?.id) {
      const [rateRow] = await db
        .select({ amountCents: partnerRateItems.amountCents })
        .from(partnerRateItems)
        .where(
          and(
            eq(partnerRateItems.rateCardId, card.id),
            eq(partnerRateItems.serviceKey, serviceKey),
            eq(partnerRateItems.tierKey, tierKey)
          )
        )
        .limit(1);
      if (typeof rateRow?.amountCents === "number") {
        amountCents = rateRow.amountCents;
      }
    }
  }

  const rescheduleToken = nanoid(24);
  const [appointment] = await db
    .insert(appointments)
    .values({
      contactId: auth.partnerUser.orgContactId,
      propertyId: property.id,
      leadId: null,
      type: "partner",
      startAt,
      durationMinutes,
      status: "confirmed",
      rescheduleToken,
      travelBufferMinutes: 30,
      createdAt: now,
      updatedAt: now
    })
    .returning({ id: appointments.id, startAt: appointments.startAt, status: appointments.status });

  if (!appointment?.id) {
    return NextResponse.json({ ok: false, error: "create_failed" }, { status: 500 });
  }

  await db.insert(partnerBookings).values({
    orgContactId: auth.partnerUser.orgContactId,
    partnerUserId: auth.partnerUser.id,
    propertyId: property.id,
    appointmentId: appointment.id,
    serviceKey,
    tierKey,
    amountCents,
    createdAt: now
  });

  const noteLines = [
    "[partner-booking]",
    `Partner user: ${auth.partnerUser.email}`,
    `Service: ${serviceKey}`,
    tierKey ? `Tier: ${tierKey}` : null,
    amountCents !== null ? `Rate: $${(amountCents / 100).toFixed(2)}` : null,
    notes ? `Notes: ${notes}` : null
  ].filter((line): line is string => Boolean(line));

  await db.insert(appointmentNotes).values({
    appointmentId: appointment.id,
    body: noteLines.join("\n"),
    createdAt: now
  });

  const devonPhone = await resolveDevonPhone(db);
  if (devonPhone) {
    const [orgContact] = await db
      .select({ company: contacts.company, firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(eq(contacts.id, auth.partnerUser.orgContactId))
      .limit(1);

    const orgLabel =
      orgContact?.company?.trim().length
        ? orgContact.company.trim()
        : `${orgContact?.firstName ?? ""} ${orgContact?.lastName ?? ""}`.trim() || "Partner";

    const windowLabel =
      typeof (window as unknown as { label?: unknown }).label === "string"
        ? String((window as unknown as { label?: unknown }).label)
        : window.id;

    const message = [
      `New partner booking: ${orgLabel}`,
      `${property.addressLine1}, ${property.city}, ${property.state} ${property.postalCode}`,
      `${formatLocalDateTime(startAt)} (${windowLabel})`,
      tierKey ? `${serviceKey} (${tierKey})` : serviceKey,
      notes ? `Notes: ${notes}` : null
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    await sendSmsMessage(devonPhone, message);
  }

  return NextResponse.json({
    ok: true,
    appointmentId: appointment.id,
    startAt: appointment.startAt ? appointment.startAt.toISOString() : null
  });
}
