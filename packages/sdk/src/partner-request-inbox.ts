export const PARTNER_REQUEST_KINDS = [
  "service",
  "reschedule",
  "cancellation",
  "change",
  "billing",
  "address",
] as const;
export type PartnerRequestKind = (typeof PARTNER_REQUEST_KINDS)[number];
export const PARTNER_REQUEST_STAGES = [
  "needs_attention",
  "waiting_on_client",
  "handled",
] as const;
export type PartnerRequestStage = (typeof PARTNER_REQUEST_STAGES)[number];

export type PartnerRequestInboxItem = {
  id: string;
  key: string;
  kind: PartnerRequestKind;
  accountId: string;
  accountName: string;
  jobId: string | null;
  service: string;
  description: string;
  siteName: string;
  address: string;
  requesterName: string;
  preferredWindows: Array<{
    localDate: string;
    timeOfDay: string;
    timezone: string;
  }>;
  receivedAt: string;
  state: string;
  stage: PartnerRequestStage;
  statusLabel: string;
  detailHref: string;
  canAct: boolean;
  canAcknowledge: boolean;
  alertGroupId: string | null;
  isNew: boolean;
};

export type PartnerRequestInboxCounts = {
  needsAttention: number;
  waitingOnClient: number;
  handled: number;
  byKind: Record<PartnerRequestKind, number>;
  byCompany: Record<string, number>;
};
export type PartnerRequestAlertGroupSummary = {
  id: string;
  accountId: string;
  bulkImportId: string | null;
  createdAt: string;
  openedAt: string | null;
  memberCount: number;
  canAcknowledge: boolean;
};
export type PartnerRequestInboxResponse = {
  ok: true;
  requests: PartnerRequestInboxItem[];
  counts: PartnerRequestInboxCounts;
  page: { nextCursor: string | null };
  generatedAt: string;
  group: PartnerRequestAlertGroupSummary | null;
};
export type PartnerRequestInboxDetailResponse = {
  ok: true;
  request: PartnerRequestInboxItem;
  record: Record<string, unknown> | null;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function isPartnerRequestInboxItem(
  value: unknown,
): value is PartnerRequestInboxItem {
  if (!object(value)) return false;
  return (
    typeof value["id"] === "string" &&
    uuid.test(value["id"]) &&
    PARTNER_REQUEST_KINDS.includes(value["kind"] as PartnerRequestKind) &&
    value["key"] === `${String(value["kind"])}:${value["id"]}` &&
    typeof value["accountId"] === "string" &&
    uuid.test(value["accountId"]) &&
    (value["jobId"] === null ||
      (typeof value["jobId"] === "string" && uuid.test(value["jobId"]))) &&
    [
      "accountName",
      "service",
      "description",
      "siteName",
      "address",
      "requesterName",
      "state",
      "statusLabel",
    ].every((key) => typeof value[key] === "string") &&
    PARTNER_REQUEST_STAGES.includes(value["stage"] as PartnerRequestStage) &&
    date(value["receivedAt"]) &&
    typeof value["detailHref"] === "string" &&
    value["detailHref"].startsWith("/team/partners?") &&
    typeof value["canAct"] === "boolean" &&
    typeof value["canAcknowledge"] === "boolean" &&
    typeof value["isNew"] === "boolean" &&
    (value["alertGroupId"] === null ||
      (typeof value["alertGroupId"] === "string" &&
        uuid.test(value["alertGroupId"]))) &&
    Array.isArray(value["preferredWindows"]) &&
    value["preferredWindows"].length <= 3 &&
    value["preferredWindows"].every(
      (window) =>
        object(window) &&
        typeof window["localDate"] === "string" &&
        /^\d{4}-\d{2}-\d{2}$/u.test(window["localDate"]) &&
        typeof window["timeOfDay"] === "string" &&
        typeof window["timezone"] === "string",
    )
  );
}
export function parsePartnerRequestInbox(
  value: unknown,
): PartnerRequestInboxResponse | null {
  if (
    !object(value) ||
    value["ok"] !== true ||
    !Array.isArray(value["requests"]) ||
    !value["requests"].every(isPartnerRequestInboxItem) ||
    !object(value["counts"]) ||
    !count(value["counts"]["needsAttention"]) ||
    !count(value["counts"]["waitingOnClient"]) ||
    !count(value["counts"]["handled"]) ||
    !object(value["counts"]["byKind"]) ||
    !PARTNER_REQUEST_KINDS.every((kind) =>
      count(
        (value["counts"] as Record<string, Record<string, unknown>>)[
          "byKind"
        ]?.[kind],
      ),
    ) ||
    !object(value["counts"]["byCompany"]) ||
    !Object.entries(value["counts"]["byCompany"]).every(
      ([id, total]) => uuid.test(id) && count(total),
    ) ||
    !object(value["page"]) ||
    !(
      value["page"]["nextCursor"] === null ||
      typeof value["page"]["nextCursor"] === "string"
    ) ||
    !date(value["generatedAt"])
  )
    return null;
  if (
    value["group"] !== null &&
    (!object(value["group"]) ||
      typeof value["group"]["id"] !== "string" ||
      !uuid.test(value["group"]["id"]) ||
      typeof value["group"]["accountId"] !== "string" ||
      !uuid.test(value["group"]["accountId"]) ||
      !(
        value["group"]["bulkImportId"] === null ||
        (typeof value["group"]["bulkImportId"] === "string" &&
          uuid.test(value["group"]["bulkImportId"]))
      ) ||
      !date(value["group"]["createdAt"]) ||
      !(
        value["group"]["openedAt"] === null || date(value["group"]["openedAt"])
      ) ||
      !count(value["group"]["memberCount"]) ||
      typeof value["group"]["canAcknowledge"] !== "boolean")
  )
    return null;
  return value as PartnerRequestInboxResponse;
}
export function parsePartnerRequestInboxDetail(
  value: unknown,
): PartnerRequestInboxDetailResponse | null {
  return object(value) &&
    value["ok"] === true &&
    isPartnerRequestInboxItem(value["request"]) &&
    (value["record"] === null || object(value["record"]))
    ? (value as PartnerRequestInboxDetailResponse)
    : null;
}
