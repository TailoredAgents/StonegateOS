import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { nanoid } from "nanoid";
import { and, asc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  availabilityWindows,
  isPartnerAllowedServiceKey,
  isPartnerTierKeyForService,
  weeklyAvailability,
} from "@myst-os/pricing";
import { queueSystemOutboundMessage } from "@/lib/system-outbound";
import { getAppointmentCapacity } from "@/lib/appointment-capacity";
import { resolveAutomaticAppointmentStatusForMedia } from "@/lib/appointment-media";
import {
  appointmentHolds,
  appointmentNotes,
  appointments,
  auditLogs,
  contactProperties,
  contacts,
  getDb,
  outboxEvents,
  partnerBookings,
  partnerRateCards,
  partnerRateItems,
  partnerUsers,
  properties,
} from "@/db";
import {
  requirePartnerSession,
  resolvePublicSiteBaseUrl,
} from "@/lib/partner-portal-auth";
import {
  APPOINTMENT_TIME_ZONE,
  resolveAppointmentTiming,
} from "../../web/scheduling";
import {
  hashPartnerBookingRequest,
  hashPartnerOperationKey,
  normalizePartnerOperationKey,
  queuePartnerBookingStaffAlert,
  resolvePartnerBookingStaffRecipient,
} from "@/lib/staff-notification-operations";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const WEEKDAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const SERVICE_DAYS = new Set(
  weeklyAvailability.serviceDays.map((d) => d.toLowerCase()),
);

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeServiceKey(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  return raw.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function earliestPartnerBookableDate(now: Date): DateTime {
  const local = DateTime.fromJSDate(now, { zone: APPOINTMENT_TIME_ZONE });
  let cursor = local.plus({ days: 1 }).startOf("day");
  for (let i = 0; i < 14; i += 1) {
    const key = WEEKDAY_KEYS[(cursor.weekday - 1) % 7] ?? null;
    if (key && SERVICE_DAYS.has(key)) return cursor;
    cursor = cursor.plus({ days: 1 });
  }
  return local.plus({ days: 1 }).startOf("day");
}

function formatLocalDateTime(date: Date): string {
  return DateTime.fromJSDate(date, { zone: "utc" })
    .setZone(APPOINTMENT_TIME_ZONE)
    .toLocaleString(DateTime.DATETIME_MED);
}

async function countOverlappingAppointments(input: {
  db: TeamMutationTransaction;
  startAtUtc: Date;
  durationMinutes: number;
  excludeAppointmentId?: string | null;
}): Promise<number> {
  const endAtUtc = new Date(
    input.startAtUtc.getTime() + input.durationMinutes * 60 * 1000,
  );
  const startAtIso = input.startAtUtc.toISOString();
  const endAtIso = endAtUtc.toISOString();
  const nowIso = new Date().toISOString();
  const startAtTz = sql`${startAtIso}::timestamptz`;
  const endAtTz = sql`${endAtIso}::timestamptz`;
  const nowTz = sql`${nowIso}::timestamptz`;

  const [apptRow] = await input.db
    .select({ count: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "confirmed"),
        isNull(appointments.completedAt),
        input.excludeAppointmentId
          ? ne(appointments.id, input.excludeAppointmentId)
          : undefined,
        // startAt < end && (startAt + duration) > start
        lt(appointments.startAt, endAtTz),
        gt(
          sql`${appointments.startAt} + (${appointments.durationMinutes} * interval '1 minute')`,
          startAtTz,
        ),
      ),
    );

  const [holdRow] = await input.db
    .select({ count: sql<number>`count(*)::int` })
    .from(appointmentHolds)
    .where(
      and(
        eq(appointmentHolds.status, "active"),
        gt(appointmentHolds.expiresAt, nowTz),
        lt(appointmentHolds.startAt, endAtTz),
        gt(
          sql`${appointmentHolds.startAt} + (${appointmentHolds.durationMinutes} * interval '1 minute')`,
          startAtTz,
        ),
      ),
    );

  return (apptRow?.count ?? 0) + (holdRow?.count ?? 0);
}

function parseExpectedVersion(value: string | null): number | null {
  if (!value) return null;
  const match = /^(?:W\/)?"?(\d{1,9})"?$/u.exec(value.trim());
  if (!match?.[1]) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status },
    );
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
      version: partnerBookings.version,
      createdAt: partnerBookings.createdAt,
      appointmentStartAt: appointments.startAt,
      appointmentDuration: appointments.durationMinutes,
      appointmentStatus: appointments.status,
      propertyAddress: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostal: properties.postalCode,
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
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      appointment: {
        startAt: row.appointmentStartAt
          ? row.appointmentStartAt.toISOString()
          : null,
        durationMinutes: row.appointmentDuration,
        status: row.appointmentStatus,
      },
      property: row.propertyId
        ? {
            addressLine1: row.propertyAddress,
            city: row.propertyCity,
            state: row.propertyState,
            postalCode: row.propertyPostal,
          }
        : null,
    })),
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status },
    );
  }

  const operationKey = normalizePartnerOperationKey(
    request.headers.get("idempotency-key"),
  );
  if (!operationKey) {
    return NextResponse.json(
      { ok: false, error: "idempotency_key_required" },
      { status: 422 },
    );
  }

  let rawPayload: unknown;
  try {
    rawPayload = await readBoundedJsonRequest(request, {
      maximumBytes: 12 * 1024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    if (error instanceof BoundedJsonRequestError) {
      return NextResponse.json(
        { ok: false, error: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 400 },
    );
  }
  const payload = isRecord(rawPayload) ? rawPayload : null;
  if (!payload) {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 400 },
    );
  }
  const allowedKeys = new Set([
    "propertyId",
    "preferredDate",
    "timeWindowId",
    "serviceKey",
    "tierKey",
    "notes",
    "rescheduleFromAppointmentId",
  ]);
  if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
    return NextResponse.json(
      { ok: false, error: "unexpected_field" },
      { status: 422 },
    );
  }

  const propertyId = readString(payload?.["propertyId"]);
  const preferredDate = readString(payload?.["preferredDate"]);
  const timeWindowId = readString(payload?.["timeWindowId"]);
  const serviceKey = normalizeServiceKey(payload?.["serviceKey"]);
  const tierKey = readString(payload?.["tierKey"]) || null;
  const notes = readString(payload?.["notes"]) || null;
  const rescheduleFromAppointmentId =
    readString(payload?.["rescheduleFromAppointmentId"]) || null;
  const rescheduleFromVersion = rescheduleFromAppointmentId
    ? parseExpectedVersion(request.headers.get("if-match"))
    : null;

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      propertyId,
    ) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(preferredDate) ||
    !timeWindowId ||
    !serviceKey ||
    (rescheduleFromAppointmentId !== null &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        rescheduleFromAppointmentId,
      )) ||
    (tierKey !== null && tierKey.length > 120) ||
    (notes !== null && notes.length > 2_000)
  ) {
    return NextResponse.json(
      { ok: false, error: "invalid_fields" },
      { status: 422 },
    );
  }
  if (rescheduleFromAppointmentId && !rescheduleFromVersion) {
    return NextResponse.json(
      { ok: false, error: "expected_version_required" },
      { status: 428 },
    );
  }

  if (!isPartnerAllowedServiceKey(serviceKey)) {
    return NextResponse.json(
      { ok: false, error: "invalid_service_key" },
      { status: 400 },
    );
  }
  if (tierKey && !isPartnerTierKeyForService(serviceKey, tierKey)) {
    return NextResponse.json(
      { ok: false, error: "invalid_tier_key" },
      { status: 400 },
    );
  }

  const window = availabilityWindows.find((w) => w.id === timeWindowId) ?? null;
  if (!window) {
    return NextResponse.json(
      { ok: false, error: "invalid_time_window" },
      { status: 400 },
    );
  }
  if (
    window.startHour < weeklyAvailability.startHour ||
    window.endHour > weeklyAvailability.endHour
  ) {
    return NextResponse.json(
      { ok: false, error: "outside_business_hours" },
      { status: 400 },
    );
  }

  const { startAt, durationMinutes } = resolveAppointmentTiming(
    preferredDate,
    timeWindowId,
  );
  if (!startAt) {
    return NextResponse.json(
      { ok: false, error: "invalid_date" },
      { status: 400 },
    );
  }

  const now = new Date();
  const preferredLocal = DateTime.fromISO(preferredDate, {
    zone: APPOINTMENT_TIME_ZONE,
  });
  if (preferredLocal.isValid) {
    const key = WEEKDAY_KEYS[(preferredLocal.weekday - 1) % 7] ?? null;
    if (key && !SERVICE_DAYS.has(key)) {
      return NextResponse.json(
        { ok: false, error: "outside_service_days" },
        { status: 400 },
      );
    }
  }

  const operationKeyHash = hashPartnerOperationKey(
    auth.partnerUser.id,
    rescheduleFromAppointmentId
      ? `${rescheduleFromAppointmentId}:reschedule:${operationKey}`
      : operationKey,
  );
  const requestHash = hashPartnerBookingRequest({
    propertyId,
    preferredDate,
    timeWindowId,
    serviceKey,
    tierKey,
    notes,
    rescheduleFromAppointmentId,
    rescheduleFromVersion,
  });
  const auditAction = rescheduleFromAppointmentId
    ? "partner.booking.rescheduled"
    : "partner.booking.created";
  const correlationId = randomUUID();
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-booking-operation:${operationKeyHash}`}, 0))`,
    );
    const [existing] = await tx
      .select({
        bookingId: partnerBookings.id,
        requestHash: partnerBookings.createRequestHash,
        version: partnerBookings.version,
        committedAt: partnerBookings.createdAt,
        appointmentId: appointments.id,
        startAt: appointments.startAt,
        status: appointments.status,
      })
      .from(partnerBookings)
      .innerJoin(
        appointments,
        eq(partnerBookings.appointmentId, appointments.id),
      )
      .where(eq(partnerBookings.createOperationKeyHash, operationKeyHash))
      .limit(1);
    if (existing?.appointmentId) {
      if (existing.requestHash !== requestHash) {
        return { kind: "idempotency_conflict" as const };
      }
      const [existingAudit] = await tx
        .select({
          id: auditLogs.id,
          correlationId: auditLogs.correlationId,
          createdAt: auditLogs.createdAt,
          meta: auditLogs.meta,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, auditAction),
            eq(auditLogs.entityType, "appointment"),
            eq(auditLogs.entityId, existing.appointmentId),
            eq(auditLogs.idempotencyKeyHash, operationKeyHash),
          ),
        )
        .limit(1);
      const existingAuditMeta = isRecord(existingAudit?.meta)
        ? existingAudit.meta
        : null;
      const originalVersion = existingAuditMeta?.["version"];
      const originalStatus = existingAuditMeta?.["status"];
      if (
        !existingAudit?.id ||
        !existingAudit.correlationId ||
        typeof originalVersion !== "number" ||
        !Number.isSafeInteger(originalVersion) ||
        originalVersion < 1 ||
        (originalStatus !== "requested" && originalStatus !== "confirmed")
      ) {
        throw new Error("partner_booking_replay_audit_missing");
      }
      return {
        kind: "appointment" as const,
        appointment: {
          ...existing,
          version: originalVersion,
          status: originalStatus,
          committedAt: existingAudit.createdAt,
        },
        correlationId: existingAudit.correlationId,
        auditEventId: existingAudit.id,
        replay: true,
        rescheduledFromAppointmentId: rescheduleFromAppointmentId,
        rescheduledFromVersion: rescheduleFromAppointmentId
          ? rescheduleFromVersion
          : null,
      };
    }

    const earliest = earliestPartnerBookableDate(now);
    const startLocal = DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(
      APPOINTMENT_TIME_ZONE,
    );
    if (startLocal < earliest) {
      return { kind: "cutoff_elapsed" as const };
    }

    let sourceBooking: {
      bookingId: string;
      bookingVersion: number;
      appointmentId: string;
      status: "requested" | "confirmed";
      startAt: Date | null;
      calendarEventId: string | null;
    } | null = null;
    if (rescheduleFromAppointmentId && rescheduleFromVersion) {
      // Cancellation and rescheduling share this lock, so only one terminal
      // decision can consume a source booking version.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-booking-cancel:${rescheduleFromAppointmentId}`}, 0))`,
      );
      const [source] = await tx
        .select({
          bookingId: partnerBookings.id,
          bookingVersion: partnerBookings.version,
          appointmentId: appointments.id,
          status: appointments.status,
          startAt: appointments.startAt,
          calendarEventId: appointments.calendarEventId,
        })
        .from(partnerBookings)
        .innerJoin(
          appointments,
          eq(partnerBookings.appointmentId, appointments.id),
        )
        .where(
          and(
            eq(partnerBookings.orgContactId, auth.partnerUser.orgContactId),
            eq(partnerBookings.appointmentId, rescheduleFromAppointmentId),
          ),
        )
        .for("update")
        .limit(1);
      if (!source?.appointmentId) {
        return { kind: "source_not_found" as const };
      }
      if (source.bookingVersion !== rescheduleFromVersion) {
        return {
          kind: "source_version_conflict" as const,
          currentVersion: source.bookingVersion,
        };
      }
      const sourceStatus = source.status;
      if (sourceStatus !== "requested" && sourceStatus !== "confirmed") {
        return {
          kind: "source_status_conflict" as const,
          status: sourceStatus,
          currentVersion: source.bookingVersion,
        };
      }
      sourceBooking = {
        ...source,
        status: sourceStatus,
      };
    }

    // Serialize every partner booking that can consume capacity on this local
    // service date, then recount while holding the transaction lock.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-booking-capacity:${preferredDate}`}, 0))`,
    );

    const [property] = await tx
      .select({
        id: properties.id,
        addressLine1: properties.addressLine1,
        city: properties.city,
        state: properties.state,
        postalCode: properties.postalCode,
      })
      .from(properties)
      .leftJoin(
        contactProperties,
        and(
          eq(contactProperties.propertyId, properties.id),
          eq(contactProperties.contactId, auth.partnerUser.orgContactId),
        ),
      )
      .where(
        and(
          eq(properties.id, propertyId),
          or(
            eq(properties.contactId, auth.partnerUser.orgContactId),
            eq(contactProperties.contactId, auth.partnerUser.orgContactId),
          ),
        ),
      )
      .limit(1);
    if (!property?.id) return { kind: "property_not_found" as const };

    const overlaps = await countOverlappingAppointments({
      db: tx,
      startAtUtc: startAt,
      durationMinutes,
      excludeAppointmentId: sourceBooking?.appointmentId ?? null,
    });
    if (overlaps >= getAppointmentCapacity()) {
      return { kind: "slot_full" as const };
    }

    let amountCents: number | null = null;
    if (tierKey) {
      const [rateRow] = await tx
        .select({ amountCents: partnerRateItems.amountCents })
        .from(partnerRateItems)
        .innerJoin(
          partnerRateCards,
          eq(partnerRateItems.rateCardId, partnerRateCards.id),
        )
        .where(
          and(
            eq(partnerRateCards.orgContactId, auth.partnerUser.orgContactId),
            eq(partnerRateItems.serviceKey, serviceKey),
            eq(partnerRateItems.tierKey, tierKey),
          ),
        )
        .limit(1);
      if (typeof rateRow?.amountCents !== "number") {
        return { kind: "rate_not_configured" as const };
      }
      amountCents = rateRow.amountCents;
    }

    const [orgContact] = await tx
      .select({
        company: contacts.company,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
      })
      .from(contacts)
      .where(eq(contacts.id, auth.partnerUser.orgContactId))
      .limit(1);
    const [partnerUser] = await tx
      .select({
        id: partnerUsers.id,
        name: partnerUsers.name,
        email: partnerUsers.email,
        phoneE164: partnerUsers.phoneE164,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, auth.partnerUser.id))
      .limit(1);
    if (!partnerUser?.id) return { kind: "partner_unavailable" as const };

    const appointmentStatus = await resolveAutomaticAppointmentStatusForMedia({
      proposedStatus: "confirmed",
      quotedScopeText: null,
      contactId: auth.partnerUser.orgContactId,
      database: tx,
      now,
    });
    const [created] = await tx
      .insert(appointments)
      .values({
        contactId: auth.partnerUser.orgContactId,
        propertyId: property.id,
        leadId: null,
        type: "partner",
        startAt,
        durationMinutes,
        status: appointmentStatus,
        rescheduleToken: nanoid(24),
        travelBufferMinutes: 30,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: appointments.id,
        startAt: appointments.startAt,
        status: appointments.status,
        updatedAt: appointments.updatedAt,
      });
    if (!created?.id) return { kind: "create_failed" as const };

    const [booking] = await tx
      .insert(partnerBookings)
      .values({
        orgContactId: auth.partnerUser.orgContactId,
        partnerUserId: auth.partnerUser.id,
        propertyId: property.id,
        appointmentId: created.id,
        serviceKey,
        tierKey,
        amountCents,
        createOperationKeyHash: operationKeyHash,
        createRequestHash: requestHash,
        version: 1,
        createdAt: now,
      })
      .returning({ id: partnerBookings.id, version: partnerBookings.version });
    if (!booking?.id) return { kind: "create_failed" as const };

    const auditEventId = randomUUID();
    let sourceBookingVersion: number | null = null;
    let sourceStatusOutboxEventId: string | null = null;
    let sourceCalendarOutboxEventId: string | null = null;
    if (sourceBooking) {
      const [canceledSourceAppointment] = await tx
        .update(appointments)
        .set({ status: "canceled", updatedAt: now })
        .where(
          and(
            eq(appointments.id, sourceBooking.appointmentId),
            eq(appointments.status, sourceBooking.status),
          ),
        )
        .returning({
          id: appointments.id,
          updatedAt: appointments.updatedAt,
        });
      if (!canceledSourceAppointment?.id) {
        throw new Error("partner_reschedule_source_status_changed");
      }
      const [canceledSourceBooking] = await tx
        .update(partnerBookings)
        .set({
          cancelOperationKeyHash: operationKeyHash,
          version: sourceBooking.bookingVersion + 1,
          canceledAt: now,
        })
        .where(
          and(
            eq(partnerBookings.id, sourceBooking.bookingId),
            eq(partnerBookings.version, sourceBooking.bookingVersion),
          ),
        )
        .returning({ version: partnerBookings.version });
      if (!canceledSourceBooking) {
        throw new Error("partner_reschedule_source_version_changed");
      }
      sourceBookingVersion = canceledSourceBooking.version;

      await tx.insert(appointmentNotes).values({
        appointmentId: sourceBooking.appointmentId,
        body: [
          "[partner-booking-rescheduled]",
          `Rescheduled by portal user: ${auth.partnerUser.email}`,
          `Replacement appointment: ${created.id}`,
        ].join("\n"),
        createdAt: now,
      });

      sourceStatusOutboxEventId = randomUUID();
      const sourceAppointmentVersion =
        canceledSourceAppointment.updatedAt.toISOString();
      await tx.insert(outboxEvents).values({
        id: sourceStatusOutboxEventId,
        type: "estimate.status_changed",
        payload: {
          appointmentId: sourceBooking.appointmentId,
          status: "canceled",
          statusChanged: true,
          customerNotificationRequested: false,
          version: sourceAppointmentVersion,
          reason: "partner.booking.rescheduled",
        },
        createdAt: now,
      });
      if (sourceBooking.calendarEventId) {
        sourceCalendarOutboxEventId = randomUUID();
        await tx.insert(outboxEvents).values({
          id: sourceCalendarOutboxEventId,
          type: "appointment.calendar_sync_requested",
          payload: {
            appointmentId: sourceBooking.appointmentId,
            version: sourceAppointmentVersion,
            reason: "partner.booking.rescheduled",
            requestedCalendarEventId: sourceBooking.calendarEventId,
            sourceAuditEventId: auditEventId,
            actorId: auth.partnerUser.id,
            sessionId: auth.partnerUser.sessionId,
            authMethod: "partner_session",
            correlationId,
            operationId: booking.id,
            requiredPermission: "partner.bookings.reschedule",
          },
          createdAt: now,
        });
      }
    }

    const [mediaEvent] = await tx
      .insert(outboxEvents)
      .values({
        type: "appointment_media.attach_appointment",
        payload: { appointmentId: created.id },
        createdAt: now,
      })
      .returning({ id: outboxEvents.id });
    const [calendarEvent] = await tx
      .insert(outboxEvents)
      .values({
        type: "appointment.calendar_sync_requested",
        payload: {
          appointmentId: created.id,
          version: created.updatedAt.toISOString(),
          reason: auditAction,
          requestedCalendarEventId: null,
          correlationId,
        },
        createdAt: now,
      })
      .returning({ id: outboxEvents.id });

    const noteLines = [
      sourceBooking ? "[partner-booking-rescheduled]" : "[partner-booking]",
      `Partner user: ${auth.partnerUser.email}`,
      sourceBooking
        ? `Previous appointment: ${sourceBooking.appointmentId}`
        : null,
      `Service: ${serviceKey}`,
      tierKey ? `Tier: ${tierKey}` : null,
      amountCents !== null ? `Rate: $${(amountCents / 100).toFixed(2)}` : null,
      notes ? `Notes: ${notes}` : null,
    ].filter((line): line is string => Boolean(line));

    await tx.insert(appointmentNotes).values({
      appointmentId: created.id,
      body: noteLines.join("\n"),
      createdAt: now,
    });

    const orgLabel = orgContact?.company?.trim().length
      ? orgContact.company.trim()
      : `${orgContact?.firstName ?? ""} ${orgContact?.lastName ?? ""}`.trim() ||
        "Partner";

    const windowLabel =
      typeof (window as unknown as { label?: unknown }).label === "string"
        ? String((window as unknown as { label?: unknown }).label)
        : window.id;

    const staffMessage = [
      sourceBooking
        ? created.status === "requested"
          ? `Partner booking rescheduled, awaiting scope review: ${orgLabel}`
          : `Partner booking rescheduled: ${orgLabel}`
        : created.status === "requested"
          ? `New partner booking awaiting scope review: ${orgLabel}`
          : `New partner booking: ${orgLabel}`,
      sourceBooking?.startAt
        ? `Previous time: ${formatLocalDateTime(sourceBooking.startAt)}`
        : null,
      `${property.addressLine1}, ${property.city}, ${property.state} ${property.postalCode}`,
      `${formatLocalDateTime(startAt)} (${windowLabel})`,
      tierKey ? `${serviceKey} (${tierKey})` : serviceKey,
      notes ? `Notes: ${notes}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const staffRecipient = await resolvePartnerBookingStaffRecipient(tx);
    const staffAlert = staffRecipient
      ? await queuePartnerBookingStaffAlert(tx, {
          appointmentId: created.id,
          contactId: auth.partnerUser.orgContactId,
          recipient: staffRecipient,
          kind: "partner_booking_created",
          body: staffMessage,
          actor: {
            partnerUserId: auth.partnerUser.id,
            sessionId: auth.partnerUser.sessionId,
            label: auth.partnerUser.email,
          },
          correlationId,
          now,
        })
      : null;

    // Partner-facing confirmations are created in the same transaction as the
    // booking. Provider dispatch remains asynchronous and independently
    // observable through the normal message operation state machine.
    const when = `${formatLocalDateTime(startAt)} (${windowLabel})`;
    const address = `${property.addressLine1}, ${property.city}, ${property.state} ${property.postalCode}`;
    const portalLink = (() => {
      const base = resolvePublicSiteBaseUrl();
      if (!base) return null;
      const url = new URL("/partners/bookings", base);
      return url.toString();
    })();

    const partnerName = partnerUser?.name?.trim().length
      ? partnerUser.name.trim()
      : "there";
    const isPendingScopeReview = created.status === "requested";
    const smsBody = sourceBooking
      ? isPendingScopeReview
        ? `Stonegate: your booking was moved to ${when} at ${address}. Our office will confirm it after reviewing the quoted-work details.`
        : `Stonegate: your booking was rescheduled to ${when} at ${address}. Reply here if anything changes.`
      : isPendingScopeReview
        ? `Stonegate: booking received for ${when} at ${address}. Our office will confirm it after reviewing the quoted-work details.`
        : `Stonegate: booking confirmed for ${when} at ${address}. Reply here if anything changes.`;
    const emailSubject = sourceBooking
      ? isPendingScopeReview
        ? "Stonegate Partner booking moved — review pending"
        : "Stonegate Partner booking rescheduled"
      : isPendingScopeReview
        ? "Stonegate Partner booking received"
        : "Stonegate Partner booking confirmed";
    const emailBody = [
      `Hi ${partnerName},`,
      "",
      sourceBooking
        ? isPendingScopeReview
          ? "Your booking was moved and is awaiting quoted-work review:"
          : "Your booking was rescheduled:"
        : isPendingScopeReview
          ? "Your booking was received and is awaiting quoted-work review:"
          : "Your booking is confirmed:",
      when,
      address,
      `Service: ${serviceKey}${tierKey ? ` (${tierKey})` : ""}`,
      notes ? `Notes: ${notes}` : null,
      portalLink ? "" : null,
      portalLink ? `View bookings: ${portalLink}` : null,
      "",
      "Reply to this message if anything changes.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    const emailMessageId = partnerUser.email
      ? await queueSystemOutboundMessage({
          db: tx,
          contactId: auth.partnerUser.orgContactId,
          channel: "email",
          toAddress: partnerUser.email,
          subject: emailSubject,
          body: emailBody,
          metadata: {
            confirmationLoop: true,
            partnerPortal: true,
            kind: sourceBooking
              ? "partner.booking.rescheduled"
              : "partner.booking.confirmation",
            appointmentId: created.id,
            previousAppointmentId: sourceBooking?.appointmentId ?? null,
            partnerUserId: auth.partnerUser.id,
          },
          dedupeKey: `partner.booking.${sourceBooking ? "rescheduled" : "confirmation"}:${created.id}:${auth.partnerUser.id}:email`,
        })
      : null;

    const smsMessageId = partnerUser.phoneE164
      ? await queueSystemOutboundMessage({
          db: tx,
          contactId: auth.partnerUser.orgContactId,
          channel: "sms",
          toAddress: partnerUser.phoneE164,
          body: smsBody,
          metadata: {
            confirmationLoop: true,
            partnerPortal: true,
            kind: sourceBooking
              ? "partner.booking.rescheduled"
              : "partner.booking.confirmation",
            appointmentId: created.id,
            previousAppointmentId: sourceBooking?.appointmentId ?? null,
            partnerUserId: auth.partnerUser.id,
          },
          dedupeKey: `partner.booking.${sourceBooking ? "rescheduled" : "confirmation"}:${created.id}:${auth.partnerUser.id}:sms`,
        })
      : null;

    await tx.insert(auditLogs).values({
      id: auditEventId,
      actorType: "human",
      actorId: auth.partnerUser.id,
      actorRole: "partner",
      actorLabel: auth.partnerUser.email,
      sessionId: auth.partnerUser.sessionId,
      authMethod: "partner_session",
      correlationId,
      requiredPermissions: [
        sourceBooking
          ? "partner.bookings.reschedule"
          : "partner.bookings.create",
      ],
      outcome: "succeeded",
      surface: "/partners/bookings",
      idempotencyKeyHash: operationKeyHash,
      action: auditAction,
      entityType: "appointment",
      entityId: created.id,
      meta: sanitizeAuditMetadata({
        bookingId: booking.id,
        previousBookingId: sourceBooking?.bookingId ?? null,
        previousAppointmentId: sourceBooking?.appointmentId ?? null,
        propertyId: property.id,
        serviceKey,
        tierKey,
        amountCents,
        status: created.status,
        version: booking.version,
        previousVersion: sourceBooking?.bookingVersion ?? null,
        previousResultingVersion: sourceBookingVersion,
        committedAt: now,
        mediaOutboxEventId: mediaEvent?.id ?? null,
        calendarOutboxEventId: calendarEvent?.id ?? null,
        previousStatusOutboxEventId: sourceStatusOutboxEventId,
        previousCalendarOutboxEventId: sourceCalendarOutboxEventId,
        calendarSync: "requested",
        staffAlertOperationId: staffAlert?.operationId ?? null,
        staffAlertState: staffAlert ? "requested" : "recipient_unavailable",
        customerEmailMessageId: emailMessageId,
        customerSmsMessageId: smsMessageId,
      }),
      createdAt: now,
    });

    return {
      kind: "appointment" as const,
      appointment: {
        bookingId: booking.id,
        appointmentId: created.id,
        startAt: created.startAt,
        status: created.status,
        version: booking.version,
        committedAt: now,
      },
      correlationId,
      auditEventId,
      replay: false,
      rescheduledFromAppointmentId: sourceBooking?.appointmentId ?? null,
      rescheduledFromVersion: sourceBooking?.bookingVersion ?? null,
    };
  });

  if (result.kind === "idempotency_conflict") {
    return NextResponse.json(
      { ok: false, error: "idempotency_conflict" },
      { status: 409 },
    );
  }
  if (result.kind === "property_not_found") {
    return NextResponse.json(
      { ok: false, error: "property_not_found" },
      { status: 404 },
    );
  }
  if (result.kind === "source_not_found") {
    return NextResponse.json(
      { ok: false, error: "reschedule_source_not_found" },
      { status: 404 },
    );
  }
  if (result.kind === "source_version_conflict") {
    return NextResponse.json(
      {
        ok: false,
        error: "reschedule_version_conflict",
        currentVersion: result.currentVersion,
      },
      { status: 409 },
    );
  }
  if (result.kind === "source_status_conflict") {
    return NextResponse.json(
      {
        ok: false,
        error: "reschedule_status_conflict",
        currentStatus: result.status,
        currentVersion: result.currentVersion,
      },
      { status: 409 },
    );
  }
  if (result.kind === "slot_full") {
    return NextResponse.json(
      { ok: false, error: "slot_full" },
      { status: 409 },
    );
  }
  if (result.kind === "cutoff_elapsed") {
    return NextResponse.json(
      { ok: false, error: "partner_cutoff_next_business_day" },
      { status: 422 },
    );
  }
  if (result.kind === "rate_not_configured") {
    return NextResponse.json(
      { ok: false, error: "rate_not_configured" },
      { status: 422 },
    );
  }
  if (result.kind === "partner_unavailable") {
    return NextResponse.json(
      { ok: false, error: "partner_unavailable" },
      { status: 401 },
    );
  }
  if (result.kind === "create_failed") {
    return NextResponse.json(
      { ok: false, error: "create_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    appointmentId: result.appointment.appointmentId,
    startAt: result.appointment.startAt
      ? result.appointment.startAt.toISOString()
      : null,
    status: result.appointment.status,
    version: result.appointment.version,
    rescheduledFromAppointmentId: result.rescheduledFromAppointmentId ?? null,
    rescheduledFromVersion: result.rescheduledFromVersion ?? null,
    receipt: {
      operationId: result.appointment.bookingId,
      correlationId: result.correlationId,
      auditEventId: result.auditEventId,
      replay: result.replay,
      committedAt: result.appointment.committedAt.toISOString(),
    },
  });
}
