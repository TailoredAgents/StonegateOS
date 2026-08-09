import { createHash } from "node:crypto";
import {
  isTeamMutationSuccessEnvelope,
  type TeamMutationSuccessEnvelope,
} from "./mutation-feedback";

export type OutboundTaskReference = { id: string; version: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CALLBACK_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;
const TEAM_TIME_ZONE = "America/New_York";

const callbackFormatter = new Intl.DateTimeFormat("en-US-u-hc-h23", {
  timeZone: TEAM_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOutboundTaskReference(
  value: unknown,
): value is OutboundTaskReference {
  if (!isRecord(value)) return false;
  const id = value["id"];
  const version = value["version"];
  return (
    typeof id === "string" &&
    UUID_PATTERN.test(id) &&
    typeof version === "string" &&
    VERSION_PATTERN.test(version) &&
    !Number.isNaN(Date.parse(version)) &&
    new Date(version).toISOString() === version
  );
}

export function outboundBulkVersion(
  tasks: readonly OutboundTaskReference[],
): string {
  const canonical = [...tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => `${task.id}:${task.version}`)
    .join("\n");
  return `outbound-bulk:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Converts the wall-clock value displayed by the Eastern-time CRM into one
 * unambiguous UTC instant. Nonexistent and repeated DST wall times fail closed.
 */
export function parseOutboundCallbackLocal(value: string): string | null {
  const match = CALLBACK_LOCAL_PATTERN.exec(value.trim());
  if (!match) return null;
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  const hourText = match[4];
  const minuteText = match[5];
  if (!yearText || !monthText || !dayText || !hourText || !minuteText) {
    return null;
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute
  ) {
    return null;
  }

  const target = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const matches: Date[] = [];
  for (const easternOffsetMinutes of [-300, -240]) {
    const candidate = new Date(
      wallClock.getTime() - easternOffsetMinutes * 60_000,
    );
    const parts = callbackFormatter.formatToParts(candidate);
    const formatted = `${parts.find((part) => part.type === "year")?.value ?? ""}-${parts.find((part) => part.type === "month")?.value ?? ""}-${parts.find((part) => part.type === "day")?.value ?? ""} ${parts.find((part) => part.type === "hour")?.value ?? ""}:${parts.find((part) => part.type === "minute")?.value ?? ""}`;
    if (formatted === target) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0]!.toISOString() : null;
}

function hasExpectedReceipt(
  envelope: TeamMutationSuccessEnvelope<unknown>,
  expected: {
    actorId: string;
    entityType: "crm_task" | "crm_task_batch";
    entityId: string;
  },
): boolean {
  return (
    envelope.receipt.actorId === expected.actorId &&
    envelope.receipt.entityType === expected.entityType &&
    envelope.receipt.entityId === expected.entityId &&
    typeof envelope.receipt.auditEventId === "string" &&
    envelope.receipt.auditEventId.length > 0 &&
    (typeof envelope.receipt.version === "string" ||
      typeof envelope.receipt.version === "number")
  );
}

export function parseOutboundTaskMutationSuccess(
  value: unknown,
  expected: {
    actorId: string;
    taskId: string;
    disposition?: string;
    callbackAt?: string;
  },
): TeamMutationSuccessEnvelope<{
  taskId: string;
  contactId: string;
  version: string;
  disposition?: string;
  alreadyStarted?: boolean;
  stopped?: boolean;
  nextTaskId?: string | null;
  nextDueAt?: string | null;
}> | null {
  if (!isTeamMutationSuccessEnvelope(value)) return null;
  if (
    !hasExpectedReceipt(value, {
      actorId: expected.actorId,
      entityType: "crm_task",
      entityId: expected.taskId,
    }) ||
    !isRecord(value.data) ||
    value.data["taskId"] !== expected.taskId ||
    typeof value.data["contactId"] !== "string" ||
    !UUID_PATTERN.test(value.data["contactId"]) ||
    typeof value.data["version"] !== "string" ||
    value.receipt.version !== value.data["version"] ||
    !VERSION_PATTERN.test(value.data["version"]) ||
    Number.isNaN(Date.parse(value.data["version"])) ||
    new Date(value.data["version"]).toISOString() !== value.data["version"]
  ) {
    return null;
  }
  if (
    expected.disposition !== undefined &&
    value.data["disposition"] !== expected.disposition
  ) {
    return null;
  }
  if (expected.disposition === "callback_requested") {
    const nextTaskId = value.data["nextTaskId"];
    const nextDueAt = value.data["nextDueAt"];
    if (
      typeof expected.callbackAt !== "string" ||
      !VERSION_PATTERN.test(expected.callbackAt) ||
      Number.isNaN(Date.parse(expected.callbackAt)) ||
      new Date(expected.callbackAt).toISOString() !== expected.callbackAt ||
      typeof nextTaskId !== "string" ||
      !UUID_PATTERN.test(nextTaskId) ||
      nextDueAt !== expected.callbackAt ||
      value.data["stopped"] !== false ||
      Date.parse(expected.callbackAt) <= Date.parse(value.receipt.committedAt)
    ) {
      return null;
    }
  } else if (expected.callbackAt !== undefined) {
    return null;
  }
  return value as TeamMutationSuccessEnvelope<{
    taskId: string;
    contactId: string;
    version: string;
    disposition?: string;
    alreadyStarted?: boolean;
    stopped?: boolean;
    nextTaskId?: string | null;
    nextDueAt?: string | null;
  }>;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseOutboundBulkMutationSuccess(
  value: unknown,
  expected: {
    actorId: string;
    action: string;
    submittedVersion: string;
    taskIds: readonly string[];
  },
): TeamMutationSuccessEnvelope<{
  action: string;
  taskCount: number;
  updated: number;
  skipped: number;
  started: number;
  assigned: number;
  snoozed: number;
  tasks: OutboundTaskReference[];
  version: string;
}> | null {
  if (!isTeamMutationSuccessEnvelope(value)) return null;
  if (
    !hasExpectedReceipt(value, {
      actorId: expected.actorId,
      entityType: "crm_task_batch",
      entityId: expected.submittedVersion,
    }) ||
    !isRecord(value.data) ||
    value.data["action"] !== expected.action ||
    !Array.isArray(value.data["tasks"]) ||
    !value.data["tasks"].every(isOutboundTaskReference) ||
    typeof value.data["version"] !== "string" ||
    value.receipt.version !== value.data["version"]
  ) {
    return null;
  }
  const actualIds = value.data["tasks"]
    .map((task) => task.id)
    .sort((left, right) => left.localeCompare(right));
  const expectedIds = [...expected.taskIds].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index]) ||
    value.data["taskCount"] !== expectedIds.length ||
    outboundBulkVersion(value.data["tasks"]) !== value.data["version"] ||
    ![
      value.data["updated"],
      value.data["skipped"],
      value.data["started"],
      value.data["assigned"],
      value.data["snoozed"],
    ].every(isNonNegativeInteger) ||
    Number(value.data["updated"]) + Number(value.data["skipped"]) !==
      expectedIds.length
  ) {
    return null;
  }
  return value as TeamMutationSuccessEnvelope<{
    action: string;
    taskCount: number;
    updated: number;
    skipped: number;
    started: number;
    assigned: number;
    snoozed: number;
    tasks: OutboundTaskReference[];
    version: string;
  }>;
}
