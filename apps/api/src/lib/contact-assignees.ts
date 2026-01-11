import { eq } from "drizzle-orm";
import { policySettings } from "@/db";
import type { DatabaseClient } from "@/db";

type Database = DatabaseClient;
type TransactionExecutor = Parameters<Database["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;

type DbExecutor = Database | TransactionExecutor;

const CONTACT_ASSIGNEES_KEY = "contact_assignees_v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readAssigneeMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const raw = value["assignees"];
  if (!isRecord(raw)) return {};
  const entries: Record<string, string> = {};
  for (const [contactId, memberId] of Object.entries(raw)) {
    if (typeof contactId !== "string" || contactId.trim().length === 0) continue;
    if (typeof memberId !== "string" || memberId.trim().length === 0) continue;
    entries[contactId.trim()] = memberId.trim();
  }
  return entries;
}

export async function getContactAssigneeMap(db: DbExecutor): Promise<Record<string, string>> {
  const [row] = await db
    .select({ value: policySettings.value })
    .from(policySettings)
    .where(eq(policySettings.key, CONTACT_ASSIGNEES_KEY))
    .limit(1);
  return readAssigneeMap(row?.value);
}

export async function getContactAssignee(db: DbExecutor, contactId: string): Promise<string | null> {
  const map = await getContactAssigneeMap(db);
  return map[contactId] ?? null;
}

export async function setContactAssignee(
  db: DbExecutor,
  input: {
    contactId: string;
    memberId: string | null;
    actorId?: string | null;
  }
): Promise<void> {
  const existingMap = await getContactAssigneeMap(db);
  const nextMap = { ...existingMap };
  if (input.memberId) {
    nextMap[input.contactId] = input.memberId;
  } else {
    delete nextMap[input.contactId];
  }

  await db
    .insert(policySettings)
    .values({
      key: CONTACT_ASSIGNEES_KEY,
      value: { assignees: nextMap },
      updatedBy: input.actorId ?? null
    })
    .onConflictDoUpdate({
      target: policySettings.key,
      set: {
        value: { assignees: nextMap },
        updatedBy: input.actorId ?? null,
        updatedAt: new Date()
      }
    });
}

