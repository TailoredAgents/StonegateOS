export const OUTBOUND_TIME_ZONE = "America/New_York";

export type TeamMember = { id: string; name: string; active?: boolean };

export type OutboundAccountBrief = {
  summary: string;
  whyFit: string;
  serviceAngle: string;
  bestOpener: string;
  likelyObjections: string[];
  recommendedNextMove: string;
  partnerFit: "portal_first" | "managed_direct" | "hybrid" | "not_a_fit";
  fitScore: number;
  fitReason: string;
  provider: "openai" | "fallback";
  model: string | null;
  updatedAt: string;
};

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

export type OutboundContact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source?: string | null;
  doNotContact: boolean;
  doNotContactAt: string | null;
  doNotContactReason: string | null;
};

export type OutboundQueueItem = {
  id: string;
  title: string | null;
  dueAt: string | null;
  overdue: boolean;
  minutesUntilDue: number | null;
  attempt: number;
  campaign: string | null;
  lastDisposition: string | null;
  company: string | null;
  noteSnippet: string | null;
  startedAt: string | null;
  reminderAt: string | null;
  assignedToMemberId: string;
  primaryTaskId: string;
  primaryTaskVersion: string;
  primaryContactId: string;
  taskIds: string[];
  contactCount: number;
  dncContactCount: number;
  openTaskCount: number;
  account: {
    id: string;
    name: string;
    status: string | null;
    segment: string | null;
    portalFit?: string | null;
    fitScore?: number | null;
    lastTouchAt: string | null;
    nextTouchAt: string | null;
    brief?: OutboundAccountBrief | null;
    history?: OutboundHistoryEntry[];
  };
  contacts: OutboundContact[];
  tasks: Array<{
    id: string;
    version: string;
    title: string | null;
    dueAt: string | null;
    attempt: number;
    lastDisposition: string | null;
    contactId: string;
    contactName: string;
    doNotContact: boolean;
  }>;
};

export type OutboundQueueSummary = {
  dueNow: number;
  overdue: number;
  callbacksToday: number;
  notStarted?: number;
  scoreboard?: {
    accountsTouched: number;
    conversationsStarted: number;
    qualifiedPartners: number;
    activePartners: number;
    avgFitScore: number | null;
    partnerPathMix: {
      portalFirst: number;
      managedDirect: number;
      hybrid: number;
      notAFit: number;
    };
  };
};

export type OutboundQueueFacets = {
  campaigns: string[];
  dispositions: string[];
  attempts: string[];
};

export type OutboundQueueResponse = {
  ok: true;
  memberId: string;
  timezone: typeof OUTBOUND_TIME_ZONE;
  q: string | null;
  snapshotAt: string;
  scope: {
    facets: "assignee_snapshot";
    summary: "filtered_account_snapshot";
    scoreboard: "assignee_campaign_snapshot";
  };
  total: number;
  truncated: false;
  scanLimit: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  nextCursor: string | null;
  previousCursor: string | null;
  summary: OutboundQueueSummary;
  facets: OutboundQueueFacets;
  items: OutboundQueueItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isIsoOrNull(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isAccountBrief(value: unknown): value is OutboundAccountBrief {
  if (!isRecord(value)) return false;
  return (
    isString(value["summary"]) &&
    isString(value["whyFit"]) &&
    isString(value["serviceAngle"]) &&
    isString(value["bestOpener"]) &&
    isStringArray(value["likelyObjections"]) &&
    isString(value["recommendedNextMove"]) &&
    ["portal_first", "managed_direct", "hybrid", "not_a_fit"].includes(
      String(value["partnerFit"]),
    ) &&
    typeof value["fitScore"] === "number" &&
    Number.isFinite(value["fitScore"]) &&
    isString(value["fitReason"]) &&
    (value["provider"] === "openai" || value["provider"] === "fallback") &&
    isStringOrNull(value["model"]) &&
    isIsoOrNull(value["updatedAt"]) &&
    value["updatedAt"] !== null
  );
}

function isHistoryEntry(value: unknown): value is OutboundHistoryEntry {
  if (!isRecord(value)) return false;
  return (
    isString(value["id"]) &&
    isIsoOrNull(value["at"]) &&
    value["at"] !== null &&
    [
      "import",
      "draft",
      "disposition",
      "recap",
      "task",
      "partner",
      "note",
    ].includes(String(value["kind"])) &&
    isString(value["title"]) &&
    isString(value["summary"]) &&
    isStringOrNull(value["contactName"])
  );
}

function isOutboundContact(value: unknown): value is OutboundContact {
  if (!isRecord(value)) return false;
  return (
    isString(value["id"]) &&
    isString(value["name"]) &&
    isStringOrNull(value["email"]) &&
    isStringOrNull(value["phone"]) &&
    (value["source"] === undefined || isStringOrNull(value["source"])) &&
    typeof value["doNotContact"] === "boolean" &&
    isIsoOrNull(value["doNotContactAt"]) &&
    isStringOrNull(value["doNotContactReason"])
  );
}

function isOutboundTask(
  value: unknown,
): value is OutboundQueueItem["tasks"][number] {
  if (!isRecord(value)) return false;
  return (
    isString(value["id"]) &&
    isIsoOrNull(value["version"]) &&
    value["version"] !== null &&
    isStringOrNull(value["title"]) &&
    isIsoOrNull(value["dueAt"]) &&
    isNonNegativeInteger(value["attempt"]) &&
    isStringOrNull(value["lastDisposition"]) &&
    isString(value["contactId"]) &&
    isString(value["contactName"]) &&
    typeof value["doNotContact"] === "boolean"
  );
}

function isOutboundQueueItem(
  value: unknown,
  expectedMemberId: string,
): value is OutboundQueueItem {
  if (!isRecord(value)) return false;
  const contacts = value["contacts"];
  const tasks = value["tasks"];
  const account = value["account"];
  if (
    !Array.isArray(contacts) ||
    contacts.length === 0 ||
    !contacts.every(isOutboundContact) ||
    !Array.isArray(tasks) ||
    tasks.length === 0 ||
    !tasks.every(isOutboundTask) ||
    !isRecord(account)
  ) {
    return false;
  }

  const primaryContactId = value["primaryContactId"];
  const primaryTaskId = value["primaryTaskId"];
  const taskIds = value["taskIds"];
  const contactIds = contacts.map((contact) => contact.id);
  const uniqueContactIds = new Set(contactIds);
  const taskRecordIds = tasks.map((task) => task.id);
  const uniqueTaskIds = new Set(taskRecordIds);
  const primaryTask = tasks.find((task) => task.id === primaryTaskId);
  const dncContactCount = contacts.filter(
    (contact) => contact.doNotContact,
  ).length;
  return (
    isString(value["id"]) &&
    isStringOrNull(value["title"]) &&
    isIsoOrNull(value["dueAt"]) &&
    typeof value["overdue"] === "boolean" &&
    isNullableFiniteNumber(value["minutesUntilDue"]) &&
    isNonNegativeInteger(value["attempt"]) &&
    isStringOrNull(value["campaign"]) &&
    isStringOrNull(value["lastDisposition"]) &&
    isStringOrNull(value["company"]) &&
    isStringOrNull(value["noteSnippet"]) &&
    isIsoOrNull(value["startedAt"]) &&
    isIsoOrNull(value["reminderAt"]) &&
    value["assignedToMemberId"] === expectedMemberId &&
    isString(primaryTaskId) &&
    isIsoOrNull(value["primaryTaskVersion"]) &&
    value["primaryTaskVersion"] !== null &&
    isString(primaryContactId) &&
    isStringArray(taskIds) &&
    taskIds.length === tasks.length &&
    new Set(taskIds).size === taskIds.length &&
    uniqueTaskIds.size === tasks.length &&
    taskIds.every((taskId) => uniqueTaskIds.has(taskId)) &&
    primaryTask?.version === value["primaryTaskVersion"] &&
    primaryTask.contactId === primaryContactId &&
    uniqueContactIds.size === contacts.length &&
    tasks.every(
      (task) =>
        uniqueContactIds.has(task.contactId) &&
        contacts.find((contact) => contact.id === task.contactId)
          ?.doNotContact === task.doNotContact,
    ) &&
    contacts.some((contact) => contact.id === primaryContactId) &&
    value["contactCount"] === contacts.length &&
    value["dncContactCount"] === dncContactCount &&
    value["openTaskCount"] === tasks.length &&
    account["id"] === value["id"] &&
    isString(account["name"]) &&
    isStringOrNull(account["status"]) &&
    isStringOrNull(account["segment"]) &&
    (account["portalFit"] === undefined ||
      isStringOrNull(account["portalFit"])) &&
    (account["fitScore"] === undefined ||
      isNullableFiniteNumber(account["fitScore"])) &&
    isIsoOrNull(account["lastTouchAt"]) &&
    isIsoOrNull(account["nextTouchAt"]) &&
    (account["brief"] === undefined ||
      account["brief"] === null ||
      isAccountBrief(account["brief"])) &&
    (account["history"] === undefined ||
      (Array.isArray(account["history"]) &&
        account["history"].every(isHistoryEntry)))
  );
}

function isSummary(value: unknown): value is OutboundQueueSummary {
  if (!isRecord(value)) return false;
  const scoreboard = value["scoreboard"];
  if (scoreboard !== undefined) {
    if (!isRecord(scoreboard) || !isRecord(scoreboard["partnerPathMix"])) {
      return false;
    }
    const mix = scoreboard["partnerPathMix"];
    if (
      !isNonNegativeInteger(scoreboard["accountsTouched"]) ||
      !isNonNegativeInteger(scoreboard["conversationsStarted"]) ||
      !isNonNegativeInteger(scoreboard["qualifiedPartners"]) ||
      !isNonNegativeInteger(scoreboard["activePartners"]) ||
      !isNullableFiniteNumber(scoreboard["avgFitScore"]) ||
      !isNonNegativeInteger(mix["portalFirst"]) ||
      !isNonNegativeInteger(mix["managedDirect"]) ||
      !isNonNegativeInteger(mix["hybrid"]) ||
      !isNonNegativeInteger(mix["notAFit"])
    ) {
      return false;
    }
  }
  return (
    isNonNegativeInteger(value["dueNow"]) &&
    isNonNegativeInteger(value["overdue"]) &&
    isNonNegativeInteger(value["callbacksToday"]) &&
    (value["notStarted"] === undefined ||
      isNonNegativeInteger(value["notStarted"]))
  );
}

function isFacets(value: unknown): value is OutboundQueueFacets {
  if (!isRecord(value)) return false;
  return (
    isStringArray(value["campaigns"]) &&
    isStringArray(value["dispositions"]) &&
    isStringArray(value["attempts"])
  );
}

function isQueueScope(value: unknown): value is OutboundQueueResponse["scope"] {
  return (
    isRecord(value) &&
    value["facets"] === "assignee_snapshot" &&
    value["summary"] === "filtered_account_snapshot" &&
    value["scoreboard"] === "assignee_campaign_snapshot"
  );
}

export function parseOutboundQueueResponse(
  value: unknown,
): OutboundQueueResponse | null {
  if (!isRecord(value)) return null;
  const memberId = value["memberId"];
  const items = value["items"];
  if (
    value["ok"] !== true ||
    !isString(memberId) ||
    !memberId.trim() ||
    value["timezone"] !== OUTBOUND_TIME_ZONE ||
    !Array.isArray(items) ||
    !items.every((item) => isOutboundQueueItem(item, memberId)) ||
    !isSummary(value["summary"]) ||
    !isFacets(value["facets"]) ||
    !isQueueScope(value["scope"])
  ) {
    return null;
  }
  if (
    !isStringOrNull(value["q"]) ||
    !isIsoOrNull(value["snapshotAt"]) ||
    value["snapshotAt"] === null ||
    !isNonNegativeInteger(value["total"]) ||
    value["truncated"] !== false ||
    !isNonNegativeInteger(value["scanLimit"]) ||
    !isNonNegativeInteger(value["offset"]) ||
    !isNonNegativeInteger(value["limit"]) ||
    value["limit"] === 0 ||
    !(
      value["nextOffset"] === null || isNonNegativeInteger(value["nextOffset"])
    ) ||
    !(
      value["nextCursor"] === null ||
      (isString(value["nextCursor"]) &&
        value["nextCursor"].length > 0 &&
        value["nextCursor"].length <= 1_200)
    ) ||
    !(
      value["previousCursor"] === null ||
      (isString(value["previousCursor"]) &&
        value["previousCursor"].length > 0 &&
        value["previousCursor"].length <= 1_200)
    ) ||
    value["scanLimit"] !== value["total"] ||
    items.length > Number(value["limit"]) ||
    Number(value["offset"]) + items.length > Number(value["total"]) ||
    (value["nextOffset"] === null) !== (value["nextCursor"] === null) ||
    (Number(value["offset"]) === 0) !== (value["previousCursor"] === null)
  ) {
    return null;
  }
  return value as OutboundQueueResponse;
}

const easternTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: OUTBOUND_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

export function formatOutboundEasternTime(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${easternTimeFormatter.format(parsed)} (${OUTBOUND_TIME_ZONE})`;
}
