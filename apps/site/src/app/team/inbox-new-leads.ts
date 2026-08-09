const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const E164_PATTERN = /^\+[1-9][0-9]{9,14}$/u;
const EXACT_ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const FEED_KEYS = [
  "acknowledgementTtlSeconds",
  "generatedAt",
  "next",
  "ok",
  "total",
] as const;
const LEAD_KEYS = [
  "contactId",
  "name",
  "phone",
  "phoneE164",
  "pipelineStage",
  "pipelineVersion",
  "version",
] as const;
const SUCCESS_KEYS = ["data", "ok", "receipt"] as const;
const SUCCESS_DATA_KEYS = [
  "acknowledgedAt",
  "acknowledgementVersion",
  "contactId",
  "expiresAt",
  "leadVersion",
] as const;
const RECEIPT_KEYS = [
  "actorId",
  "auditEventId",
  "committedAt",
  "correlationId",
  "entityId",
  "entityType",
  "operationId",
  "version",
] as const;

export const INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS = 24 * 60 * 60;

export type InboxNewLead = {
  contactId: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  pipelineStage: "new";
  pipelineVersion: string;
  version: string;
};

export type InboxNewLeadFeed = {
  ok: true;
  generatedAt: string;
  acknowledgementTtlSeconds: typeof INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS;
  total: number;
  next: InboxNewLead | null;
};

export type InboxNewLeadAcknowledgement = {
  contactId: string;
  acknowledgedAt: string;
  expiresAt: string;
  acknowledgementVersion: number;
  leadVersion: string;
};

type InboxNewLeadAcknowledgementSuccess = {
  ok: true;
  data: InboxNewLeadAcknowledgement;
  receipt: {
    operationId: string;
    correlationId: string;
    actorId: string;
    committedAt: string;
    auditEventId: string;
    entityType: "inbox_new_lead_acknowledgement";
    entityId: string;
    version: string;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isExactIsoInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    EXACT_ISO_INSTANT_PATTERN.test(value) &&
    !Number.isNaN(new Date(value).getTime()) &&
    new Date(value).toISOString() === value
  );
}

function boundedNullableString(
  value: unknown,
  maximum: number,
): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length > 0 && value.length <= maximum)
  );
}

function parseLead(value: unknown): InboxNewLead | null {
  const lead = record(value);
  if (
    !lead ||
    !hasExactKeys(lead, LEAD_KEYS) ||
    typeof lead["contactId"] !== "string" ||
    !UUID_PATTERN.test(lead["contactId"]) ||
    typeof lead["name"] !== "string" ||
    lead["name"].length < 1 ||
    lead["name"].length > 201 ||
    !boundedNullableString(lead["phone"], 32) ||
    !(
      lead["phoneE164"] === null ||
      (typeof lead["phoneE164"] === "string" &&
        E164_PATTERN.test(lead["phoneE164"]))
    ) ||
    lead["pipelineStage"] !== "new" ||
    !isExactIsoInstant(lead["pipelineVersion"]) ||
    typeof lead["version"] !== "string" ||
    !SHA256_PATTERN.test(lead["version"])
  ) {
    return null;
  }
  return lead as InboxNewLead;
}

export function parseInboxNewLeadFeed(value: unknown): InboxNewLeadFeed | null {
  const payload = record(value);
  if (
    !payload ||
    !hasExactKeys(payload, FEED_KEYS) ||
    payload["ok"] !== true ||
    !isExactIsoInstant(payload["generatedAt"]) ||
    payload["acknowledgementTtlSeconds"] !==
      INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS ||
    typeof payload["total"] !== "number" ||
    !Number.isSafeInteger(payload["total"]) ||
    payload["total"] < 0
  ) {
    return null;
  }

  const next = payload["next"] === null ? null : parseLead(payload["next"]);
  if (
    (payload["next"] !== null && next === null) ||
    (payload["total"] === 0) !== (next === null)
  ) {
    return null;
  }
  return { ...payload, next } as InboxNewLeadFeed;
}

export function parseInboxNewLeadAcknowledgementSuccess(
  value: unknown,
  expected: {
    contactId: string;
    leadVersion: string;
    actorId: string;
  },
): InboxNewLeadAcknowledgementSuccess | null {
  const payload = record(value);
  const data = record(payload?.["data"]);
  const receipt = record(payload?.["receipt"]);
  if (
    !payload ||
    !hasExactKeys(payload, SUCCESS_KEYS) ||
    payload["ok"] !== true ||
    !data ||
    !hasExactKeys(data, SUCCESS_DATA_KEYS) ||
    data["contactId"] !== expected.contactId ||
    !isExactIsoInstant(data["acknowledgedAt"]) ||
    !isExactIsoInstant(data["expiresAt"]) ||
    new Date(data["expiresAt"]).getTime() -
      new Date(data["acknowledgedAt"]).getTime() !==
      INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS * 1_000 ||
    typeof data["acknowledgementVersion"] !== "number" ||
    !Number.isSafeInteger(data["acknowledgementVersion"]) ||
    data["acknowledgementVersion"] < 1 ||
    data["leadVersion"] !== expected.leadVersion ||
    !receipt ||
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    typeof receipt["operationId"] !== "string" ||
    !UUID_PATTERN.test(receipt["operationId"]) ||
    typeof receipt["correlationId"] !== "string" ||
    !UUID_PATTERN.test(receipt["correlationId"]) ||
    receipt["actorId"] !== expected.actorId ||
    !isExactIsoInstant(receipt["committedAt"]) ||
    receipt["committedAt"] !== data["acknowledgedAt"] ||
    typeof receipt["auditEventId"] !== "string" ||
    !UUID_PATTERN.test(receipt["auditEventId"]) ||
    receipt["entityType"] !== "inbox_new_lead_acknowledgement" ||
    typeof receipt["entityId"] !== "string" ||
    !UUID_PATTERN.test(receipt["entityId"]) ||
    receipt["version"] !== String(data["acknowledgementVersion"])
  ) {
    return null;
  }
  return payload as InboxNewLeadAcknowledgementSuccess;
}
