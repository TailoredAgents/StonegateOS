import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, appointmentCrewMembers, appointments, leads, outboxEvents } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { deleteCalendarEvent } from "@/lib/calendar";
import { recalculateAppointmentCommissions } from "@/lib/commissions";

const StatusSchema = z.object({
  status: z.enum(["requested", "confirmed", "completed", "no_show", "canceled"]),
  crew: z.string().optional().nullable(),
  owner: z.string().optional().nullable(),
  soldByMemberId: z.string().uuid().optional().nullable(),
  marketingMemberId: z.string().uuid().optional().nullable(),
  finalTotalCents: z.number().int().nonnegative().optional(),
  finalTotalSameAsQuoted: z.boolean().optional(),
  crewMembers: z
    .array(
      z.object({
        memberId: z.string().uuid(),
        splitBps: z.number().int().min(0).max(10000)
      })
    )
    .optional()
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
  const soldByMemberId = parsed.data.soldByMemberId;
  const marketingMemberId = parsed.data.marketingMemberId;
  const finalTotalCentsInput = parsed.data.finalTotalCents;
  const finalTotalSameAsQuoted = parsed.data.finalTotalSameAsQuoted === true;
  const crewMembers = parsed.data.crewMembers;

  const [existing] = await db
    .select({
      id: appointments.id,
      leadId: appointments.leadId,
      calendarEventId: appointments.calendarEventId,
      quotedTotalCents: appointments.quotedTotalCents,
      finalTotalCents: appointments.finalTotalCents,
      completedAt: appointments.completedAt,
      status: appointments.status
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let finalTotalCentsToSet: number | null | undefined = undefined;
  if (status === "completed") {
    if (typeof finalTotalCentsInput === "number") {
      finalTotalCentsToSet = finalTotalCentsInput;
    } else if (finalTotalSameAsQuoted) {
      finalTotalCentsToSet = existing.quotedTotalCents ?? null;
    }
  }

  const becameCompleted = existing.status !== "completed" && status === "completed";
  const leavingCompleted = existing.status === "completed" && status !== "completed";

  const completedAtToSet =
    leavingCompleted ? null : becameCompleted ? new Date() : existing.completedAt ?? undefined;

  const needsRecalc =
    status === "completed" &&
    (becameCompleted ||
      finalTotalCentsToSet !== undefined ||
      soldByMemberId !== undefined ||
      marketingMemberId !== undefined ||
      crewMembers !== undefined);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(appointments)
      .set({
        status,
        ...(crew !== undefined ? { crew: crew ?? null } : {}),
        ...(owner !== undefined ? { owner: owner ?? null } : {}),
        ...(soldByMemberId !== undefined ? { soldByMemberId: soldByMemberId ?? null } : {}),
        ...(marketingMemberId !== undefined ? { marketingMemberId: marketingMemberId ?? null } : {}),
        ...(finalTotalCentsToSet !== undefined ? { finalTotalCents: finalTotalCentsToSet } : {}),
        ...(completedAtToSet !== undefined ? { completedAt: completedAtToSet } : {}),
        updatedAt: new Date()
      })
      .where(eq(appointments.id, appointmentId))
      .returning({
        id: appointments.id,
        leadId: appointments.leadId,
        calendarEventId: appointments.calendarEventId
      });

    if (!row) {
      return null;
    }

    if (crewMembers !== undefined) {
      await tx.delete(appointmentCrewMembers).where(eq(appointmentCrewMembers.appointmentId, appointmentId));
      if (crewMembers.length > 0) {
        await tx.insert(appointmentCrewMembers).values(
          crewMembers.map((entry) => ({
            appointmentId,
            memberId: entry.memberId,
            splitBps: entry.splitBps,
            createdAt: new Date()
          }))
        );
      }
    }

    return row;
  });

  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (needsRecalc || leavingCompleted) {
    await recalculateAppointmentCommissions(db, appointmentId);
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
      leadId: updated.leadId ?? null,
      ...(finalTotalCentsToSet !== undefined ? { finalTotalCents: finalTotalCentsToSet } : {}),
      ...(soldByMemberId !== undefined ? { soldByMemberId } : {}),
      ...(marketingMemberId !== undefined ? { marketingMemberId } : {}),
      ...(crewMembers !== undefined ? { crewMembersCount: crewMembers.length } : {})
    }
  });

  return NextResponse.json({ ok: true, appointmentId: updated.id, status });
}
