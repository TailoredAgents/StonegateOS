export type OutboundImportRowStatus =
  | "create"
  | "update"
  | "unchanged"
  | "invalid"
  | "duplicate"
  | "conflict";

export type OutboundImportPlannedChange =
  | "contact.create"
  | "contact.email"
  | "contact.phone"
  | "contact.company"
  | "contact.first_name"
  | "contact.last_name"
  | "contact.source"
  | "contact.assignee"
  | "contact.partner_status"
  | "contact.partner_owner"
  | "contact_note.create"
  | "partner.resolve_and_link"
  | "pipeline.create"
  | "task.create";

export type OutboundImportCounts = {
  total: number;
  accepted: number;
  create: number;
  update: number;
  unchanged: number;
  invalid: number;
  duplicate: number;
  conflict: number;
};

export type OutboundImportRow = {
  rowNumber: number;
  status: OutboundImportRowStatus;
  reason: string | null;
  duplicateOfRow: number | null;
  existingContactId: string | null;
  company: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  plannedChanges: OutboundImportPlannedChange[];
};

export type OutboundImportReport = {
  rowCount: number;
  truncated: false;
  filename: string;
  csv: string;
};

export type OutboundImportPreview = {
  kind: "outbound_import_preview";
  requestHash: string;
  previewHash: string;
  campaign: string;
  assignee: { id: string; name: string };
  byteLength: number;
  ignoredHeaders: string[];
  counts: OutboundImportCounts;
  confirmationPhrase: string;
  rows: OutboundImportRow[];
  exclusionReport: OutboundImportReport;
};

export type OutboundImportSuccess = {
  ok: true;
  data: {
    kind: "outbound_import_result";
    requestHash: string;
    previewHash: string;
    campaign: string;
    assignee: { id: string; name: string };
    counts: OutboundImportCounts & {
      rowsUpdated: number;
      contactsCreated: number;
      contactsModified: number;
      partnerAccountsResolved: number;
      partnerLinksCreated: number;
      contactNotesCreated: number;
      tasksCreated: number;
      pipelineRowsCreated: number;
    };
    exclusionReport: OutboundImportReport;
  };
  receipt: {
    operationId: string;
    correlationId: string;
    actorId: string;
    committedAt: string;
    auditEventId: string;
    entityType: "outbound_import";
    entityId: string;
    version: string;
  };
};

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const STATUS = new Set<OutboundImportRowStatus>([
  "create",
  "update",
  "unchanged",
  "invalid",
  "duplicate",
  "conflict",
]);
const PLANNED_CHANGES = new Set<OutboundImportPlannedChange>([
  "contact.create",
  "contact.email",
  "contact.phone",
  "contact.company",
  "contact.first_name",
  "contact.last_name",
  "contact.source",
  "contact.assignee",
  "contact.partner_status",
  "contact.partner_owner",
  "contact_note.create",
  "partner.resolve_and_link",
  "pipeline.create",
  "task.create",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseCounts(value: unknown): OutboundImportCounts | null {
  if (!isRecord(value)) return null;
  const keys = [
    "total",
    "accepted",
    "create",
    "update",
    "unchanged",
    "invalid",
    "duplicate",
    "conflict",
  ] as const;
  if (!keys.every((key) => nonnegativeInteger(value[key]))) return null;
  const counts = value as unknown as OutboundImportCounts;
  if (counts.accepted !== counts.create + counts.update) return null;
  if (
    counts.total !==
    counts.create +
      counts.update +
      counts.unchanged +
      counts.invalid +
      counts.duplicate +
      counts.conflict
  ) {
    return null;
  }
  return counts;
}

function parseReport(
  value: unknown,
  expectedRows: number,
): OutboundImportReport | null {
  if (!isRecord(value)) return null;
  if (
    value["truncated"] !== false ||
    value["rowCount"] !== expectedRows ||
    !nonempty(value["filename"]) ||
    !value["filename"].endsWith(".csv") ||
    typeof value["csv"] !== "string" ||
    !value["csv"].startsWith('"row_number","status","reason"')
  ) {
    return null;
  }
  const physicalLines = value["csv"].split("\r\n");
  if (
    physicalLines.at(-1) !== "" ||
    physicalLines.length !== expectedRows + 2
  ) {
    return null;
  }
  return value as unknown as OutboundImportReport;
}

function parseRow(value: unknown): OutboundImportRow | null {
  if (!isRecord(value)) return null;
  const status = value["status"];
  if (
    !nonnegativeInteger(value["rowNumber"]) ||
    Number(value["rowNumber"]) < 2 ||
    typeof status !== "string" ||
    !STATUS.has(status as OutboundImportRowStatus) ||
    !nullableString(value["reason"]) ||
    !(
      value["duplicateOfRow"] === null ||
      (nonnegativeInteger(value["duplicateOfRow"]) &&
        Number(value["duplicateOfRow"]) >= 2)
    ) ||
    !nullableString(value["existingContactId"]) ||
    !nullableString(value["company"]) ||
    !nullableString(value["contactName"]) ||
    !nullableString(value["email"]) ||
    !nullableString(value["phone"]) ||
    !Array.isArray(value["plannedChanges"]) ||
    !value["plannedChanges"].every(
      (change) =>
        typeof change === "string" &&
        PLANNED_CHANGES.has(change as OutboundImportPlannedChange),
    ) ||
    new Set(value["plannedChanges"]).size !== value["plannedChanges"].length ||
    ((status === "create" || status === "update") &&
      value["plannedChanges"].length === 0) ||
    ((status === "unchanged" ||
      status === "invalid" ||
      status === "duplicate" ||
      status === "conflict") &&
      value["plannedChanges"].length !== 0) ||
    (status === "create" &&
      !value["plannedChanges"].includes("contact.create")) ||
    (status !== "create" && value["plannedChanges"].includes("contact.create"))
  ) {
    return null;
  }
  return value as unknown as OutboundImportRow;
}

export function parseOutboundImportPreviewEnvelope(
  value: unknown,
): OutboundImportPreview | null {
  if (!isRecord(value) || value["ok"] !== true || !isRecord(value["preview"])) {
    return null;
  }
  const preview = value["preview"];
  const counts = parseCounts(preview["counts"]);
  const rows = Array.isArray(preview["rows"])
    ? preview["rows"].map(parseRow)
    : [];
  if (
    preview["kind"] !== "outbound_import_preview" ||
    typeof preview["requestHash"] !== "string" ||
    !HASH_PATTERN.test(preview["requestHash"]) ||
    typeof preview["previewHash"] !== "string" ||
    !HASH_PATTERN.test(preview["previewHash"]) ||
    !nonempty(preview["campaign"]) ||
    !isRecord(preview["assignee"]) ||
    !nonempty(preview["assignee"]["id"]) ||
    !nonempty(preview["assignee"]["name"]) ||
    !nonnegativeInteger(preview["byteLength"]) ||
    !Array.isArray(preview["ignoredHeaders"]) ||
    !preview["ignoredHeaders"].every((header) => typeof header === "string") ||
    !counts ||
    rows.some((row) => row === null) ||
    rows.length !== counts.total ||
    preview["confirmationPhrase"] !== `IMPORT ${counts.accepted}`
  ) {
    return null;
  }
  const excluded = counts.invalid + counts.duplicate + counts.conflict;
  if (!parseReport(preview["exclusionReport"], excluded)) return null;
  return preview as unknown as OutboundImportPreview;
}

export function parseOutboundImportMutationSuccess(
  value: unknown,
  expectedPreviewHash: string,
): OutboundImportSuccess | null {
  if (
    !HASH_PATTERN.test(expectedPreviewHash) ||
    !isRecord(value) ||
    value["ok"] !== true ||
    !isRecord(value["data"]) ||
    !isRecord(value["receipt"])
  ) {
    return null;
  }
  const data = value["data"];
  const receipt = value["receipt"];
  const rawCounts = data["counts"];
  const counts = parseCounts(rawCounts);
  if (
    data["kind"] !== "outbound_import_result" ||
    typeof data["requestHash"] !== "string" ||
    !HASH_PATTERN.test(data["requestHash"]) ||
    data["previewHash"] !== expectedPreviewHash ||
    !nonempty(data["campaign"]) ||
    !isRecord(data["assignee"]) ||
    !nonempty(data["assignee"]["id"]) ||
    !nonempty(data["assignee"]["name"]) ||
    !counts ||
    !isRecord(rawCounts) ||
    !nonnegativeInteger(rawCounts["rowsUpdated"]) ||
    !nonnegativeInteger(rawCounts["contactsCreated"]) ||
    !nonnegativeInteger(rawCounts["contactsModified"]) ||
    !nonnegativeInteger(rawCounts["partnerAccountsResolved"]) ||
    !nonnegativeInteger(rawCounts["partnerLinksCreated"]) ||
    !nonnegativeInteger(rawCounts["contactNotesCreated"]) ||
    !nonnegativeInteger(rawCounts["tasksCreated"]) ||
    !nonnegativeInteger(rawCounts["pipelineRowsCreated"]) ||
    rawCounts["rowsUpdated"] !== counts.update ||
    rawCounts["contactsCreated"] !== counts.create ||
    Number(rawCounts["contactsModified"]) > counts.update ||
    Number(rawCounts["partnerAccountsResolved"]) > counts.accepted ||
    Number(rawCounts["partnerLinksCreated"]) > counts.accepted ||
    Number(rawCounts["contactNotesCreated"]) > counts.create ||
    Number(rawCounts["tasksCreated"]) > counts.accepted ||
    Number(rawCounts["pipelineRowsCreated"]) > counts.accepted ||
    !parseReport(
      data["exclusionReport"],
      counts.invalid + counts.duplicate + counts.conflict,
    ) ||
    !nonempty(receipt["operationId"]) ||
    !nonempty(receipt["correlationId"]) ||
    !nonempty(receipt["actorId"]) ||
    !nonempty(receipt["auditEventId"]) ||
    !nonempty(receipt["committedAt"]) ||
    !Number.isFinite(Date.parse(receipt["committedAt"])) ||
    receipt["entityType"] !== "outbound_import" ||
    receipt["entityId"] !== expectedPreviewHash ||
    receipt["version"] !== expectedPreviewHash
  ) {
    return null;
  }
  return value as unknown as OutboundImportSuccess;
}
