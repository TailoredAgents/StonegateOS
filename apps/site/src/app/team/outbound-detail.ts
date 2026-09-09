import type { OutboundQueueItem } from "./outbound-queue";

export type OutboundDetailPermissions = {
  canCall: boolean;
  canMessage: boolean;
  canDraft: boolean;
  canManage: boolean;
};

/** Never attach an outreach action to another person's task. */
export function resolveOutboundContactContext(
  item: Pick<
    OutboundQueueItem,
    "contacts" | "tasks" | "primaryContactId" | "primaryTaskId"
  >,
  contactId: string,
  taskId?: string,
) {
  const contact = item.contacts.find((candidate) => candidate.id === contactId);
  if (!contact) return null;
  const tasks = item.tasks.filter(
    (candidate) => candidate.contactId === contact.id,
  );
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : (tasks.find((candidate) => candidate.id === item.primaryTaskId) ??
      tasks[0]);
  const channels: Array<"email" | "sms"> = [];
  if (contact.email?.trim()) channels.push("email");
  if (contact.phone?.trim()) channels.push("sms");
  return {
    contact,
    tasks,
    task: task ?? null,
    channels,
    // Inconsistent snapshots must fail closed until the queue is refreshed.
    outreachBlocked:
      contact.doNotContact || tasks.some((candidate) => candidate.doNotContact),
  };
}

export function outboundOutcomeLabel(value: string | null | undefined): string {
  if (!value) return "No outcome recorded";
  if (value === "dnc") return "Do not contact";
  return value
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
