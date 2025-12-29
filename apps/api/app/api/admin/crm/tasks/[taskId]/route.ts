import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, crmTasks } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../../web/admin";
import { eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ taskId?: string }>;
};

const VALID_STATUSES = new Set(["open", "completed"]);

export async function PATCH(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { taskId } = await context.params;
  if (!taskId) {
    return NextResponse.json({ error: "task_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const { title, dueAt, assignedTo, status, notes } = payload as Record<string, unknown>;

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (title !== undefined) {
    if (typeof title === "string" && title.trim().length > 0) {
      updates["title"] = title.trim();
    } else {
      return NextResponse.json({ error: "title_required" }, { status: 400 });
    }
  }

  if (dueAt !== undefined) {
    if (dueAt === null || (typeof dueAt === "string" && dueAt.trim().length === 0)) {
      updates["dueAt"] = null;
    } else if (typeof dueAt === "string") {
      const parsed = new Date(dueAt);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ error: "invalid_due_date" }, { status: 400 });
      }
      updates["dueAt"] = parsed;
    } else {
      return NextResponse.json({ error: "invalid_due_date" }, { status: 400 });
    }
  }

  if (assignedTo !== undefined) {
    if (typeof assignedTo === "string" && assignedTo.trim().length > 0) {
      updates["assignedTo"] = assignedTo.trim();
    } else if (assignedTo === null || (typeof assignedTo === "string" && assignedTo.trim().length === 0)) {
      updates["assignedTo"] = null;
    } else {
      return NextResponse.json({ error: "invalid_assignee" }, { status: 400 });
    }
  }

  if (status !== undefined) {
    if (typeof status === "string" && VALID_STATUSES.has(status.trim().toLowerCase())) {
      updates["status"] = status.trim().toLowerCase();
    } else {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
  }

  if (notes !== undefined) {
    if (typeof notes === "string" && notes.trim().length > 0) {
      updates["notes"] = notes.trim();
    } else if (notes === null || (typeof notes === "string" && notes.trim().length === 0)) {
      updates["notes"] = null;
    } else {
      return NextResponse.json({ error: "invalid_notes" }, { status: 400 });
    }
  }

  if (Object.keys(updates).length === 1) {
    return NextResponse.json({ error: "no_updates_provided" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  const [updated] = await db
    .update(crmTasks)
    .set(updates)
    .where(eq(crmTasks.id, taskId))
    .returning({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      title: crmTasks.title,
      dueAt: crmTasks.dueAt,
      assignedTo: crmTasks.assignedTo,
      status: crmTasks.status,
      notes: crmTasks.notes,
      createdAt: crmTasks.createdAt,
      updatedAt: crmTasks.updatedAt
    });

  if (!updated) {
    return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  }

  const changedFields = Object.keys(updates).filter((key) => key !== "updatedAt");

  await recordAuditEvent({
    actor,
    action: "crm.task.updated",
    entityType: "crm_task",
    entityId: updated.id,
    meta: {
      contactId: updated.contactId,
      fields: changedFields
    }
  });

  return NextResponse.json({
    task: {
      id: updated.id,
      contactId: updated.contactId,
      title: updated.title,
      dueAt: updated.dueAt ? updated.dueAt.toISOString() : null,
      assignedTo: updated.assignedTo,
      status: updated.status,
      notes: updated.notes,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    }
  });
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { taskId } = await context.params;
  if (!taskId) {
    return NextResponse.json({ error: "task_id_required" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const [deleted] = await db
    .delete(crmTasks)
    .where(eq(crmTasks.id, taskId))
    .returning({ id: crmTasks.id });

  if (!deleted) {
    return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor,
    action: "crm.task.deleted",
    entityType: "crm_task",
    entityId: deleted.id
  });

  return NextResponse.json({ deleted: true });
}
