import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, ilike, isNotNull, isNull, sql } from "drizzle-orm";
import { crmTasks, getDb, outboxEvents } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

function parseField(notes: string, key: string): string | null {
  const match = notes.match(new RegExp(`(?:^|\\n)${key}=([^\\n]+)`, "i"));
  const value = match?.[1]?.trim();
  return value && value.length ? value : null;
}

function upsertField(notes: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`(^|\\n)${key}=[^\\n]*`, "i");
  if (re.test(notes)) {
    return notes.replace(re, `$1${line}`);
  }
  return notes.length ? `${notes}\n${line}` : line;
}

function computeNextDueAt(now: Date, attempt: number): Date | null {
  // Simple cadence: day 0 (attempt 1), day 1 (attempt 2), day 3 (attempt 3), day 7 (attempt 4)
  const scheduleDays = [0, 1, 3, 7];
  const idx = Math.min(Math.max(1, attempt), scheduleDays.length) - 1;
  const nextIdx = idx + 1;
  const days = scheduleDays[nextIdx];
  if (days === undefined) return null;
  const ms = days * 24 * 60 * 60_000;
  return new Date(now.getTime() + ms);
}

function normalizeDisposition(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

type DbClient = ReturnType<typeof getDb>;
type TxClient = Parameters<DbClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown> ? Tx : never;
type DbExecutor = DbClient | TxClient;

async function ensureReminderOutbox(db: DbExecutor, taskId: string, dueAt: Date): Promise<void> {
  const [existing] = await db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, "crm.reminder.sms"),
        isNull(outboxEvents.processedAt),
        sql`(${outboxEvents.payload} ->> 'taskId') = ${taskId}`
      )
    )
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

  const taskId = typeof (payload as any).taskId === "string" ? (payload as any).taskId.trim() : "";
  const disposition = normalizeDisposition((payload as any).disposition);
  const callbackAtRaw = typeof (payload as any).callbackAt === "string" ? (payload as any).callbackAt.trim() : "";

  if (!taskId) return NextResponse.json({ error: "task_id_required" }, { status: 400 });
  if (!disposition) return NextResponse.json({ error: "disposition_required" }, { status: 400 });

  const callbackAt =
    callbackAtRaw && Number.isFinite(Date.parse(callbackAtRaw)) ? new Date(callbackAtRaw) : null;

  const actor = getAuditActorFromRequest(request);
  const db = getDb();
  const now = new Date();

  const [task] = await db
    .select({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      assignedTo: crmTasks.assignedTo,
      status: crmTasks.status,
      title: crmTasks.title,
      dueAt: crmTasks.dueAt,
      notes: crmTasks.notes
    })
    .from(crmTasks)
    .where(eq(crmTasks.id, taskId))
    .limit(1);

  if (!task?.id) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  if (!task.contactId) return NextResponse.json({ error: "contact_not_found" }, { status: 400 });

  const notes = typeof task.notes === "string" ? task.notes : "";
  if (!notes.toLowerCase().includes("kind=outbound")) {
    return NextResponse.json({ error: "not_outbound_task" }, { status: 400 });
  }

  const attempt = Number(parseField(notes, "attempt") ?? "1");
  const normalizedAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const campaign = parseField(notes, "campaign") ?? "property_management";

  const completedNotes = upsertField(upsertField(notes, "lastDisposition", disposition), "completedAt", now.toISOString());

  await db
    .update(crmTasks)
    .set({ status: "completed", notes: completedNotes, updatedAt: now })
    .where(and(eq(crmTasks.id, taskId), eq(crmTasks.status, "open")));

  await recordAuditEvent({
    actor,
    action: "outbound.disposition",
    entityType: "crm_task",
    entityId: taskId,
    meta: {
      contactId: task.contactId,
      disposition,
      attempt: normalizedAttempt,
      campaign
    }
  });

  const stop =
    disposition === "dnc" ||
    disposition === "not_interested" ||
    disposition === "wrong_number" ||
    disposition === "spam";

  if (stop) {
    // Mark the contact as disqualified for automated queues (keeps it visible in Contacts).
    await db.insert(crmTasks).values({
      contactId: task.contactId,
      title: "Note",
      status: "completed",
      dueAt: null,
      assignedTo: null,
      notes: `disqualify=outbound_${disposition}`
    });

    return NextResponse.json({ ok: true, taskId, contactId: task.contactId, stopped: true });
  }

  const nextAttempt = normalizedAttempt + 1;
  const nextDueAt = callbackAt ?? computeNextDueAt(now, normalizedAttempt);
  if (!nextDueAt) {
    return NextResponse.json({ ok: true, taskId, contactId: task.contactId, stopped: true });
  }

  const [nextExisting] = await db
    .select({ id: crmTasks.id, dueAt: crmTasks.dueAt })
    .from(crmTasks)
    .where(
      and(
        eq(crmTasks.contactId, task.contactId),
        eq(crmTasks.status, "open"),
        isNotNull(crmTasks.notes),
        ilike(crmTasks.notes, "%kind=outbound%"),
        ilike(crmTasks.notes, `%campaign=${campaign}%`)
      )
    )
    .limit(1);

  let nextTaskId = nextExisting?.id ?? null;
  let nextTaskDueAt = nextExisting?.dueAt instanceof Date ? nextExisting.dueAt : null;

  if (!nextTaskId) {
    const nextNotes = upsertField(upsertField(notes, "attempt", String(nextAttempt)), "lastDisposition", disposition);
    const [created] = await db
      .insert(crmTasks)
      .values({
        contactId: task.contactId,
        title: callbackAt ? "Outbound: Callback" : "Outbound: Follow up",
        status: "open",
        dueAt: nextDueAt,
        assignedTo: task.assignedTo,
        notes: nextNotes
      })
      .returning({ id: crmTasks.id });

    if (created?.id) {
      nextTaskId = created.id;
      nextTaskDueAt = nextDueAt;
    }
  } else {
    const nextNotes = upsertField(upsertField(notes, "attempt", String(nextAttempt)), "lastDisposition", disposition);
    await db
      .update(crmTasks)
      .set({
        title: callbackAt ? "Outbound: Callback" : "Outbound: Follow up",
        dueAt: nextDueAt,
        assignedTo: task.assignedTo,
        notes: nextNotes,
        updatedAt: now
      })
      .where(and(eq(crmTasks.id, nextTaskId), eq(crmTasks.status, "open")));
    nextTaskDueAt = nextDueAt;
  }

  // Nudge only once it becomes due; reminders already handle the salesperson SMS.
  await db.insert(crmTasks).values({
    contactId: task.contactId,
    title: "Note",
    status: "completed",
    dueAt: null,
    assignedTo: null,
    notes: `Outbound updated: ${disposition}`
  });

  if (nextTaskId && nextTaskDueAt) {
    await ensureReminderOutbox(db, nextTaskId, nextTaskDueAt);
  }

  return NextResponse.json({ ok: true, taskId, contactId: task.contactId, nextDueAt: nextDueAt.toISOString() });
}
