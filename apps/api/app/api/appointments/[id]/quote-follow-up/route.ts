import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { and, eq, ilike, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { appointments, contacts, crmTasks, getDb, outboxEvents } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { getBusinessHoursPolicy } from "@/lib/policy";
import {
  buildQuoteFollowUpNotes,
  extractQuoteFollowUpAppointmentId,
  QUOTE_FOLLOW_UP_TITLE,
} from "@/lib/quote-followups";
import { getDefaultSalesAssigneeMemberId } from "@/lib/sales-scorecard";
import { isAdminRequest } from "../../../web/admin";

const QuoteFollowUpSchema = z.object({
  dueAt: z.string().min(1),
  note: z.string().trim().max(1000).nullable().optional(),
});

function parseDueAt(value: string, timezone: string): Date | null {
  const trimmed = value.trim();
  const hasTimezone = /[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed);
  const dt = hasTimezone
    ? DateTime.fromISO(trimmed, { setZone: true })
    : DateTime.fromISO(trimmed, { zone: timezone });
  if (!dt.isValid) return null;
  return dt.toUTC().toJSDate();
}

function isQuoteOnlyType(value: string | null | undefined): boolean {
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
  const parsed = QuoteFollowUpSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();
  const businessHours = await getBusinessHoursPolicy(db);
  const timezone =
    businessHours.timezone ||
    process.env["APPOINTMENT_TIMEZONE"] ||
    "America/New_York";
  const dueAt = parseDueAt(parsed.data.dueAt, timezone);
  if (!dueAt) {
    return NextResponse.json({ error: "invalid_due_at" }, { status: 400 });
  }

  const [appointment] = await db
    .select({
      id: appointments.id,
      type: appointments.type,
      status: appointments.status,
      leadId: appointments.leadId,
      contactId: appointments.contactId,
      contactSalespersonMemberId: contacts.salespersonMemberId,
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!appointment) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (!isQuoteOnlyType(appointment.type)) {
    return NextResponse.json(
      { error: "appointment_is_not_an_in_person_quote" },
      { status: 400 },
    );
  }

  if (
    appointment.status === "completed" ||
    appointment.status === "canceled" ||
    appointment.status === "no_show"
  ) {
    return NextResponse.json(
      { error: "appointment_is_not_follow_up_eligible" },
      { status: 400 },
    );
  }

  if (!appointment.contactId) {
    return NextResponse.json(
      { error: "appointment_contact_missing" },
      { status: 400 },
    );
  }

  const actor = getAuditActorFromRequest(request);
  const now = new Date();
  const assignedTo =
    appointment.contactSalespersonMemberId?.trim() ||
    (await getDefaultSalesAssigneeMemberId(db as any)) ||
    null;
  const notes = buildQuoteFollowUpNotes({
    contactId: appointment.contactId,
    leadId: appointment.leadId,
    appointmentId,
    comment: parsed.data.note ?? null,
  });

  const [createdTask] = await db.transaction(async (tx) => {
    const existingRows = await tx
      .select({
        id: crmTasks.id,
        notes: crmTasks.notes,
      })
      .from(crmTasks)
      .where(
        and(
          eq(crmTasks.contactId, appointment.contactId!),
          eq(crmTasks.status, "open"),
          isNotNull(crmTasks.notes),
          ilike(crmTasks.notes, "%kind=quote_follow_up%"),
        ),
      );

    const existingIds = existingRows
      .filter(
        (row) => extractQuoteFollowUpAppointmentId(row.notes) === appointmentId,
      )
      .map((row) => row.id);

    if (existingIds.length > 0) {
      await tx
        .update(crmTasks)
        .set({ status: "completed", updatedAt: now })
        .where(inArray(crmTasks.id, existingIds));
    }

    const [task] = await tx
      .insert(crmTasks)
      .values({
        contactId: appointment.contactId!,
        title: QUOTE_FOLLOW_UP_TITLE,
        dueAt,
        assignedTo,
        notes,
        status: "open",
      })
      .returning({
        id: crmTasks.id,
        contactId: crmTasks.contactId,
        title: crmTasks.title,
        dueAt: crmTasks.dueAt,
        assignedTo: crmTasks.assignedTo,
        status: crmTasks.status,
        notes: crmTasks.notes,
        createdAt: crmTasks.createdAt,
        updatedAt: crmTasks.updatedAt,
      });

    if (!task) {
      return [null] as const;
    }

    await tx.insert(outboxEvents).values({
      type: "crm.reminder.sms",
      payload: { taskId: task.id },
      nextAttemptAt: dueAt,
    });

    return [task] as const;
  });

  if (!createdTask) {
    return NextResponse.json(
      { error: "quote_follow_up_create_failed" },
      { status: 500 },
    );
  }

  await recordAuditEvent({
    actor,
    action: "appointment.quote_follow_up.scheduled",
    entityType: "appointment",
    entityId: appointmentId,
    meta: {
      taskId: createdTask.id,
      dueAt: createdTask.dueAt ? createdTask.dueAt.toISOString() : null,
      assignedTo: createdTask.assignedTo ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    reminder: {
      id: createdTask.id,
      title: createdTask.title,
      dueAt: createdTask.dueAt ? createdTask.dueAt.toISOString() : null,
      assignedTo: createdTask.assignedTo ?? null,
      notes: createdTask.notes ?? null,
      createdAt: createdTask.createdAt.toISOString(),
      updatedAt: createdTask.updatedAt.toISOString(),
    },
  });
}
