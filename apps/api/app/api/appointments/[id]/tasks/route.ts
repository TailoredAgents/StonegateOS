import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, appointments, appointmentTasks } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const TaskSchema = z.object({
  title: z.string().min(1),
  status: z.enum(["open", "done"]).optional()
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
  const parsed = TaskSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const db = getDb();
  const appt = await db.select({ id: appointments.id }).from(appointments).where(eq(appointments.id, appointmentId)).limit(1);
  if (!appt.length) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [inserted] = await db
    .insert(appointmentTasks)
    .values({
      appointmentId,
      title: parsed.data.title,
      status: parsed.data.status ?? "open"
    })
    .returning();

  if (!inserted) {
    return NextResponse.json({ error: "task_insert_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "appointment.task.created",
    entityType: "appointment_task",
    entityId: inserted.id,
    meta: { appointmentId, status: inserted.status }
  });

  return NextResponse.json({
    ok: true,
    task: {
      id: inserted.id,
      title: inserted.title,
      status: inserted.status,
      createdAt: inserted.createdAt.toISOString()
    }
  });
}

export async function PATCH(
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

  const payload = (await request.json().catch(() => null)) as { taskId?: string; status?: string };
  const { taskId, status } = payload;
  if (!taskId || (status !== "open" && status !== "done")) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const db = getDb();
  const [updated] = await db
    .update(appointmentTasks)
    .set({ status, updatedAt: new Date() })
    .where(eq(appointmentTasks.id, taskId))
    .returning({ id: appointmentTasks.id, status: appointmentTasks.status });

  if (!updated) {
    return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "appointment.task.updated",
    entityType: "appointment_task",
    entityId: updated.id,
    meta: { appointmentId, status: updated.status }
  });

  return NextResponse.json({ ok: true, taskId: updated.id, status: updated.status });
}
