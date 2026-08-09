import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import {
  getDb,
  appointments,
  leads,
  outboxEvents,
  contacts,
  properties,
} from "@/db";
import {
  buildRescheduleUrl,
  DEFAULT_APPOINTMENT_DURATION_MIN,
  DEFAULT_TRAVEL_BUFFER_MIN,
  resolveAppointmentTiming,
  APPOINTMENT_TIME_ZONE,
} from "../../../scheduling";
import type { AppointmentCalendarPayload } from "@/lib/calendar";
import {
  createCalendarEventWithRetry,
  updateCalendarEventWithRetry,
} from "@/lib/calendar-events";
import { isGoogleCalendarEnabled } from "@/lib/calendar";
import {
  AppointmentMediaError,
  assertAppointmentStatusTransitionAllowed,
} from "@/lib/appointment-media";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { resolveEasternAppointmentTime } from "@/lib/appointment-time";
import { getAppointmentCapacity } from "@/lib/appointment-capacity";
import {
  acquireScheduleConflictLock,
  decideScheduleConflictOverride,
  inspectScheduleConflicts,
} from "@/lib/appointment-schedule-conflicts";
import {
  getCalendarMutationCorrelationId,
  insertCalendarMutationSuccessAudit,
} from "@/lib/calendar-mutation-audit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const RescheduleSchema = z
  .object({
    startAt: z.string().datetime().optional(),
    preferredDate: z.string().optional(),
    timeWindow: z.string().optional(),
    startTime: z
      .string()
      .regex(/^\d{1,2}:\d{2}$/)
      .optional(),
    durationMinutes: z
      .number()
      .int()
      .min(15)
      .max(8 * 60)
      .optional(),
    travelBufferMinutes: z
      .number()
      .int()
      .min(0)
      .max(6 * 60)
      .optional(),
    rescheduleToken: z.string().min(8).optional(),
    expectedVersion: z.string().datetime().optional(),
    conflictOverrideReason: z.string().trim().max(500).optional(),
    conflictAcknowledgement: z.string().trim().max(4000).optional(),
    conflictFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  })
  .refine(
    (value) => Boolean(value.startAt) || Boolean(value.preferredDate),
    "Provide either startAt or preferredDate",
  );

function readExpectedVersion(
  request: NextRequest,
  payloadVersion: string | undefined,
): { value: string | null; valid: boolean } {
  let raw =
    request.headers.get("if-match")?.trim() || payloadVersion?.trim() || "";
  if (!raw) return { value: null, valid: true };
  if (raw.startsWith("W/")) raw = raw.slice(2).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  return { value: raw, valid: Number.isFinite(Date.parse(raw)) };
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const isAdmin = isAdminRequest(request);
  if (isAdmin) {
    const denied = await requirePermission(request, "appointments.update");
    if (denied) return denied;
  }

  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = RescheduleSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const conflictOverrideRequested = Boolean(
    input.conflictOverrideReason ||
      input.conflictAcknowledgement ||
      input.conflictFingerprint,
  );
  if (conflictOverrideRequested) {
    if (!isAdmin) {
      return NextResponse.json(
        {
          error: "schedule_conflict_override_forbidden",
          message:
            "Only an authorized team member can override a schedule conflict.",
        },
        { status: 403 },
      );
    }
    const overrideDenied = await requirePermission(
      request,
      "appointments.override_conflicts",
    );
    if (overrideDenied) return overrideDenied;
  }
  const expectedVersion = readExpectedVersion(request, input.expectedVersion);
  if (!expectedVersion.valid) {
    return NextResponse.json(
      {
        error: "invalid_expected_version",
        message: "Refresh the appointment before rescheduling it.",
      },
      { status: 422 },
    );
  }
  const db = getDb();

  const rows = await db
    .select({
      id: appointments.id,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      startAt: appointments.startAt,
      status: appointments.status,
      updatedAt: appointments.updatedAt,
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
      leadServices: leads.servicesRequested,
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
  const existingFormPayload = isRecord(leadFormPayload)
    ? leadFormPayload
    : null;

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
  let requestedDurationMinutes = input.durationMinutes;

  if (input.startAt) {
    const dt = DateTime.fromISO(input.startAt, { zone: "utc" });
    if (!dt.isValid) {
      return NextResponse.json({ error: "invalid_start_at" }, { status: 400 });
    }
    startAt = dt.toJSDate();
  } else if (input.startTime && input.preferredDate) {
    const resolved = resolveEasternAppointmentTime(
      input.preferredDate,
      input.startTime,
    );
    if (!resolved.ok) {
      return NextResponse.json(
        {
          error: resolved.code,
          message: resolved.message,
        },
        { status: 422 },
      );
    }
    startAt = resolved.value;
  } else {
    const timing = resolveAppointmentTiming(
      input.preferredDate ?? null,
      input.timeWindow ?? null,
    );
    startAt = timing.startAt;
    requestedDurationMinutes = input.durationMinutes ?? timing.durationMinutes;
  }

  if (!startAt) {
    return NextResponse.json(
      {
        error: "invalid_start",
        message: "Unable to determine appointment time",
      },
      { status: 400 },
    );
  }

  const travelBufferMinutes =
    input.travelBufferMinutes ??
    existing.travelBufferMinutes ??
    DEFAULT_TRAVEL_BUFFER_MIN;
  const actor = getAuditActorFromRequest(request);
  const correlationId = getCalendarMutationCorrelationId(request);

  const updatedResult = await db
    .transaction(async (tx) => {
      await acquireScheduleConflictLock(tx);
      const [locked] = await tx
        .select({
          updatedAt: appointments.updatedAt,
          startAt: appointments.startAt,
          status: appointments.status,
          durationMinutes: appointments.durationMinutes,
          travelBufferMinutes: appointments.travelBufferMinutes,
        })
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .limit(1)
        .for("update");
      if (!locked) return { kind: "not_found" as const };
      if (
        expectedVersion.value &&
        locked.updatedAt.getTime() !== new Date(expectedVersion.value).getTime()
      ) {
        return {
          kind: "changed" as const,
          currentVersion: locked.updatedAt.toISOString(),
        };
      }

      const effectiveDurationMinutes =
        requestedDurationMinutes ??
        locked.durationMinutes ??
        DEFAULT_APPOINTMENT_DURATION_MIN;
      const effectiveTravelBufferMinutes =
        input.travelBufferMinutes ??
        locked.travelBufferMinutes ??
        DEFAULT_TRAVEL_BUFFER_MIN;
      const scheduleDecision = await inspectScheduleConflicts(tx, {
        startAt,
        durationMinutes: effectiveDurationMinutes,
        capacity: getAppointmentCapacity(),
        excludeAppointmentId: appointmentId,
      });
      const scheduleOverride = decideScheduleConflictOverride(
        scheduleDecision,
        {
          reason: input.conflictOverrideReason,
          acknowledgement: input.conflictAcknowledgement,
          fingerprint: input.conflictFingerprint,
        },
      );
      if (!scheduleOverride.ok) {
        return {
          kind: "schedule_conflict" as const,
          code: scheduleOverride.code,
          message: scheduleOverride.message,
          decision: scheduleDecision,
        };
      }

      await assertAppointmentStatusTransitionAllowed({
        appointmentId,
        nextStatus: "confirmed",
        database: tx,
      });
      const mutationAt = new Date(
        Math.max(Date.now(), locked.updatedAt.getTime() + 1),
      );
      const [updated] = await tx
        .update(appointments)
        .set({
          startAt,
          durationMinutes: effectiveDurationMinutes,
          travelBufferMinutes: effectiveTravelBufferMinutes,
          status: "confirmed",
          updatedAt: mutationAt,
        })
        .where(eq(appointments.id, appointmentId))
        .returning({
          id: appointments.id,
          startAt: appointments.startAt,
          durationMinutes: appointments.durationMinutes,
          travelBufferMinutes: appointments.travelBufferMinutes,
          rescheduleToken: appointments.rescheduleToken,
          calendarEventId: appointments.calendarEventId,
          updatedAt: appointments.updatedAt,
        });

      if (updated && existing.leadId) {
        await tx
          .update(leads)
          .set({ status: "scheduled" })
          .where(eq(leads.id, existing.leadId));
      }
      if (updated) {
        const rescheduleUrl = buildRescheduleUrl(
          updated.id,
          updated.rescheduleToken,
        );
        await tx.insert(outboxEvents).values({
          type: "estimate.rescheduled",
          payload: {
            appointmentId: updated.id,
            leadId: existing.leadId,
            startAt: updated.startAt,
            durationMinutes: updated.durationMinutes,
            travelBufferMinutes: updated.travelBufferMinutes,
            rescheduleUrl,
          },
        });
        await insertCalendarMutationSuccessAudit(tx, {
          actor,
          action: "appointment.rescheduled",
          entityType: "appointment",
          entityId: updated.id,
          requiredPermissions: ["appointments.update"],
          correlationId,
          meta: {
            previousStartAt: locked.startAt?.toISOString() ?? null,
            startAt: updated.startAt?.toISOString() ?? null,
            previousStatus: locked.status,
            status: "confirmed",
            version: updated.updatedAt.toISOString(),
            calendarSync: isGoogleCalendarEnabled()
              ? "pending"
              : "not_required",
            scheduleConflictOverridden: scheduleOverride.overridden,
            scheduleConflictOverrideReason: scheduleOverride.reason,
            scheduleConflictFingerprint: scheduleDecision.fingerprint,
            conflictingIntervals: scheduleDecision.conflicts.map(
              (conflict) => ({
                id: conflict.id,
                startAt: conflict.startAt,
                endAt: conflict.endAt,
              }),
            ),
          },
        });
      }
      return updated
        ? {
            kind: "updated" as const,
            appointment: updated,
            scheduleConflictOverridden: scheduleOverride.overridden,
          }
        : { kind: "not_found" as const };
    })
    .catch((error: unknown) => {
      if (
        error instanceof AppointmentMediaError &&
        error.code === "quoted_scope_required"
      ) {
        return { kind: "quoted_scope_required" as const };
      }
      throw error;
    });

  if (updatedResult.kind === "quoted_scope_required") {
    return NextResponse.json(
      {
        error: "quoted_scope_required",
        message:
          "Add the quoted-to-remove summary before confirming this appointment.",
      },
      { status: 409 },
    );
  }
  if (updatedResult.kind === "schedule_conflict") {
    const exposeDetails = isAdmin;
    return NextResponse.json(
      {
        ok: false,
        error: updatedResult.code,
        code: updatedResult.code,
        message: exposeDetails
          ? updatedResult.message
          : "That time is no longer available. Choose a different appointment time.",
        retryable: false,
        ...(exposeDetails
          ? {
              conflicts: updatedResult.decision.conflicts,
              conflictFingerprint: updatedResult.decision.fingerprint,
              requiredAcknowledgement:
                updatedResult.decision.requiredAcknowledgement,
              capacity: updatedResult.decision.capacity,
            }
          : {}),
      },
      {
        status:
          updatedResult.code === "schedule_conflict_override_reason_required"
            ? 422
            : 409,
      },
    );
  }
  if (updatedResult.kind === "changed") {
    return NextResponse.json(
      {
        error: "appointment_changed",
        message:
          "This appointment changed on another screen. Refresh and review its latest time and status before rescheduling.",
        currentVersion: updatedResult.currentVersion,
      },
      { status: 409 },
    );
  }
  if (updatedResult.kind === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const updated = updatedResult.appointment;

  const rescheduleUrl = buildRescheduleUrl(updated.id, updated.rescheduleToken);
  const services = existing.leadServices ?? [];
  const defaultPreferredDate = updated.startAt
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
      phone: existing.contactPhoneE164 ?? existing.contactPhone ?? undefined,
    },
    property: {
      addressLine1: existing.propertyAddressLine1 ?? "Undisclosed",
      city: existing.propertyCity ?? "",
      state: existing.propertyState ?? "",
      postalCode: existing.propertyPostalCode ?? "",
    },
    ...(rescheduleUrl ? { rescheduleUrl } : {}),
  };

  let calendarSync: "not_required" | "succeeded" | "reconciliation_required" =
    "not_required";
  if (isGoogleCalendarEnabled()) {
    try {
      if (updated.calendarEventId) {
        const updatedEvent = await updateCalendarEventWithRetry(
          updated.calendarEventId,
          calendarPayload,
        );
        if (updatedEvent) {
          calendarSync = "succeeded";
        } else {
          const replacementEventId =
            await createCalendarEventWithRetry(calendarPayload);
          if (replacementEventId) {
            calendarSync = "succeeded";
            await db
              .update(appointments)
              .set({
                calendarEventId: replacementEventId,
                updatedAt: updated.updatedAt,
              })
              .where(eq(appointments.id, updated.id));
          } else {
            calendarSync = "reconciliation_required";
          }
        }
      } else {
        const eventId = await createCalendarEventWithRetry(calendarPayload);
        if (eventId) {
          calendarSync = "succeeded";
          await db
            .update(appointments)
            .set({ calendarEventId: eventId, updatedAt: updated.updatedAt })
            .where(eq(appointments.id, updated.id));
        } else {
          calendarSync = "reconciliation_required";
        }
      }
    } catch {
      calendarSync = "reconciliation_required";
    }
  }

  if (isGoogleCalendarEnabled()) {
    try {
      await recordAuditEvent({
        actor,
        action:
          calendarSync === "succeeded"
            ? "appointment.calendar_sync.succeeded"
            : "appointment.calendar_sync.reconciliation_required",
        entityType: "appointment",
        entityId: updated.id,
        outcome: calendarSync === "succeeded" ? "succeeded" : "failed",
        requiredPermissions: ["appointments.update"],
        correlationId,
        surface: "/team/calendar",
        meta: {
          version: updated.updatedAt.toISOString(),
          calendarSync,
        },
      });
    } catch {
      // The CRM mutation and its transaction-bound audit are durable, but the
      // separate provider result is no longer provable. Surface reconciliation
      // instead of returning either a false clean success or a false rollback.
      calendarSync = "reconciliation_required";
    }
  }

  return NextResponse.json({
    ok: true,
    appointmentId: updated.id,
    startAt: updated.startAt?.toISOString() ?? null,
    durationMinutes: updated.durationMinutes,
    travelBufferMinutes: updated.travelBufferMinutes,
    status: "confirmed",
    rescheduleToken: updated.rescheduleToken,
    preferredDate: input.preferredDate ?? defaultPreferredDate,
    timeWindow: input.timeWindow ?? previousTimeWindow,
    version: updated.updatedAt.toISOString(),
    calendarSync,
    scheduleConflictOverridden: updatedResult.scheduleConflictOverridden,
  });
}
