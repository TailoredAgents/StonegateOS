export const PARTNER_APPROVAL_STATES = [
  "pending",
  "approved",
  "declined",
  "expired",
  "approved_needs_reschedule",
  "withdrawn",
] as const;

export type PartnerApprovalState = (typeof PARTNER_APPROVAL_STATES)[number];
export type PartnerApprovalDecision = "approved" | "declined";

export type PartnerApprovalMoney = {
  amountMinor: number;
  currency: string;
  minorUnit: number;
};

export type PartnerApprovalSummary = {
  id: string;
  state: PartnerApprovalState;
  target: {
    kind: "booking" | "booking_draft";
    id: string;
  };
  requestedByCurrentMember: boolean;
  requester: {
    displayName: string;
    roleKey: string | null;
    byCurrentMember: boolean;
  };
  requiredDecisionCount: number;
  decisionCounts: {
    approved: number;
    declined: number;
  };
  currentMemberDecision: PartnerApprovalDecision | null;
  expiresAt: string | null;
  resolvedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  etag: string;
};

export type PartnerApprovalRule = {
  id: string;
  name: string;
  version: number;
  requiredApproverCapabilities: string[];
  requiredApproverRoleKeys: string[];
  requiredDecisionCount: number;
};

export type PartnerApprovalDecisionRecord = {
  id: string;
  decision: PartnerApprovalDecision;
  reason: string | null;
  roleKey: string | null;
  byCurrentMember: boolean;
  createdAt: string;
};

export type PartnerApprovalRequestSnapshot = {
  serviceKey?: string;
  serviceType?: string;
  poNumber?: string;
  costCenter?: string;
  scheduledStartAt?: string;
  scheduledEndAt?: string;
  description?: string;
  notes?: string;
  amount?: PartnerApprovalMoney;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
};

export type PartnerApprovalDetail = PartnerApprovalSummary & {
  rulesValid: boolean;
  rules: PartnerApprovalRule[];
  request: PartnerApprovalRequestSnapshot;
  decisions: PartnerApprovalDecisionRecord[];
};

export type PartnerApprovalDecisionBlockReason =
  | "ready"
  | "not_pending"
  | "self_approval"
  | "already_decided";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/u;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestampOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 64) return false;
  return Number.isFinite(new Date(value).getTime());
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isApprovalDecision(value: unknown): value is PartnerApprovalDecision {
  return value === "approved" || value === "declined";
}

function isApprovalMoney(value: unknown): value is PartnerApprovalMoney {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value["amountMinor"]) &&
    typeof value["currency"] === "string" &&
    CURRENCY_PATTERN.test(value["currency"]) &&
    Number.isSafeInteger(value["minorUnit"]) &&
    Number(value["minorUnit"]) >= 0 &&
    Number(value["minorUnit"]) <= 4
  );
}

function isApprovalSummaryFields(
  value: unknown,
): value is PartnerApprovalSummary {
  if (!isRecord(value)) return false;
  const target = value["target"];
  const counts = value["decisionCounts"];
  const requester = value["requester"];
  return (
    typeof value["id"] === "string" &&
    UUID_PATTERN.test(value["id"]) &&
    typeof value["state"] === "string" &&
    (PARTNER_APPROVAL_STATES as readonly string[]).includes(value["state"]) &&
    isRecord(target) &&
    (target["kind"] === "booking" || target["kind"] === "booking_draft") &&
    typeof target["id"] === "string" &&
    UUID_PATTERN.test(target["id"]) &&
    typeof value["requestedByCurrentMember"] === "boolean" &&
    isRecord(requester) &&
    typeof requester["displayName"] === "string" &&
    requester["displayName"].length > 0 &&
    requester["displayName"].length <= 160 &&
    (requester["roleKey"] === null ||
      (typeof requester["roleKey"] === "string" &&
        ROLE_KEY_PATTERN.test(requester["roleKey"]))) &&
    typeof requester["byCurrentMember"] === "boolean" &&
    requester["byCurrentMember"] === value["requestedByCurrentMember"] &&
    isPositiveInteger(value["requiredDecisionCount"]) &&
    isRecord(counts) &&
    isNonNegativeInteger(counts["approved"]) &&
    isNonNegativeInteger(counts["declined"]) &&
    (value["currentMemberDecision"] === null ||
      isApprovalDecision(value["currentMemberDecision"])) &&
    isTimestampOrNull(value["expiresAt"]) &&
    isTimestampOrNull(value["resolvedAt"]) &&
    isPositiveInteger(value["revision"]) &&
    isTimestampOrNull(value["createdAt"]) &&
    value["createdAt"] !== null &&
    isTimestampOrNull(value["updatedAt"]) &&
    value["updatedAt"] !== null &&
    typeof value["etag"] === "string" &&
    value["etag"].length > 0 &&
    value["etag"].length <= 512
  );
}

function isApprovalRule(value: unknown): value is PartnerApprovalRule {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    value["id"].length > 0 &&
    value["id"].length <= 160 &&
    typeof value["name"] === "string" &&
    value["name"].length > 0 &&
    value["name"].length <= 160 &&
    isPositiveInteger(value["version"]) &&
    Array.isArray(value["requiredApproverCapabilities"]) &&
    value["requiredApproverCapabilities"].length > 0 &&
    value["requiredApproverCapabilities"].length <= 20 &&
    value["requiredApproverCapabilities"].every(
      (capability) =>
        typeof capability === "string" && CAPABILITY_PATTERN.test(capability),
    ) &&
    new Set(value["requiredApproverCapabilities"]).size ===
      value["requiredApproverCapabilities"].length &&
    Array.isArray(value["requiredApproverRoleKeys"]) &&
    value["requiredApproverRoleKeys"].length <= 20 &&
    value["requiredApproverRoleKeys"].every(
      (role) => typeof role === "string" && ROLE_KEY_PATTERN.test(role),
    ) &&
    new Set(value["requiredApproverRoleKeys"]).size ===
      value["requiredApproverRoleKeys"].length &&
    isPositiveInteger(value["requiredDecisionCount"])
  );
}

function isApprovalDecisionRecord(
  value: unknown,
): value is PartnerApprovalDecisionRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    UUID_PATTERN.test(value["id"]) &&
    isApprovalDecision(value["decision"]) &&
    (value["reason"] === null ||
      (typeof value["reason"] === "string" &&
        value["reason"].length <= 1_000)) &&
    (value["roleKey"] === null ||
      (typeof value["roleKey"] === "string" &&
        ROLE_KEY_PATTERN.test(value["roleKey"]))) &&
    typeof value["byCurrentMember"] === "boolean" &&
    isTimestampOrNull(value["createdAt"]) &&
    value["createdAt"] !== null
  );
}

function isApprovalRequestSnapshot(
  value: unknown,
): value is PartnerApprovalRequestSnapshot {
  if (!isRecord(value)) return false;
  const amount = value["amount"];
  const address = value["address"];
  const optionalTextKeys = [
    "serviceKey",
    "serviceType",
    "poNumber",
    "costCenter",
    "description",
    "notes",
  ] as const;
  const optionalTimestampKeys = ["scheduledStartAt", "scheduledEndAt"] as const;
  const allowedKeys = new Set([
    ...optionalTextKeys,
    ...optionalTimestampKeys,
    "amount",
    "address",
  ]);
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    optionalTextKeys.some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== "string" || value[key].length > 2_000),
    ) ||
    optionalTimestampKeys.some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== "string" ||
          !Number.isFinite(new Date(value[key]).getTime())),
    )
  ) {
    return false;
  }
  if (address !== undefined) {
    if (!isRecord(address)) return false;
    for (const key of [
      "line1",
      "line2",
      "city",
      "state",
      "postalCode",
      "country",
    ]) {
      if (
        address[key] !== undefined &&
        (typeof address[key] !== "string" || address[key].length > 160)
      ) {
        return false;
      }
    }
  }
  return (
    (amount === undefined || isApprovalMoney(amount)) &&
    (address === undefined || isRecord(address))
  );
}

export function isPartnerApprovalSummary(
  value: unknown,
): value is PartnerApprovalSummary {
  return isApprovalSummaryFields(value);
}

export function isPartnerApprovalDetail(
  value: unknown,
): value is PartnerApprovalDetail {
  if (!isApprovalSummaryFields(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return (
    typeof record["rulesValid"] === "boolean" &&
    Array.isArray(record["rules"]) &&
    record["rules"].every(isApprovalRule) &&
    isApprovalRequestSnapshot(record["request"]) &&
    Array.isArray(record["decisions"]) &&
    record["decisions"].every(isApprovalDecisionRecord)
  );
}

export function approvalDecisionAvailability(
  approval: Pick<
    PartnerApprovalSummary,
    "state" | "requestedByCurrentMember" | "currentMemberDecision" | "expiresAt"
  >,
): { allowed: boolean; reason: PartnerApprovalDecisionBlockReason } {
  if (approval.state !== "pending") {
    return { allowed: false, reason: "not_pending" };
  }
  if (approval.requestedByCurrentMember) {
    return { allowed: false, reason: "self_approval" };
  }
  if (approval.currentMemberDecision) {
    return { allowed: false, reason: "already_decided" };
  }
  return { allowed: true, reason: "ready" };
}

export function isApprovalHoldExpired(
  expiresAt: string | null,
  now = new Date(),
): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt);
  return Number.isFinite(expiry.getTime()) && expiry.getTime() <= now.getTime();
}

export function approvalDecisionErrorMessage(
  error: string,
  status: number,
): string {
  if (error === "hold_expired" || status === 410) {
    return "The approval hold expired before this decision was saved. The request now needs a new arrival window; no slot is being promised.";
  }
  if (error === "revision_mismatch" || status === 412) {
    return "This approval changed after you opened it. Review the refreshed request before making a decision.";
  }
  if (error === "conflict" || status === 409) {
    return "This approval was already changed or its hold expired. Review the refreshed state before trying again.";
  }
  if (error === "forbidden" || status === 403) {
    return "This account role cannot make this decision, or the request requires a different approver. No decision was recorded.";
  }
  if (error === "rate_limited" || status === 429) {
    return "Too many approval attempts were made. Wait a moment, then retry the same decision.";
  }
  return "The decision was not saved. The request is unchanged; refresh and try again.";
}

export function formatApprovalDate(
  value: string | null,
  options?: { timezone?: string; includeTime?: boolean },
): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not set";
  const timezone = options?.timezone ?? "America/New_York";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      ...(options?.includeTime === false ? {} : { timeStyle: "short" }),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      ...(options?.includeTime === false ? {} : { timeStyle: "short" }),
    }).format(date);
  }
}

export function formatApprovalMoney(value: PartnerApprovalMoney): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: value.currency,
    }).format(value.amountMinor / 10 ** value.minorUnit);
  } catch {
    return `${value.currency} ${(
      value.amountMinor /
      10 ** value.minorUnit
    ).toFixed(value.minorUnit)}`;
  }
}

export function approvalStateLabel(state: PartnerApprovalState): string {
  switch (state) {
    case "approved_needs_reschedule":
      return "Approved · reschedule needed";
    case "pending":
      return "Decision needed";
    default:
      return state
        .replaceAll("_", " ")
        .replace(/\b\w/gu, (letter) => letter.toUpperCase());
  }
}

export function humanizeApprovalValue(
  value: string | null | undefined,
): string {
  if (!value) return "Not provided";
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
