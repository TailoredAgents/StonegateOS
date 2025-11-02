import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { getDb, appointments, leads, outboxEvents, contacts, properties } from "@/db";
import {
  buildRescheduleUrl,
  DEFAULT_APPOINTMENT_DURATION_MIN,
  DEFAULT_TRAVEL_BUFFER_MIN,
  resolveAppointmentTiming,
  APPOINTMENT_TIME_ZONE
} from "../../../scheduling";
import type { AppointmentCalendarPayload } from "@/lib/calendar";
import { createCalendarEventWithRetry, updateCalendarEventWithRetry } from "@/lib/calendar-events";
import { isAdminRequest } from "../../../admin";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const RescheduleSchema = z
  .object({
    startAt: z.string().datetime().optional(),
    preferredDate: z.string().optional(),
    timeWindow: z.string().optional(),
    durationMinutes: z.number().int().min(15).max(8 * 60).optional(),
    travelBufferMinutes: z.number().int().min(0).max(6 * 60).optional(),
    rescheduleToken: z.string().min(8).optional()
  })
  .refine(
    (value) => Boolean(value.startAt) || Boolean(value.preferredDate),
    "Provide either startAt or preferredDate"
  );

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = RescheduleSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const input = parsed.data;
  const db = getDb();
  const isAdmin = isAdminRequest(request);

  const rows = await db
    .select({
      id: appointments.id,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      rescheduleToken: appointments.rescheduleToken,
      calendarEventId: appointments.calendarEventId,
      leadId: appointments.leadId,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
      leadFormPayload: leads.formPayload,
      leadNotes: leads.notes,
      leadServices: leads.servicesRequested
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .leftJoin(leads, eq(appointments.leadId, leads.id))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  const existing = rows[0];

  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const leadFormPayload = existing.leadFormPayload;
  const existingFormPayload = isRecord(leadFormPayload) ? leadFormPayload : null;

  let previousTimeWindow: string | null = null;
  if (existingFormPayload) {
    const schedulingData = existingFormPayload["scheduling"];
    if (isRecord(schedulingData)) {
      const timeWindowValue = schedulingData["timeWindow"];
      if (typeof timeWindowValue === "string") {
        previousTimeWindow = timeWindowValue;
      }
    }
  }

  if (!isAdmin) {
    if (!input.rescheduleToken) {
      return NextResponse.json({ error: "token_required" }, { status: 403 });
    }
    if (input.rescheduleToken !== existing.rescheduleToken) {
      return NextResponse.json({ error: "invalid_token" }, { status: 403 });
    }
  }

  let startAt: Date | null = null;
  let durationMinutes =
    input.durationMinutes ?? existing.durationMinutes ?? DEFAULT_APPOINTMENT_DURATION_MIN;

  if (input.startAt) {
    const dt = DateTime.fromISO(input.startAt, { zone: "utc" });
    if (!dt.isValid) {
      return NextResponse.json({ error: "invalid_start_at" }, { status: 400 });
    }
    startAt = dt.toJSDate();
  } else {
    const timing = resolveAppointmentTiming(input.preferredDate ?? null, input.timeWindow ?? null);
    startAt = timing.startAt;
    durationMinutes = input.durationMinutes ?? timing.durationMinutes;
  }

  if (!startAt) {
    return NextResponse.json(
      { error: "invalid_start", message: "Unable to determine appointment time" },
      { status: 400 }
    );
  }

  const travelBufferMinutes =
    input.travelBufferMinutes ?? existing.travelBufferMinutes ?? DEFAULT_TRAVEL_BUFFER_MIN;

  const [updated] = await db
    .update(appointments)
    .set({
      startAt,
      durationMinutes,
      travelBufferMinutes,
      status: "confirmed",
      updatedAt: new Date()
    })
    .where(eq(appointments.id, appointmentId))
    .returning({
      id: appointments.id,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      rescheduleToken: appointments.rescheduleToken,
      calendarEventId: appointments.calendarEventId
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

  const rescheduleUrl = buildRescheduleUrl(updated.id, updated.rescheduleToken);
  const services = existing.leadServices ?? [];
  const defaultPreferredDate =
      updated.startAt
          ? DateTime.fromJSDate(updated.startAt, { zone: "utc" })
                  .setZone(APPOINTMENT_TIME_ZONE)
                  .toISODate()
          : null;

  const calendarPayload: AppointmentCalendarPayload = {
    appointmentId: updated.id,
    startAt: updated.startAt,
    durationMinutes: updated.durationMinutes,
    travelBufferMinutes: updated.travelBufferMinutes ?? travelBufferMinutes,
    services,
    notes: typeof existing.leadNotes === "string" ? existing.leadNotes : null,
    contact: {
      name: `${existing.contactFirstName ?? "Stonegate"} ${existing.contactLastName ?? "Customer"}`,
      email: existing.contactEmail,
      phone: existing.contactPhoneE164 ?? existing.contactPhone ?? undefined
    },
    property: {
      addressLine1: existing.propertyAddressLine1 ?? "Undisclosed",
      city: existing.propertyCity ?? "",
      state: existing.propertyState ?? "",
      postalCode: existing.propertyPostalCode ?? ""
    },
    rescheduleUrl
  };

  if (updated.calendarEventId) {
    const updatedEvent = await updateCalendarEventWithRetry(updated.calendarEventId, calendarPayload);
    if (!updatedEvent) {
      const replacementEventId = await createCalendarEventWithRetry(calendarPayload);
      if (replacementEventId) {
        await db
          .update(appointments)
          .set({ calendarEventId: replacementEventId })
          .where(eq(appointments.id, updated.id));
      }
    }
  } else {
    const eventId = await createCalendarEventWithRetry(calendarPayload);
    if (eventId) {
      await db
        .update(appointments)
        .set({ calendarEventId: eventId })
        .where(eq(appointments.id, updated.id));
    }
  }

  await db.insert(outboxEvents).values({
    type: "estimate.rescheduled",
    payload: {
      appointmentId: updated.id,
      leadId: existing.leadId,
      startAt: updated.startAt,
      durationMinutes: updated.durationMinutes,
      travelBufferMinutes: updated.travelBufferMinutes,
      rescheduleUrl
    }
  });

  return NextResponse.json({
    ok: true,
    appointmentId: updated.id,
    startAt: updated.startAt?.toISOString() ?? null,
    durationMinutes: updated.durationMinutes,
    travelBufferMinutes: updated.travelBufferMinutes,
    status: "confirmed",
    rescheduleToken: updated.rescheduleToken,
    preferredDate: input.preferredDate ?? defaultPreferredDate,
    timeWindow: input.timeWindow ?? previousTimeWindow
  });
}
