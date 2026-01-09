import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, ilike } from "drizzle-orm";
import { contacts, crmTasks, getDb, outboxEvents, teamMembers } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDueAt(value: unknown): Date | null {
  const raw = readString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

async function scheduleReminderOutbox(db: DbExecutor, taskId: string, dueAt: Date): Promise<void> {
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

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const contactId = readString(record["contactId"]);
  const title = readString(record["title"]) ?? "Call back";
  const notes = readString(record["notes"]);
  const dueAt = parseDueAt(record["dueAt"]);
  let assignedTo = readString(record["assignedTo"]) ?? readString(process.env["REMINDERS_DEFAULT_ASSIGNEE_ID"]);

  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }
  if (!dueAt) {
    return NextResponse.json({ error: "due_at_required" }, { status: 400 });
  }

  const db = getDb();
  const [contact] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!contact) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  if (!assignedTo) {
    const [defaultMember] = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(and(ilike(teamMembers.name, "Devon%"), eq(teamMembers.active, true)))
      .limit(1);
    assignedTo = defaultMember?.id ?? null;
  }

  const actor = getAuditActorFromRequest(request);

  const [task] = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(crmTasks)
      .values({
        contactId,
        title,
        notes,
        dueAt,
        assignedTo: assignedTo ?? null,
        status: "open"
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
        updatedAt: crmTasks.updatedAt
      });

    if (!created) {
      return [null] as const;
    }

    await scheduleReminderOutbox(tx, created.id, dueAt);
    return [created] as const;
  });

  if (!task) {
    return NextResponse.json({ error: "reminder_create_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor,
    action: "crm.reminder.created",
    entityType: "crm_task",
    entityId: task.id,
    meta: {
      contactId: task.contactId,
      dueAt: task.dueAt ? task.dueAt.toISOString() : null,
      assignedTo: task.assignedTo ?? null
    }
  });

  return NextResponse.json({
    reminder: {
      id: task.id,
      contactId: task.contactId,
      title: task.title,
      dueAt: task.dueAt ? task.dueAt.toISOString() : null,
      assignedTo: task.assignedTo ?? null,
      status: task.status,
      notes: task.notes ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString()
    }
  });
}
