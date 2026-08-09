import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  auditLogs,
  contacts,
  crmTasks,
  outboxEvents,
  type DatabaseClient,
} from "@/db";
import { ensureOutboundAccountBrief } from "@/lib/outbound-account-briefs";
import type { OutboundQueueAccount } from "@/lib/outbound-queue-query";

export type OutboundHistoryEntry = {
  id: string;
  at: string;
  kind:
    | "import"
    | "draft"
    | "disposition"
    | "recap"
    | "task"
    | "partner"
    | "note";
  title: string;
  summary: string;
  contactName: string | null;
};

export type OutboundSelectedEnrichment = {
  accountId: string;
  brief: Awaited<ReturnType<typeof ensureOutboundAccountBrief>>;
  history: OutboundHistoryEntry[];
} | null;

function field(notes: string, key: string): string | null {
  const match = notes.match(new RegExp(`(?:^|\\n)${key}=([^\\n]+)`, "iu"));
  const value = match?.[1]?.trim();
  return value || null;
}

function dispositionLabel(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase().replace(/_/gu, " ")
    : "updated";
}

function contactName(first: string | null, last: string | null): string | null {
  return `${first ?? ""} ${last ?? ""}`.trim() || null;
}

function taskHistory(row: {
  id: string;
  contactId: string;
  title: string | null;
  status: string;
  notes: string | null;
  dueAt: Date | null;
  createdAt: Date;
  contactFirst: string | null;
  contactLast: string | null;
}): OutboundHistoryEntry | null {
  const notes = row.notes?.trim() ?? "";
  const normalized = notes.toLowerCase();
  const name = contactName(row.contactFirst, row.contactLast);
  if (normalized.startsWith("outbound recap (")) {
    return {
      id: `task:${row.id}:recap`,
      at: row.createdAt.toISOString(),
      kind: "recap",
      title: "Recap saved",
      summary:
        notes.replace(/^Outbound recap \([^)]+\):\s*/iu, "").trim() ||
        "Conversation recap saved for the next touch.",
      contactName: name,
    };
  }
  if (normalized.startsWith("outbound converted to partner")) {
    return {
      id: `task:${row.id}:partner`,
      at: row.createdAt.toISOString(),
      kind: "partner",
      title: "Converted to partner",
      summary: "Outbound relationship moved into the partner workflow.",
      contactName: name,
    };
  }
  if (normalized.startsWith("outbound connected")) {
    return {
      id: `task:${row.id}:connected`,
      at: row.createdAt.toISOString(),
      kind: "disposition",
      title: "Conversation started",
      summary: "Cadence stopped because a real conversation was established.",
      contactName: name,
    };
  }
  if (normalized.startsWith("outbound updated:")) {
    const disposition = notes.replace(/^Outbound updated:\s*/iu, "").trim();
    return {
      id: `task:${row.id}:updated`,
      at: row.createdAt.toISOString(),
      kind: "disposition",
      title: "Disposition logged",
      summary: `Marked as ${dispositionLabel(disposition)}.`,
      contactName: name,
    };
  }
  if (normalized.includes("kind=outbound")) {
    const details = [
      field(notes, "attempt") ? `Attempt ${field(notes, "attempt")}` : null,
      field(notes, "campaign"),
      row.dueAt
        ? `Due ${row.dueAt.toISOString()}`
        : row.status === "open"
          ? "Not started yet"
          : null,
    ].filter(Boolean);
    return {
      id: `task:${row.id}:cadence`,
      at: row.createdAt.toISOString(),
      kind: "task",
      title: row.title || "Outbound task",
      summary: details.join(" / ") || "Outbound cadence activity.",
      contactName: name,
    };
  }

  const noteLooksOutbound =
    row.title?.trim().toLowerCase() === "note" &&
    [
      "company:",
      "title:",
      "industry:",
      "company size:",
      "website:",
      "linkedin:",
      "source list:",
      "segment:",
      "subsegment:",
    ].some((marker) => normalized.includes(marker));
  if (!noteLooksOutbound) return null;
  return {
    id: `task:${row.id}:note`,
    at: row.createdAt.toISOString(),
    kind: "note",
    title: "Research note added",
    summary:
      notes.split("\n").slice(0, 2).join(" / ").trim() ||
      "Account research details were saved.",
    contactName: name,
  };
}

function auditHistory(
  row: {
    id: string;
    action: string;
    meta: Record<string, unknown> | null;
    createdAt: Date;
  },
  contactNames: Map<string, string>,
): OutboundHistoryEntry | null {
  const meta = row.meta ?? {};
  const contactId =
    typeof meta["contactId"] === "string" ? meta["contactId"] : null;
  const name = contactId ? (contactNames.get(contactId) ?? null) : null;
  if (row.action === "outbound.imported") {
    const campaign =
      typeof meta["campaign"] === "string" ? meta["campaign"] : null;
    const source = typeof meta["source"] === "string" ? meta["source"] : null;
    return {
      id: `audit:${row.id}`,
      at: row.createdAt.toISOString(),
      kind: "import",
      title: "Imported prospect",
      summary:
        [campaign, source].filter(Boolean).join(" / ") ||
        "Prospect imported into outbound.",
      contactName: name,
    };
  }
  if (row.action === "outbound.draft_created") {
    const kind = typeof meta["kind"] === "string" ? meta["kind"] : null;
    const channel =
      typeof meta["channel"] === "string" ? meta["channel"] : null;
    const disposition = meta["disposition"];
    return {
      id: `audit:${row.id}`,
      at: row.createdAt.toISOString(),
      kind: "draft",
      title:
        kind === "follow_up" ? "Drafted follow-up" : "Drafted first outreach",
      summary:
        [
          channel ? channel.toUpperCase() : null,
          disposition ? `after ${dispositionLabel(disposition)}` : null,
        ]
          .filter(Boolean)
          .join(" / ") || "Prepared an outreach draft in Inbox.",
      contactName: name,
    };
  }
  if (row.action === "outbound.disposition") {
    const attempt = Number(meta["attempt"]);
    return {
      id: `audit:${row.id}`,
      at: row.createdAt.toISOString(),
      kind: "disposition",
      title: "Disposition logged",
      summary:
        [
          meta["disposition"] ? dispositionLabel(meta["disposition"]) : null,
          Number.isFinite(attempt) ? `Attempt ${attempt}` : null,
          meta["hasRecap"] ? "recap saved" : null,
        ]
          .filter(Boolean)
          .join(" / ") || "Outbound disposition was recorded.",
      contactName: name,
    };
  }
  if (row.action === "partner.converted") {
    const partnerType =
      typeof meta["partnerType"] === "string" ? meta["partnerType"] : null;
    return {
      id: `audit:${row.id}`,
      at: row.createdAt.toISOString(),
      kind: "partner",
      title: "Converted to partner",
      summary: partnerType
        ? `Suggested path: ${partnerType.replace(/_/gu, " ")}`
        : "Outbound account converted into partner flow.",
      contactName: name,
    };
  }
  return null;
}

export async function loadOutboundSelectedEnrichment(input: {
  db: DatabaseClient;
  items: OutboundQueueAccount[];
  selectedAccountId: string;
  selectedTaskId: string;
}): Promise<OutboundSelectedEnrichment> {
  const selected =
    (input.selectedAccountId
      ? input.items.find((item) => item.id === input.selectedAccountId)
      : null) ??
    (input.selectedTaskId
      ? input.items.find((item) => item.taskIds.includes(input.selectedTaskId))
      : null) ??
    null;
  if (!selected?.key.startsWith("account:")) return null;

  const brief = await ensureOutboundAccountBrief({
    partnerAccountId: selected.id,
  });
  const contactIds = Array.from(
    new Set(selected.contacts.map((item) => item.id)),
  );
  const taskIds = Array.from(new Set(selected.taskIds));
  const contactNames = new Map(
    selected.contacts.map((item) => [item.id, item.name] as const),
  );

  const taskRows = await input.db
    .select({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      title: crmTasks.title,
      status: crmTasks.status,
      notes: crmTasks.notes,
      dueAt: crmTasks.dueAt,
      createdAt: crmTasks.createdAt,
      contactFirst: contacts.firstName,
      contactLast: contacts.lastName,
    })
    .from(crmTasks)
    .innerJoin(contacts, eq(crmTasks.contactId, contacts.id))
    .where(
      or(
        eq(crmTasks.partnerAccountId, selected.id),
        eq(contacts.partnerAccountId, selected.id),
      ),
    )
    .orderBy(desc(crmTasks.createdAt))
    .limit(30);

  const auditPredicates = [];
  if (contactIds.length > 0) {
    auditPredicates.push(
      and(
        eq(auditLogs.entityType, "contact"),
        inArray(auditLogs.entityId, contactIds),
      ),
    );
    const idList = sql.join(
      contactIds.map((id) => sql`${id}`),
      sql`, `,
    );
    auditPredicates.push(
      and(
        eq(auditLogs.entityType, "conversation_message"),
        sql`${auditLogs.meta} ->> 'contactId' in (${idList})`,
      ),
    );
  }
  if (taskIds.length > 0) {
    auditPredicates.push(
      and(
        eq(auditLogs.entityType, "crm_task"),
        inArray(auditLogs.entityId, taskIds),
      ),
    );
  }
  const auditRows =
    auditPredicates.length > 0
      ? await input.db
          .select({
            id: auditLogs.id,
            action: auditLogs.action,
            entityType: auditLogs.entityType,
            entityId: auditLogs.entityId,
            meta: auditLogs.meta,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .where(
            and(
              inArray(auditLogs.action, [
                "outbound.imported",
                "outbound.draft_created",
                "outbound.disposition",
                "partner.converted",
              ]),
              or(...auditPredicates),
            ),
          )
          .orderBy(desc(auditLogs.createdAt))
          .limit(40)
      : [];

  const auditedPartnerContactIds = new Set(
    auditRows
      .filter(
        (row) =>
          row.action === "partner.converted" &&
          row.entityType === "contact" &&
          typeof row.entityId === "string",
      )
      .map((row) => row.entityId as string),
  );
  const history = [
    ...taskRows
      .filter(
        (row) =>
          !(
            auditedPartnerContactIds.has(row.contactId) &&
            row.notes
              ?.trim()
              .toLowerCase()
              .startsWith("outbound converted to partner")
          ),
      )
      .map(taskHistory),
    ...auditRows.map((row) => auditHistory(row, contactNames)),
  ]
    .filter((entry): entry is OutboundHistoryEntry => entry !== null)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, 12);

  return { accountId: selected.id, brief, history };
}

export async function applyOutboundReminderDates(
  db: DatabaseClient,
  items: OutboundQueueAccount[],
): Promise<void> {
  const taskIds = items.flatMap((item) => item.taskIds);
  if (taskIds.length === 0) return;
  const taskIdExpr = sql<string>`(${outboxEvents.payload} ->> 'taskId')`;
  const idList = sql.join(
    taskIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const reminders = await db
    .select({ taskId: taskIdExpr, nextAttemptAt: outboxEvents.nextAttemptAt })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, "crm.reminder.sms"),
        sql`${taskIdExpr} in (${idList})`,
        sql`${outboxEvents.processedAt} is null`,
      ),
    );
  const byTask = new Map<string, string>();
  for (const reminder of reminders) {
    if (
      reminder.taskId &&
      !byTask.has(reminder.taskId) &&
      reminder.nextAttemptAt instanceof Date
    ) {
      byTask.set(reminder.taskId, reminder.nextAttemptAt.toISOString());
    }
  }
  for (const item of items) {
    item.reminderAt = byTask.get(item.primaryTaskId) ?? null;
  }
}
