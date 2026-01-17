import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { crmTasks, getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

function upsertField(notes: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`(^|\\n)${key}=[^\\n]*`, "i");
  if (re.test(notes)) {
    return notes.replace(re, `$1${line}`);
  }
  return notes.length ? `${notes}\n${line}` : line;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const taskId = typeof (payload as any).taskId === "string" ? (payload as any).taskId.trim() : "";
  if (!taskId) return NextResponse.json({ error: "task_id_required" }, { status: 400 });

  const actor = getAuditActorFromRequest(request);
  const db = getDb();
  const now = new Date();

  const [task] = await db
    .select({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      status: crmTasks.status,
      dueAt: crmTasks.dueAt,
      notes: crmTasks.notes
    })
    .from(crmTasks)
    .where(eq(crmTasks.id, taskId))
    .limit(1);

  if (!task?.id) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  if (!task.contactId) return NextResponse.json({ error: "contact_not_found" }, { status: 400 });
  if (task.status !== "open") return NextResponse.json({ error: "task_not_open" }, { status: 400 });

  const notes = typeof task.notes === "string" ? task.notes : "";
  if (!notes.toLowerCase().includes("kind=outbound")) {
    return NextResponse.json({ error: "not_outbound_task" }, { status: 400 });
  }

  if (task.dueAt instanceof Date) {
    return NextResponse.json({ ok: true, taskId, contactId: task.contactId, alreadyStarted: true });
  }

  const nextNotes = upsertField(notes, "startedAt", now.toISOString());

  await db
    .update(crmTasks)
    .set({ dueAt: now, notes: nextNotes, updatedAt: now })
    .where(and(eq(crmTasks.id, taskId), eq(crmTasks.status, "open")));

  await recordAuditEvent({
    actor,
    action: "outbound.started",
    entityType: "crm_task",
    entityId: taskId,
    meta: { contactId: task.contactId }
  });

  return NextResponse.json({ ok: true, taskId, contactId: task.contactId, dueAt: now.toISOString() });
}

