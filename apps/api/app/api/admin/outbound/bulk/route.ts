import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { crmTasks, getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function upsertField(notes: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`(^|\\n)${key}=[^\\n]*`, "i");
  if (re.test(notes)) {
    return notes.replace(re, `$1${line}`);
  }
  return notes.length ? `${notes}\n${line}` : line;
}

type ActionKind = "assign" | "start" | "assign_start";

function parseAction(value: unknown): ActionKind | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "assign" || key === "start" || key === "assign_start") return key;
  return null;
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

  const action = parseAction((payload as any).action);
  const taskIdsRaw = Array.isArray((payload as any).taskIds) ? (payload as any).taskIds : [];
  const taskIds = taskIdsRaw
    .filter((value: unknown): value is string => typeof value === "string" && isUuid(value.trim()))
    .map((value: string) => value.trim());

  const assignedToRaw = typeof (payload as any).assignedToMemberId === "string" ? (payload as any).assignedToMemberId.trim() : "";
  const assignedToMemberId = assignedToRaw && isUuid(assignedToRaw) ? assignedToRaw : null;

  if (!action) return NextResponse.json({ error: "action_required" }, { status: 400 });
  if (taskIds.length === 0) return NextResponse.json({ error: "task_ids_required" }, { status: 400 });
  if ((action === "assign" || action === "assign_start") && !assignedToMemberId) {
    return NextResponse.json({ error: "assigned_to_required" }, { status: 400 });
  }

  const actor = getAuditActorFromRequest(request);
  const db = getDb();
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: crmTasks.id,
        status: crmTasks.status,
        dueAt: crmTasks.dueAt,
        assignedTo: crmTasks.assignedTo,
        notes: crmTasks.notes
      })
      .from(crmTasks)
      .where(inArray(crmTasks.id, taskIds));

    let updated = 0;
    let skipped = 0;
    let started = 0;
    let assigned = 0;

    for (const row of rows) {
      const notes = typeof row.notes === "string" ? row.notes : "";
      if (row.status !== "open" || !notes.toLowerCase().includes("kind=outbound")) {
        skipped += 1;
        continue;
      }

      const patch: Partial<typeof crmTasks.$inferInsert> = {};
      let nextNotes = notes;

      if (action === "assign" || action === "assign_start") {
        if (assignedToMemberId && row.assignedTo !== assignedToMemberId) {
          patch.assignedTo = assignedToMemberId;
          assigned += 1;
        }
      }

      if (action === "start" || action === "assign_start") {
        if (!(row.dueAt instanceof Date)) {
          patch.dueAt = now;
          nextNotes = upsertField(nextNotes, "startedAt", now.toISOString());
          started += 1;
        }
      }

      if (Object.keys(patch).length === 0 && nextNotes === notes) {
        skipped += 1;
        continue;
      }

      if (nextNotes !== notes) {
        patch.notes = nextNotes;
      }
      patch.updatedAt = now;

      await tx.update(crmTasks).set(patch).where(eq(crmTasks.id, row.id));
      updated += 1;
    }

    return { updated, skipped, started, assigned };
  });

  await recordAuditEvent({
    actor,
    action: "outbound.bulk_updated",
    entityType: "crm_task",
    entityId: "bulk",
    meta: {
      action,
      taskCount: taskIds.length,
      assignedToMemberId: assignedToMemberId ?? null,
      ...result
    }
  });

  return NextResponse.json({ ok: true, action, taskCount: taskIds.length, assignedToMemberId, ...result });
}

