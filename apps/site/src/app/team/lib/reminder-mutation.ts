import type { TeamMutationSuccessEnvelope } from "./mutation-feedback";

export type ReminderMutationRecord = {
  id: string;
  contactId: string;
  title: string;
  dueAt: string;
  assignedTo: string | null;
  status: "open" | "completed";
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReminderMutationAttempt = {
  fingerprint: string;
  idempotencyKey: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isExactReminderVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function parseReminder(value: unknown): ReminderMutationRecord | null {
  if (!isRecord(value)) return null;
  const dueAt = value["dueAt"];
  const assignedTo = value["assignedTo"];
  const notes = value["notes"];
  if (
    typeof value["id"] !== "string" ||
    !UUID_PATTERN.test(value["id"]) ||
    typeof value["contactId"] !== "string" ||
    !UUID_PATTERN.test(value["contactId"]) ||
    typeof value["title"] !== "string" ||
    value["title"].length === 0 ||
    !isExactReminderVersion(dueAt) ||
    (assignedTo !== null &&
      (typeof assignedTo !== "string" || !UUID_PATTERN.test(assignedTo))) ||
    (value["status"] !== "open" && value["status"] !== "completed") ||
    (notes !== null && typeof notes !== "string") ||
    !isExactReminderVersion(value["createdAt"]) ||
    !isExactReminderVersion(value["updatedAt"])
  ) {
    return null;
  }
  return {
    id: value["id"],
    contactId: value["contactId"],
    title: value["title"],
    dueAt,
    assignedTo,
    status: value["status"],
    notes,
    createdAt: value["createdAt"],
    updatedAt: value["updatedAt"],
  };
}

export function parseReminderMutationSuccess(
  value: unknown,
  expected: {
    actorId?: string;
    contactId?: string;
    status?: "open" | "completed";
    taskId?: string;
  },
): TeamMutationSuccessEnvelope<{ reminder: ReminderMutationRecord }> | null {
  if (!isRecord(value) || value["ok"] !== true) return null;
  const data = isRecord(value["data"]) ? value["data"] : null;
  const reminder = parseReminder(data?.["reminder"]);
  const receipt = isRecord(value["receipt"]) ? value["receipt"] : null;
  if (
    !reminder ||
    !receipt ||
    typeof receipt["operationId"] !== "string" ||
    !UUID_PATTERN.test(receipt["operationId"]) ||
    typeof receipt["correlationId"] !== "string" ||
    receipt["correlationId"].length === 0 ||
    receipt["correlationId"].length > 128 ||
    typeof receipt["actorId"] !== "string" ||
    !UUID_PATTERN.test(receipt["actorId"]) ||
    typeof receipt["auditEventId"] !== "string" ||
    !UUID_PATTERN.test(receipt["auditEventId"]) ||
    (expected.actorId !== undefined &&
      receipt["actorId"] !== expected.actorId) ||
    !isExactReminderVersion(receipt["committedAt"]) ||
    receipt["entityType"] !== "crm_task" ||
    receipt["entityId"] !== reminder.id ||
    receipt["version"] !== reminder.updatedAt ||
    (expected.contactId !== undefined &&
      reminder.contactId !== expected.contactId) ||
    (expected.taskId !== undefined && reminder.id !== expected.taskId) ||
    (expected.status !== undefined && reminder.status !== expected.status)
  ) {
    return null;
  }
  return value as TeamMutationSuccessEnvelope<{
    reminder: ReminderMutationRecord;
  }>;
}

export function stableReminderMutationAttempt(
  current: ReminderMutationAttempt | null,
  fingerprint: string,
  prefix: string,
): ReminderMutationAttempt {
  if (current?.fingerprint === fingerprint) return current;
  return {
    fingerprint,
    idempotencyKey: `${prefix}:${globalThis.crypto.randomUUID()}`,
  };
}
