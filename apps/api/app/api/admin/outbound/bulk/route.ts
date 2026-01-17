import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { crmTasks, getDb, outboxEvents } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";

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

function hasStartedAt(notes: string): boolean {
  return /(^|\n)startedAt=/.test(notes);
}

type ActionKind = "assign" | "start" | "assign_start" | "snooze";

function parseAction(value: unknown): ActionKind | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "assign" || key === "start" || key === "assign_start" || key === "snooze") return key;
  return null;
}

type SnoozePreset = "today_5pm" | "tomorrow_9am" | "plus_3d_9am" | "next_monday_9am" | "plus_7d_9am";

function parseSnoozePreset(value: unknown): SnoozePreset | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "today_5pm" || key === "tomorrow_9am" || key === "plus_3d_9am" || key === "next_monday_9am" || key === "plus_7d_9am") {
    return key;
  }
  return null;
}

function computeSnoozeDueAt(input: { preset: SnoozePreset; now: Date; timezone: string }): Date {
  const zone = input.timezone || "America/New_York";
  const nowLocal = DateTime.fromJSDate(input.now, { zone });

  const atTime = (dt: DateTime, hour: number) => dt.set({ hour, minute: 0, second: 0, millisecond: 0 });

  switch (input.preset) {
    case "today_5pm": {
      let candidate = atTime(nowLocal, 17);
      if (candidate <= nowLocal) {
        candidate = atTime(nowLocal.plus({ days: 1 }), 17);
      }
      return candidate.toUTC().toJSDate();
    }
    case "tomorrow_9am": {
      const candidate = atTime(nowLocal.plus({ days: 1 }), 9);
      return candidate.toUTC().toJSDate();
    }
    case "plus_3d_9am": {
      const candidate = atTime(nowLocal.plus({ days: 3 }), 9);
      return candidate.toUTC().toJSDate();
    }
    case "plus_7d_9am": {
      const candidate = atTime(nowLocal.plus({ days: 7 }), 9);
      return candidate.toUTC().toJSDate();
    }
    case "next_monday_9am": {
      // Luxon weekday: 1=Mon ... 7=Sun
      const daysUntil = ((8 - nowLocal.weekday) % 7) || 7;
      let candidate = atTime(nowLocal.plus({ days: daysUntil }), 9);
      if (candidate <= nowLocal) {
        candidate = candidate.plus({ days: 7 });
      }
      return candidate.toUTC().toJSDate();
    }
  }
}

async function ensureReminderOutbox(db: ReturnType<typeof getDb>, taskId: string, dueAt: Date): Promise<void> {
  const [existing] = await db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.type, "crm.reminder.sms"), isNull(outboxEvents.processedAt), sql`(${outboxEvents.payload} ->> 'taskId') = ${taskId}`))
    .limit(1);

  if (existing?.id) {
    await db.update(outboxEvents).set({ nextAttemptAt: dueAt }).where(eq(outboxEvents.id, existing.id));
    return;
  }

  await db.insert(outboxEvents).values({
    type: "crm.reminder.sms",
    payload: { taskId },
    nextAttemptAt: dueAt
  });
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

  const snoozePreset = parseSnoozePreset((payload as any).snoozePreset);

  if (!action) return NextResponse.json({ error: "action_required" }, { status: 400 });
  if (taskIds.length === 0) return NextResponse.json({ error: "task_ids_required" }, { status: 400 });
  if ((action === "assign" || action === "assign_start") && !assignedToMemberId) {
    return NextResponse.json({ error: "assigned_to_required" }, { status: 400 });
  }
  if (action === "snooze" && !snoozePreset) {
    return NextResponse.json({ error: "snooze_preset_required" }, { status: 400 });
  }

  const actor = getAuditActorFromRequest(request);
  const db = getDb();
  const now = new Date();
  const config = await getSalesScorecardConfig(db);
  const timezone = config.timezone || "America/New_York";
  const snoozeDueAt = action === "snooze" && snoozePreset ? computeSnoozeDueAt({ preset: snoozePreset, now, timezone }) : null;

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
    let snoozed = 0;
    let snoozeSkippedNotStarted = 0;
    const snoozedTaskIds: string[] = [];

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

      if (action === "snooze" && snoozeDueAt) {
        const isStarted = row.dueAt instanceof Date || hasStartedAt(notes);
        if (!isStarted) {
          snoozeSkippedNotStarted += 1;
          skipped += 1;
          continue;
        }

        patch.dueAt = snoozeDueAt;
        snoozedTaskIds.push(row.id);
        snoozed += 1;
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

    return { updated, skipped, started, assigned, snoozed, snoozeSkippedNotStarted, snoozedTaskIds };
  });

  if (action === "snooze" && snoozeDueAt) {
    for (const taskId of result.snoozedTaskIds) {
      await ensureReminderOutbox(db, taskId, snoozeDueAt);
    }
  }

  await recordAuditEvent({
    actor,
    action: "outbound.bulk_updated",
    entityType: "crm_task",
    entityId: "bulk",
    meta: {
      action,
      taskCount: taskIds.length,
      assignedToMemberId: assignedToMemberId ?? null,
      snoozePreset: snoozePreset ?? null,
      snoozeDueAt: snoozeDueAt ? snoozeDueAt.toISOString() : null,
      updated: result.updated,
      skipped: result.skipped,
      started: result.started,
      assigned: result.assigned,
      snoozed: result.snoozed,
      snoozeSkippedNotStarted: result.snoozeSkippedNotStarted
    }
  });

  return NextResponse.json({
    ok: true,
    action,
    taskCount: taskIds.length,
    assignedToMemberId,
    snoozePreset,
    snoozeDueAt: snoozeDueAt ? snoozeDueAt.toISOString() : null,
    updated: result.updated,
    skipped: result.skipped,
    started: result.started,
    assigned: result.assigned,
    snoozed: result.snoozed,
    snoozeSkippedNotStarted: result.snoozeSkippedNotStarted
  });
}
