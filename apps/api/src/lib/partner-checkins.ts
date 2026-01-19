import { and, eq, ilike, isNotNull, isNull, sql } from "drizzle-orm";
import { crmTasks, outboxEvents } from "@/db";

type DatabaseClient = {
  select: any;
  insert: any;
  update: any;
};

export type PartnerCheckinUpsertArgs = {
  contactId: string;
  assignedTo: string | null;
  dueAt: Date;
};

function upsertField(notes: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`(^|\\n)${key}=[^\\n]*`, "i");
  if (re.test(notes)) {
    return notes.replace(re, `$1${line}`);
  }
  return notes.length ? `${notes}\n${line}` : line;
}

async function ensureReminderOutbox(db: any, taskId: string, dueAt: Date): Promise<void> {
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

export async function upsertPartnerCheckinTask(db: any, args: PartnerCheckinUpsertArgs): Promise<{ taskId: string }> {
  const now = new Date();
  const [existing] = await db
    .select({ id: crmTasks.id, notes: crmTasks.notes })
    .from(crmTasks)
    .where(
      and(
        eq(crmTasks.contactId, args.contactId),
        eq(crmTasks.status, "open"),
        isNotNull(crmTasks.notes),
        ilike(crmTasks.notes, "%kind=partner_checkin%")
      )
    )
    .limit(1);

  if (existing?.id) {
    const existingNotes = typeof existing.notes === "string" ? existing.notes : "";
    const nextNotes = upsertField(existingNotes, "kind", "partner_checkin");
    await db
      .update(crmTasks)
      .set({
        title: "Partner: Check-in",
        dueAt: args.dueAt,
        assignedTo: args.assignedTo,
        notes: nextNotes,
        updatedAt: now
      })
      .where(eq(crmTasks.id, existing.id));
    await ensureReminderOutbox(db, existing.id, args.dueAt);
    return { taskId: existing.id };
  }

  const notes = ["[partner]", "kind=partner_checkin"].join("\n");
  const [created] = await db
    .insert(crmTasks)
    .values({
      contactId: args.contactId,
      title: "Partner: Check-in",
      dueAt: args.dueAt,
      assignedTo: args.assignedTo,
      status: "open",
      notes
    })
    .returning({ id: crmTasks.id });

  if (!created?.id) {
    throw new Error("partner_checkin_create_failed");
  }

  await ensureReminderOutbox(db, created.id, args.dueAt);
  return { taskId: created.id };
}

export async function completePartnerCheckinTasks(db: any, args: { contactId: string }): Promise<void> {
  const now = new Date();
  const openTasks = await db
    .select({ id: crmTasks.id, notes: crmTasks.notes })
    .from(crmTasks)
    .where(
      and(
        eq(crmTasks.contactId, args.contactId),
        eq(crmTasks.status, "open"),
        isNotNull(crmTasks.notes),
        ilike(crmTasks.notes, "%kind=partner_checkin%")
      )
    );

  for (const task of openTasks) {
    const taskNotes = typeof task.notes === "string" ? task.notes : "";
    const nextNotes = upsertField(upsertField(taskNotes, "kind", "partner_checkin"), "completedAt", now.toISOString());
    await db.update(crmTasks).set({ status: "completed", notes: nextNotes, updatedAt: now }).where(eq(crmTasks.id, task.id));
  }
}

