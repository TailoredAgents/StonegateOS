import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, appointments, leads, outboxEvents } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { deleteCalendarEvent } from "@/lib/calendar";

const StatusSchema = z.object({
  status: z.enum(["requested", "confirmed", "completed", "no_show", "canceled"]),
  crew: z.string().optional().nullable(),
  owner: z.string().optional().nullable()
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const { id: appointmentId } = await context.params;
  if (!appointmentId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = StatusSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const db = getDb();
  const status = parsed.data.status;
  const crew = parsed.data.crew;
  const owner = parsed.data.owner;

  const [updated] = await db
    .update(appointments)
    .set({
      status,
      ...(crew !== undefined ? { crew: crew ?? null } : {}),
      ...(owner !== undefined ? { owner: owner ?? null } : {}),
      updatedAt: new Date()
    })
    .where(eq(appointments.id, appointmentId))
    .returning({
      id: appointments.id,
      leadId: appointments.leadId,
      calendarEventId: appointments.calendarEventId
    });

  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (updated.calendarEventId && status === "canceled") {
    await deleteCalendarEvent(updated.calendarEventId);
    await db
      .update(appointments)
      .set({ calendarEventId: null })
      .where(eq(appointments.id, updated.id));
  }

  if (updated.leadId && status === "confirmed") {
    await db.update(leads).set({ status: "scheduled" }).where(eq(leads.id, updated.leadId));
  }

  await db.insert(outboxEvents).values({
    type: "estimate.status_changed",
    payload: {
      appointmentId: updated.id,
      leadId: updated.leadId,
      status
    }
  });

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "appointment.status.updated",
    entityType: "appointment",
    entityId: updated.id,
    meta: {
      status,
      leadId: updated.leadId ?? null
    }
  });

  return NextResponse.json({ ok: true, appointmentId: updated.id, status });
}
