const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1600}$/u;

export const TEAM_SALES_ACTIVITY_ACTIONS = [
  "call.started",
  "message.received",
  "message.queued",
  "message.retry",
  "sales.escalation.call.started",
  "sales.escalation.call.dispatched",
  "sales.escalation.call.connected",
  "sales.escalation.call.not_connected",
  "sales.escalation.call.not_dispatched",
  "sales.escalation.call.reconciliation_required",
  "sales.touch.manual",
  "sales.disposition.set",
  "sales.autopilot.draft_created",
  "sales.autopilot.autosend",
  "sales.agent.draft.prepared",
  "sales.agent.draft.reused",
  "sales.agent.draft.skipped",
  "sales.agent.autosend.queued",
  "sales.agent.autosend.skipped",
  "inbox.alert.sent",
  "inbox.alert.failed",
  "crm.reminder.created",
  "crm.reminder.updated",
  "crm.reminder.completed",
  "crm.reminder.sent",
  "crm.reminder.failed",
] as const;

const ACTIONS = new Set<string>(TEAM_SALES_ACTIVITY_ACTIONS);
const ACTOR_TYPES = new Set(["human", "ai", "system", "worker"]);
const EVENT_KEYS = [
  "action",
  "actor",
  "context",
  "createdAt",
  "entityType",
  "id",
  "outcome",
] as const;
const ACTOR_KEYS = ["id", "label", "name", "role", "type"] as const;
const CONTEXT_KEYS = [
  "actionType",
  "callRecordId",
  "channel",
  "contactId",
  "leadId",
  "taskId",
  "terminalOutcome",
  "threadId",
] as const;
const PAGE_KEYS = [
  "asOf",
  "complete",
  "hasNewer",
  "hasOlder",
  "limit",
  "newerCursor",
  "olderCursor",
  "order",
  "position",
  "returned",
  "snapshot",
  "state",
  "totalAtSnapshot",
  "version",
  "windowStart",
] as const;
const PAYLOAD_KEYS = [
  "actions",
  "events",
  "memberId",
  "ok",
  "page",
  "rangeDays",
  "since",
  "supervisor",
] as const;

export type TeamSalesActivityEvent = {
  id: string;
  action: string;
  entityType: string;
  outcome: string;
  createdAt: string;
  actor: {
    type: string;
    id: string | null;
    role: string | null;
    label: string | null;
    name: string | null;
  };
  context: {
    contactId: string | null;
    leadId: string | null;
    threadId: string | null;
    callRecordId: string | null;
    taskId: string | null;
    channel: string | null;
    actionType: string | null;
    terminalOutcome: string | null;
  };
};

export type TeamSalesActivityPage = {
  version: 1;
  state: "empty" | "available";
  complete: true;
  order: "newest_to_oldest";
  position: "newest" | "history";
  limit: number;
  returned: number;
  totalAtSnapshot: number;
  windowStart: string;
  asOf: string;
  snapshot: { createdAt: string; id: string } | null;
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor: string | null;
  newerCursor: string | null;
};

export type TeamSalesActivityPayload = {
  ok: true;
  rangeDays: number;
  since: string;
  memberId: string | null;
  actions: string[];
  events: TeamSalesActivityEvent[];
  page: TeamSalesActivityPage;
  supervisor: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length && expected.every((key) => key in value)
  );
}

function isExactIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) return false;
  const millisecondIso = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
  const parsed = new Date(millisecondIso);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString() === millisecondIso
  );
}

function normalizedInstant(value: string): string {
  const match = ISO_INSTANT_PATTERN.exec(value);
  return match ? `${match[1]}.${match[2]!.padEnd(6, "0")}Z` : value;
}

function nullableString(value: unknown, maximum = 200): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length > 0 && value.length <= maximum)
  );
}

function nullableUuid(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && UUID_PATTERN.test(value))
  );
}

function parseEvent(value: unknown): TeamSalesActivityEvent | null {
  const event = record(value);
  if (!event || !hasExactKeys(event, EVENT_KEYS)) return null;
  const actor = record(event["actor"]);
  const context = record(event["context"]);
  if (
    typeof event["id"] !== "string" ||
    !UUID_PATTERN.test(event["id"]) ||
    typeof event["action"] !== "string" ||
    !ACTIONS.has(event["action"]) ||
    typeof event["entityType"] !== "string" ||
    event["entityType"].length < 1 ||
    event["entityType"].length > 80 ||
    typeof event["outcome"] !== "string" ||
    !["attempted", "succeeded", "denied", "failed"].includes(
      event["outcome"],
    ) ||
    !isExactIsoInstant(event["createdAt"]) ||
    !actor ||
    !hasExactKeys(actor, ACTOR_KEYS) ||
    typeof actor["type"] !== "string" ||
    !ACTOR_TYPES.has(actor["type"]) ||
    !nullableUuid(actor["id"]) ||
    !nullableString(actor["role"], 80) ||
    !nullableString(actor["label"], 160) ||
    !nullableString(actor["name"], 160) ||
    !context ||
    !hasExactKeys(context, CONTEXT_KEYS) ||
    !nullableUuid(context["contactId"]) ||
    !nullableUuid(context["leadId"]) ||
    !nullableUuid(context["threadId"]) ||
    !nullableUuid(context["callRecordId"]) ||
    !nullableUuid(context["taskId"]) ||
    !nullableString(context["channel"], 32) ||
    !nullableString(context["actionType"], 80) ||
    !nullableString(context["terminalOutcome"], 40)
  ) {
    return null;
  }
  return event as TeamSalesActivityEvent;
}

export function parseTeamSalesActivityPage(
  value: unknown,
  eventCount: number,
): TeamSalesActivityPage | null {
  const page = record(value);
  if (
    !page ||
    !hasExactKeys(page, PAGE_KEYS) ||
    page["version"] !== 1 ||
    page["complete"] !== true ||
    page["order"] !== "newest_to_oldest" ||
    (page["state"] !== "empty" && page["state"] !== "available") ||
    (page["position"] !== "newest" && page["position"] !== "history") ||
    typeof page["limit"] !== "number" ||
    !Number.isSafeInteger(page["limit"]) ||
    page["limit"] < 1 ||
    page["limit"] > 200 ||
    typeof page["returned"] !== "number" ||
    !Number.isSafeInteger(page["returned"]) ||
    page["returned"] !== eventCount ||
    page["returned"] < 0 ||
    page["returned"] > page["limit"] ||
    typeof page["totalAtSnapshot"] !== "number" ||
    !Number.isSafeInteger(page["totalAtSnapshot"]) ||
    page["totalAtSnapshot"] < page["returned"] ||
    !isExactIsoInstant(page["windowStart"]) ||
    !isExactIsoInstant(page["asOf"]) ||
    normalizedInstant(page["windowStart"]) > normalizedInstant(page["asOf"]) ||
    typeof page["hasOlder"] !== "boolean" ||
    typeof page["hasNewer"] !== "boolean" ||
    !(
      page["olderCursor"] === null ||
      (typeof page["olderCursor"] === "string" &&
        CURSOR_PATTERN.test(page["olderCursor"]))
    ) ||
    !(
      page["newerCursor"] === null ||
      (typeof page["newerCursor"] === "string" &&
        CURSOR_PATTERN.test(page["newerCursor"]))
    ) ||
    page["hasOlder"] !== (page["olderCursor"] !== null) ||
    page["hasNewer"] !== (page["newerCursor"] !== null)
  ) {
    return null;
  }

  const snapshot = record(page["snapshot"]);
  if (page["state"] === "empty") {
    if (
      page["returned"] !== 0 ||
      page["totalAtSnapshot"] !== 0 ||
      page["position"] !== "newest" ||
      page["snapshot"] !== null ||
      page["hasOlder"] ||
      page["hasNewer"]
    ) {
      return null;
    }
  } else if (
    page["returned"] < 1 ||
    !snapshot ||
    !hasExactKeys(snapshot, ["createdAt", "id"]) ||
    !isExactIsoInstant(snapshot["createdAt"]) ||
    typeof snapshot["id"] !== "string" ||
    !UUID_PATTERN.test(snapshot["id"]) ||
    normalizedInstant(snapshot["createdAt"]) <
      normalizedInstant(page["windowStart"]) ||
    normalizedInstant(snapshot["createdAt"]) > normalizedInstant(page["asOf"])
  ) {
    return null;
  }
  if (page["position"] === "newest" && page["hasNewer"]) return null;
  return page as TeamSalesActivityPage;
}

export function parseTeamSalesActivityPayload(
  value: unknown,
): TeamSalesActivityPayload | null {
  const payload = record(value);
  if (!payload || !hasExactKeys(payload, PAYLOAD_KEYS)) return null;
  const rawEvents = payload["events"];
  if (
    payload["ok"] !== true ||
    typeof payload["rangeDays"] !== "number" ||
    !Number.isSafeInteger(payload["rangeDays"]) ||
    payload["rangeDays"] < 1 ||
    payload["rangeDays"] > 90 ||
    !isExactIsoInstant(payload["since"]) ||
    !nullableUuid(payload["memberId"]) ||
    !Array.isArray(payload["actions"]) ||
    payload["actions"].length < 1 ||
    payload["actions"].length > TEAM_SALES_ACTIVITY_ACTIONS.length ||
    payload["actions"].some(
      (action) => typeof action !== "string" || !ACTIONS.has(action),
    ) ||
    new Set(payload["actions"]).size !== payload["actions"].length ||
    !Array.isArray(rawEvents) ||
    !record(payload["supervisor"])
  ) {
    return null;
  }
  const events = rawEvents.map(parseEvent);
  if (events.some((event) => event === null)) return null;
  const page = parseTeamSalesActivityPage(payload["page"], events.length);
  if (
    !page ||
    normalizedInstant(payload["since"]) !==
      normalizedInstant(page.windowStart) ||
    new Date(page.asOf).getTime() - new Date(page.windowStart).getTime() !==
      payload["rangeDays"] * 86_400_000
  ) {
    return null;
  }

  const typedEvents = events as TeamSalesActivityEvent[];
  for (let index = 0; index < typedEvents.length; index += 1) {
    const event = typedEvents[index]!;
    if (
      !payload["actions"].includes(event.action) ||
      normalizedInstant(event.createdAt) <
        normalizedInstant(page.windowStart) ||
      normalizedInstant(event.createdAt) > normalizedInstant(page.asOf) ||
      (index > 0 &&
        (normalizedInstant(typedEvents[index - 1]!.createdAt) <
          normalizedInstant(event.createdAt) ||
          (normalizedInstant(typedEvents[index - 1]!.createdAt) ===
            normalizedInstant(event.createdAt) &&
            typedEvents[index - 1]!.id.localeCompare(event.id) <= 0)))
    ) {
      return null;
    }
  }
  if (
    page.state === "available" &&
    page.position === "newest" &&
    (typedEvents[0]!.id !== page.snapshot!.id ||
      normalizedInstant(typedEvents[0]!.createdAt) !==
        normalizedInstant(page.snapshot!.createdAt))
  ) {
    return null;
  }

  return {
    ok: true,
    rangeDays: payload["rangeDays"],
    since: payload["since"],
    memberId: payload["memberId"],
    actions: payload["actions"] as string[],
    events: typedEvents,
    page,
    supervisor: payload["supervisor"] as Record<string, unknown>,
  };
}
