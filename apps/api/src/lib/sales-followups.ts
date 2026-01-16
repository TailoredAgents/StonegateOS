import { and, asc, eq, ilike, isNotNull, or } from "drizzle-orm";
import { contacts, crmTasks, getDb } from "@/db";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

async function resolveMemberId(db: DbExecutor, contactId: string): Promise<string | null> {
  const [contact] = await db
    .select({ salespersonMemberId: contacts.salespersonMemberId })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (typeof contact?.salespersonMemberId === "string" && contact.salespersonMemberId.trim().length > 0) {
    return contact.salespersonMemberId.trim();
  }

  const config = await getSalesScorecardConfig(db);
  return config.defaultAssigneeMemberId?.trim().length ? config.defaultAssigneeMemberId.trim() : null;
}

export async function completeNextFollowupTaskOnTouch(input: {
  db?: DbExecutor;
  contactId: string;
  memberId?: string | null;
  now?: Date;
}): Promise<{ completedTaskId: string | null }> {
  const db = input.db ?? getDb();
  const contactId = input.contactId.trim();
  if (!contactId) return { completedTaskId: null };

  const now = input.now ?? new Date();
  const memberId = (input.memberId?.trim() ?? "") || (await resolveMemberId(db, contactId));
  if (!memberId) return { completedTaskId: null };

  const [task] = await db
    .select({ id: crmTasks.id })
    .from(crmTasks)
    .where(
      and(
        eq(crmTasks.contactId, contactId),
        eq(crmTasks.assignedTo, memberId),
        eq(crmTasks.status, "open"),
        isNotNull(crmTasks.dueAt),
        isNotNull(crmTasks.notes),
        or(ilike(crmTasks.notes, "%[auto] leadId=%"), ilike(crmTasks.notes, "%[auto] contactId=%")),
        ilike(crmTasks.notes, "%kind=follow_up%")
      )
    )
    .orderBy(asc(crmTasks.dueAt), asc(crmTasks.createdAt))
    .limit(1);

  if (!task?.id) return { completedTaskId: null };

  await db
    .update(crmTasks)
    .set({ status: "completed", updatedAt: now })
    .where(eq(crmTasks.id, task.id));

  return { completedTaskId: task.id };
}

