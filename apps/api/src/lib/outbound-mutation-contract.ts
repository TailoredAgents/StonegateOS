import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { TeamMutationFailure } from "@/lib/team-mutation";

export const OUTBOUND_BULK_MAX_TASKS = 500;
export const OUTBOUND_RECAP_MAX_LENGTH = 4_000;
export const DEFAULT_OUTBOUND_CAMPAIGN = "property_management";

export const OUTBOUND_DISPOSITIONS = [
  "connected",
  "partner",
  "no_answer",
  "left_voicemail",
  "email_sent",
  "callback_requested",
  "not_interested",
  "dnc",
  "wrong_number",
  "spam",
] as const;

export type OutboundDisposition = (typeof OUTBOUND_DISPOSITIONS)[number];
export type OutboundBulkAction = "assign" | "start" | "assign_start" | "snooze";
export type OutboundSnoozePreset =
  | "today_5pm"
  | "tomorrow_9am"
  | "plus_3d_9am"
  | "next_monday_9am"
  | "plus_7d_9am";

export type OutboundTaskReference = {
  id: string;
  version: string;
};

export type OutboundStartInput = {
  taskId: string;
};

export type OutboundDispositionInput = {
  taskId: string;
  disposition: OutboundDisposition;
  callbackAt: Date | null;
  recap: string | null;
};

export type OutboundBulkInput = {
  action: OutboundBulkAction;
  tasks: OutboundTaskReference[];
  assignedToMemberId: string | null;
  snoozePreset: OutboundSnoozePreset | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BULK_ACTIONS = new Set<OutboundBulkAction>([
  "assign",
  "start",
  "assign_start",
  "snooze",
]);
const SNOOZE_PRESETS = new Set<OutboundSnoozePreset>([
  "today_5pm",
  "tomorrow_9am",
  "plus_3d_9am",
  "next_monday_9am",
  "plus_7d_9am",
]);
const DISPOSITIONS = new Set<OutboundDisposition>(OUTBOUND_DISPOSITIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TeamMutationFailure("invalid", `${label} must be an object.`);
  }
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new TeamMutationFailure(
      "invalid",
      `${label} contains unsupported fields: ${unsupported.sort().join(", ")}.`,
    );
  }
}

function parseUuid(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TeamMutationFailure("invalid", `${field} is required.`, {
      fieldErrors: { [field]: "Use a valid task or team member ID." },
    });
  }
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new TeamMutationFailure("invalid", `${field} is invalid.`, {
      fieldErrors: { [field]: "Use a valid task or team member ID." },
    });
  }
  return normalized;
}

export function parseOutboundTaskVersion(
  value: unknown,
  field = "version",
): string {
  if (typeof value !== "string") {
    throw new TeamMutationFailure("invalid", `${field} is required.`, {
      fieldErrors: { [field]: "Refresh the outbound queue and try again." },
    });
  }
  const normalized = value.trim();
  if (
    !VERSION_PATTERN.test(normalized) ||
    Number.isNaN(Date.parse(normalized)) ||
    new Date(normalized).toISOString() !== normalized
  ) {
    throw new TeamMutationFailure("invalid", `${field} is invalid.`, {
      fieldErrors: { [field]: "Refresh the outbound queue and try again." },
    });
  }
  return normalized;
}

export function parseOutboundStartPayload(value: unknown): OutboundStartInput {
  assertExactObject(value, ["taskId"], "The start request");
  return { taskId: parseUuid(value["taskId"], "taskId") };
}

export function parseOutboundDispositionPayload(
  value: unknown,
  now = new Date(),
): OutboundDispositionInput {
  assertExactObject(
    value,
    ["taskId", "disposition", "callbackAt", "recap"],
    "The disposition request",
  );
  const taskId = parseUuid(value["taskId"], "taskId");
  const rawDisposition =
    typeof value["disposition"] === "string"
      ? value["disposition"].trim().toLowerCase()
      : "";
  if (!DISPOSITIONS.has(rawDisposition as OutboundDisposition)) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a supported outbound disposition.",
      { fieldErrors: { disposition: "Choose one of the displayed outcomes." } },
    );
  }
  const disposition = rawDisposition as OutboundDisposition;

  let recap: string | null = null;
  if (value["recap"] !== undefined) {
    if (typeof value["recap"] !== "string") {
      throw new TeamMutationFailure("invalid", "The recap must be text.", {
        fieldErrors: { recap: "Enter text only." },
      });
    }
    recap = value["recap"].trim() || null;
    if (recap && recap.length > OUTBOUND_RECAP_MAX_LENGTH) {
      throw new TeamMutationFailure(
        "invalid",
        `The recap must be ${OUTBOUND_RECAP_MAX_LENGTH.toLocaleString()} characters or fewer.`,
        { fieldErrors: { recap: "Shorten the recap and try again." } },
      );
    }
  }

  let callbackAt: Date | null = null;
  if (value["callbackAt"] !== undefined) {
    const raw = value["callbackAt"];
    if (
      typeof raw !== "string" ||
      !VERSION_PATTERN.test(raw.trim()) ||
      Number.isNaN(Date.parse(raw.trim())) ||
      new Date(raw.trim()).toISOString() !== raw.trim()
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The callback date and time is invalid.",
        { fieldErrors: { callbackAt: "Choose a valid date and time." } },
      );
    }
    callbackAt = new Date(raw.trim());
  }

  if (disposition === "callback_requested") {
    const maximum = now.getTime() + 366 * 24 * 60 * 60 * 1_000;
    if (
      callbackAt === null ||
      callbackAt.getTime() <= now.getTime() ||
      callbackAt.getTime() > maximum
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "A callback must be scheduled in the future, within one year.",
        { fieldErrors: { callbackAt: "Choose a future callback time." } },
      );
    }
  } else if (callbackAt !== null) {
    throw new TeamMutationFailure(
      "invalid",
      "A callback time is only allowed for Callback requested.",
      {
        fieldErrors: {
          callbackAt: "Remove the callback time or change the outcome.",
        },
      },
    );
  }

  return { taskId, disposition, callbackAt, recap };
}

export function parseOutboundBulkPayload(value: unknown): OutboundBulkInput {
  assertExactObject(
    value,
    ["action", "tasks", "assignedToMemberId", "snoozePreset"],
    "The bulk request",
  );
  const rawAction =
    typeof value["action"] === "string"
      ? value["action"].trim().toLowerCase()
      : "";
  if (!BULK_ACTIONS.has(rawAction as OutboundBulkAction)) {
    throw new TeamMutationFailure("invalid", "Choose a valid bulk action.", {
      fieldErrors: { action: "Choose one of the displayed actions." },
    });
  }
  const action = rawAction as OutboundBulkAction;

  if (!Array.isArray(value["tasks"])) {
    throw new TeamMutationFailure(
      "invalid",
      "Select at least one outbound task.",
      {
        fieldErrors: { tasks: "Select at least one row." },
      },
    );
  }
  if (
    value["tasks"].length === 0 ||
    value["tasks"].length > OUTBOUND_BULK_MAX_TASKS
  ) {
    throw new TeamMutationFailure(
      "invalid",
      `Select between 1 and ${OUTBOUND_BULK_MAX_TASKS} outbound tasks.`,
      { fieldErrors: { tasks: "Reduce the selection and try again." } },
    );
  }
  const seen = new Set<string>();
  const tasks = value["tasks"].map((entry, index) => {
    assertExactObject(entry, ["id", "version"], `Task ${index + 1}`);
    const id = parseUuid(entry["id"], `tasks.${index}.id`);
    const version = parseOutboundTaskVersion(
      entry["version"],
      `tasks.${index}.version`,
    );
    if (seen.has(id)) {
      throw new TeamMutationFailure(
        "invalid",
        "The bulk request contains the same task more than once.",
        {
          fieldErrors: {
            tasks: "Refresh the queue and select each task once.",
          },
        },
      );
    }
    seen.add(id);
    return { id, version };
  });

  let assignedToMemberId: string | null = null;
  if (action === "assign" || action === "assign_start") {
    assignedToMemberId = parseUuid(
      value["assignedToMemberId"],
      "assignedToMemberId",
    );
  } else if (value["assignedToMemberId"] !== undefined) {
    throw new TeamMutationFailure(
      "invalid",
      "An assignee is only allowed for an assignment action.",
      { fieldErrors: { assignedToMemberId: "Remove the assignee." } },
    );
  }

  let snoozePreset: OutboundSnoozePreset | null = null;
  if (action === "snooze") {
    const rawPreset =
      typeof value["snoozePreset"] === "string"
        ? value["snoozePreset"].trim().toLowerCase()
        : "";
    if (!SNOOZE_PRESETS.has(rawPreset as OutboundSnoozePreset)) {
      throw new TeamMutationFailure("invalid", "Choose a valid snooze time.", {
        fieldErrors: { snoozePreset: "Choose one of the displayed times." },
      });
    }
    snoozePreset = rawPreset as OutboundSnoozePreset;
  } else if (value["snoozePreset"] !== undefined) {
    throw new TeamMutationFailure(
      "invalid",
      "A snooze time is only allowed for a snooze action.",
      { fieldErrors: { snoozePreset: "Remove the snooze time." } },
    );
  }

  return { action, tasks, assignedToMemberId, snoozePreset };
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

export function requireOutboundExpectedVersion(
  expectedVersion: string | null,
  actualVersion: string,
): void {
  if (expectedVersion === null) {
    throw new TeamMutationFailure(
      "invalid",
      "If-Match is required. Refresh the outbound queue and try again.",
      { fieldErrors: { version: "The task version is missing." } },
    );
  }
  if (expectedVersion !== actualVersion) {
    throw new TeamMutationFailure(
      "conflict",
      "The outbound task selection changed after it was loaded. Refresh and try again.",
      { fieldErrors: { version: "The submitted task version is stale." } },
    );
  }
}

export function nextOutboundTaskVersion(current: Date, now: Date): Date {
  return now.getTime() > current.getTime()
    ? now
    : new Date(current.getTime() + 1);
}

/**
 * Reads the structured campaign key from an outbound task without treating
 * SQL wildcard characters or campaign prefixes as matches. Legacy tasks that
 * predate the field belong to the original property-management campaign.
 */
export function outboundTaskCampaign(notes: string): string {
  const match = notes.match(/(?:^|\n)campaign=([^\n]+)/iu);
  return match?.[1]?.trim() || DEFAULT_OUTBOUND_CAMPAIGN;
}

export async function readOutboundMutationRequest(
  request: NextRequest,
  maximumBytes: number,
): Promise<unknown> {
  try {
    return await readBoundedJsonRequest(request, {
      maximumBytes,
      deadlineMs: 10_000,
    });
  } catch (error) {
    if (error instanceof BoundedJsonRequestError) {
      throw new TeamMutationFailure("invalid", error.message, {
        status: error.status,
        retryable: error.status === 408,
      });
    }
    throw error;
  }
}
