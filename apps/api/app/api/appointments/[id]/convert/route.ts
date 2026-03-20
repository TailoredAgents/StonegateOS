import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { z } from "zod";
import { and, eq, ilike, inArray, isNotNull } from "drizzle-orm";
import {
  appointments,
  contacts,
  crmPipeline,
  crmTasks,
  getDb,
  leads,
  outboxEvents,
  properties,
} from "@/db";
import {
  parseAppointmentBookingDetails,
  validateQuotedTotalForBookingDetails,
} from "@/lib/appointment-booking-details";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import type { AppointmentCalendarPayload } from "@/lib/calendar";
import {
  createCalendarEventWithRetry,
  updateCalendarEventWithRetry,
} from "@/lib/calendar-events";
import { requirePermission } from "@/lib/permissions";
import { getBusinessHoursPolicy } from "@/lib/policy";
import { extractQuoteFollowUpAppointmentId } from "@/lib/quote-followups";
import { isAdminRequest } from "../../../web/admin";
import { buildRescheduleUrl } from "../../../web/scheduling";

const ConvertSchema = z.object({
  startAt: z.string().min(1),
  soldByMemberId: z.string().uuid(),
  quotedTotalCents: z.number().int().nonnegative().nullable(),
  bookingDetails: z.unknown(),
});

function parseStartAt(value: string, timezone: string): Date | null {
  const trimmed = value.trim();
  const hasTimezone = /[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed);
  const dt = hasTimezone
    ? DateTime.fromISO(trimmed, { setZone: true })
    : DateTime.fromISO(trimmed, { zone: timezone });
  if (!dt.isValid) return null;
  return dt.toUTC().toJSDate();
}

function isConvertibleQuoteType(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized === "in_person_quote" || normalized === "in_person_estimate"
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(
    request,
    "appointments.update",
  );
  if (permissionError) return permissionError;

  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = ConvertSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const bookingDetails = parseAppointmentBookingDetails(
    parsed.data.bookingDetails,
  );
  if (!bookingDetails) {
    return NextResponse.json(
      { error: "invalid_booking_details" },
      { status: 400 },
    );
  }

  const quotedTotalError = validateQuotedTotalForBookingDetails(
    bookingDetails,
    parsed.data.quotedTotalCents,
  );
  if (quotedTotalError) {
    return NextResponse.json({ error: quotedTotalError }, { status: 400 });
  }

  const db = getDb();
  const businessHours = await getBusinessHoursPolicy(db);
  const timezone =
    businessHours.timezone ||
    process.env["APPOINTMENT_TIMEZONE"] ||
    "America/New_York";
  const startAt = parseStartAt(parsed.data.startAt, timezone);
  if (!startAt) {
    return NextResponse.json({ error: "invalid_start_at" }, { status: 400 });
  }

  const [existing] = await db
    .select({
      id: appointments.id,
      type: appointments.type,
      status: appointments.status,
      leadId: appointments.leadId,
      contactId: appointments.contactId,
      calendarEventId: appointments.calendarEventId,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      rescheduleToken: appointments.rescheduleToken,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
      leadNotes: leads.notes,
      leadServices: leads.servicesRequested,
      pipelineStage: crmPipeline.stage,
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .leftJoin(leads, eq(appointments.leadId, leads.id))
    .leftJoin(crmPipeline, eq(crmPipeline.contactId, appointments.contactId))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (!isConvertibleQuoteType(existing.type)) {
    return NextResponse.json(
      { error: "appointment_is_not_an_in_person_quote" },
      { status: 400 },
    );
  }

  if (
    existing.status === "completed" ||
    existing.status === "canceled" ||
    existing.status === "no_show"
  ) {
    return NextResponse.json(
      { error: "appointment_is_not_convertible" },
      { status: 400 },
    );
  }

  const now = new Date();
  const actor = getAuditActorFromRequest(request);

  const updated = await db.transaction(async (tx) => {
    const [appointment] = await tx
      .update(appointments)
      .set({
        type: "job",
        startAt,
        status: "confirmed",
        soldByMemberId: parsed.data.soldByMemberId,
        quotedTotalCents: parsed.data.quotedTotalCents,
        bookingDetails,
        updatedAt: now,
      })
      .where(eq(appointments.id, appointmentId))
      .returning({
        id: appointments.id,
        startAt: appointments.startAt,
        durationMinutes: appointments.durationMinutes,
        travelBufferMinutes: appointments.travelBufferMinutes,
        calendarEventId: appointments.calendarEventId,
      });

    if (!appointment) {
      return null;
    }

    if (
      existing.contactId &&
      existing.pipelineStage !== "won" &&
      existing.pipelineStage !== "lost" &&
      existing.pipelineStage !== "qualified"
    ) {
      await tx
        .insert(crmPipeline)
        .values({
          contactId: existing.contactId,
          stage: "qualified",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: crmPipeline.contactId,
          set: { stage: "qualified", updatedAt: now },
        });

      await tx.insert(outboxEvents).values({
        type: "pipeline.auto_stage_change",
        payload: {
          contactId: existing.contactId,
          fromStage: existing.pipelineStage,
          toStage: "qualified",
          reason: "appointment.converted",
          meta: {
            appointmentId,
            fromType: existing.type,
            toType: "job",
          },
        },
      });
    }

    if (existing.contactId) {
      const openQuoteFollowUps = await tx
        .select({
          id: crmTasks.id,
          notes: crmTasks.notes,
        })
        .from(crmTasks)
        .where(
          and(
            eq(crmTasks.contactId, existing.contactId),
            eq(crmTasks.status, "open"),
            isNotNull(crmTasks.notes),
            ilike(crmTasks.notes, "%kind=quote_follow_up%"),
          ),
        );

      const matchingTaskIds = openQuoteFollowUps
        .filter(
          (task) =>
            extractQuoteFollowUpAppointmentId(task.notes) === appointmentId,
        )
        .map((task) => task.id);

      if (matchingTaskIds.length > 0) {
        await tx
          .update(crmTasks)
          .set({ status: "completed", updatedAt: now })
          .where(inArray(crmTasks.id, matchingTaskIds));
      }
    }

    return appointment;
  });

  if (!updated) {
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  if (existing.leadId) {
    await db
      .update(leads)
      .set({ status: "scheduled" })
      .where(eq(leads.id, existing.leadId));
  }

  const calendarPayload: AppointmentCalendarPayload = {
    appointmentId: updated.id,
    startAt: updated.startAt,
    durationMinutes: updated.durationMinutes,
    travelBufferMinutes:
      updated.travelBufferMinutes ?? existing.travelBufferMinutes ?? 30,
    services: existing.leadServices ?? [],
    notes: typeof existing.leadNotes === "string" ? existing.leadNotes : null,
    contact: {
      name: `${existing.contactFirstName ?? "Stonegate"} ${existing.contactLastName ?? "Customer"}`,
      email: existing.contactEmail,
      phone: existing.contactPhoneE164 ?? existing.contactPhone ?? undefined,
    },
    property: {
      addressLine1: existing.propertyAddressLine1 ?? "Undisclosed",
      city: existing.propertyCity ?? "",
      state: existing.propertyState ?? "",
      postalCode: existing.propertyPostalCode ?? "",
    },
    ...(existing.rescheduleToken
      ? {
          rescheduleUrl:
            buildRescheduleUrl(updated.id, existing.rescheduleToken) ??
            undefined,
        }
      : {}),
  };

  if (updated.calendarEventId) {
    const calendarUpdated = await updateCalendarEventWithRetry(
      updated.calendarEventId,
      calendarPayload,
    );
    if (!calendarUpdated) {
      const replacementEventId =
        await createCalendarEventWithRetry(calendarPayload);
      if (replacementEventId) {
        await db
          .update(appointments)
          .set({ calendarEventId: replacementEventId, updatedAt: new Date() })
          .where(eq(appointments.id, updated.id));
      }
    }
  } else {
    const eventId = await createCalendarEventWithRetry(calendarPayload);
    if (eventId) {
      await db
        .update(appointments)
        .set({ calendarEventId: eventId, updatedAt: new Date() })
        .where(eq(appointments.id, updated.id));
    }
  }

  await recordAuditEvent({
    actor,
    action: "appointment.converted",
    entityType: "appointment",
    entityId: updated.id,
    meta: {
      fromType: existing.type,
      toType: "job",
      startAt: startAt.toISOString(),
      quotedTotalCents: parsed.data.quotedTotalCents,
      soldByMemberId: parsed.data.soldByMemberId,
      bookingDetails,
    },
  });

  return NextResponse.json({
    ok: true,
    appointmentId: updated.id,
    appointmentType: "job",
    startAt: updated.startAt?.toISOString() ?? null,
    status: "confirmed",
  });
}
