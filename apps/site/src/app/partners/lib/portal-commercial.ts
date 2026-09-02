import "server-only";

import { callPartnerApi } from "./api";
import type {
  PartnerDocument,
  PartnerInvoice,
  PartnerMoney,
  PartnerQuote,
  PartnerQuoteDetail,
  PartnerReportSummary,
  PartnerStatement,
} from "./portal-v2";

export type PartnerCommercialState<T> =
  | {
      status: "ready";
      items: T[];
      summary: unknown[];
      page: { nextCursor: string | null; hasMore: boolean };
    }
  | { status: "forbidden" | "unavailable" | "error" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMoney(value: unknown): value is PartnerMoney {
  if (!isRecord(value)) return false;
  return (
    typeof value["amountMinor"] === "number" &&
    Number.isSafeInteger(value["amountMinor"]) &&
    typeof value["currency"] === "string" &&
    typeof value["minorUnit"] === "number"
  );
}

function hasAmounts(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  return keys.every((key) => isMoney(value[key]));
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown, maximum = 100): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => typeof item === "string")
  );
}

function isPartnerQuoteAmounts(value: unknown): boolean {
  return (
    value === null ||
    hasAmounts(value, ["subtotal", "tax", "discount", "total"]) ||
    hasAmounts(value, [
      "subtotalMin",
      "subtotalMax",
      "discountMin",
      "discountMax",
      "totalMin",
      "totalMax",
      "deposit",
    ])
  );
}

export function isPartnerQuote(value: unknown): value is PartnerQuote {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    (value["authority"] === "legacy_snapshot" ||
      value["authority"] === "quote_v2") &&
    typeof value["actionable"] === "boolean" &&
    isNullableString(value["notice"]) &&
    isNullableString(value["quoteNumber"]) &&
    typeof value["status"] === "string" &&
    Number.isSafeInteger(value["version"]) &&
    isNullableString(value["projectName"]) &&
    isNullableString(value["bookingId"]) &&
    isNullableString(value["bookingDraftId"]) &&
    isNullableString(value["locationId"]) &&
    isPartnerQuoteAmounts(value["amounts"]) &&
    (value["lineCount"] === null || Number.isSafeInteger(value["lineCount"])) &&
    isNullableString(value["expiresAt"]) &&
    isNullableString(value["issuedAt"]) &&
    isNullableString(value["documentId"]) &&
    isStringArray(value["allowedActions"], 20) &&
    isNullableString(value["etag"]) &&
    typeof value["createdAt"] === "string" &&
    typeof value["updatedAt"] === "string"
  );
}

function isQuoteDocument(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const parties = value["parties"];
  const issuer = value["issuer"];
  const pricing = value["pricing"];
  const terms = value["terms"];
  if (
    !isRecord(parties) ||
    !isRecord(issuer) ||
    !isRecord(pricing) ||
    !isRecord(terms) ||
    typeof value["documentType"] !== "string" ||
    typeof value["schedulingMode"] !== "string" ||
    typeof value["scope"] !== "string" ||
    !isStringArray(value["inclusions"], 50) ||
    !isStringArray(value["exclusions"], 50) ||
    !isStringArray(value["assumptions"], 50) ||
    !Number.isSafeInteger(value["estimatedDurationMinutes"]) ||
    typeof parties["customerName"] !== "string" ||
    !isNullableString(parties["companyName"]) ||
    typeof parties["serviceAddress"] !== "string" ||
    !isNullableString(parties["projectName"]) ||
    !isNullableString(parties["purchaseOrder"]) ||
    !isNullableString(parties["reference"]) ||
    typeof issuer["displayName"] !== "string" ||
    typeof issuer["email"] !== "string" ||
    typeof issuer["phoneE164"] !== "string" ||
    typeof pricing["currency"] !== "string" ||
    !Array.isArray(pricing["lineItems"]) ||
    pricing["lineItems"].length > 100 ||
    !Array.isArray(pricing["optionGroups"]) ||
    pricing["optionGroups"].length > 20 ||
    typeof terms["terms"] !== "string" ||
    typeof terms["paymentTerms"] !== "string" ||
    typeof terms["changeOrderRules"] !== "string" ||
    typeof terms["consentVersion"] !== "string"
  ) {
    return false;
  }
  const lineIds = new Set<string>();
  for (const item of pricing["lineItems"]) {
    if (!isRecord(item)) return false;
    const id = item["id"];
    if (
      typeof id !== "string" ||
      !id ||
      lineIds.has(id) ||
      typeof item["name"] !== "string" ||
      !isNullableString(item["description"]) ||
      typeof item["quantity"] !== "number" ||
      !Number.isFinite(item["quantity"]) ||
      typeof item["unit"] !== "string" ||
      !Number.isSafeInteger(item["unitPriceMinCents"]) ||
      (item["unitPriceMaxCents"] !== null &&
        !Number.isSafeInteger(item["unitPriceMaxCents"])) ||
      !isNullableString(item["optionGroupId"]) ||
      typeof item["selectedByDefault"] !== "boolean"
    ) {
      return false;
    }
    lineIds.add(id);
  }
  const groupIds = new Set<string>();
  for (const item of pricing["optionGroups"]) {
    if (!isRecord(item)) return false;
    const id = item["id"];
    if (
      typeof id !== "string" ||
      !id ||
      groupIds.has(id) ||
      typeof item["label"] !== "string" ||
      (item["mode"] !== "single" && item["mode"] !== "multiple") ||
      !Number.isSafeInteger(item["minimumSelections"]) ||
      !Number.isSafeInteger(item["maximumSelections"])
    ) {
      return false;
    }
    groupIds.add(id);
  }
  return true;
}

export function isPartnerQuoteDetail(
  value: unknown,
): value is PartnerQuoteDetail {
  if (!isPartnerQuote(value)) return false;
  const detail = value as Record<string, unknown>;
  const proposal = detail["proposalDocument"];
  const response = detail["response"];
  const history = detail["history"];
  return (
    isNullableString(detail["legacyTerms"]) &&
    isQuoteDocument(detail["document"]) &&
    (proposal === null ||
      (isRecord(proposal) &&
        typeof proposal["id"] === "string" &&
        isNullableString(proposal["filename"]) &&
        Number.isSafeInteger(proposal["byteSize"]) &&
        typeof proposal["sha256"] === "string")) &&
    (response === null ||
      (isRecord(response) &&
        typeof response["id"] === "string" &&
        (response["decision"] === "accepted" ||
          response["decision"] === "declined") &&
        typeof response["respondedAt"] === "string")) &&
    Array.isArray(history) &&
    history.length <= 100 &&
    history.every(
      (item) =>
        isRecord(item) &&
        typeof item["id"] === "string" &&
        Number.isSafeInteger(item["version"]) &&
        typeof item["state"] === "string" &&
        isNullableString(item["issuedAt"]) &&
        isNullableString(item["expiresAt"]) &&
        typeof item["current"] === "boolean",
    )
  );
}

export function isPartnerInvoice(value: unknown): value is PartnerInvoice {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["status"] === "string" &&
    hasAmounts(value["amounts"], [
      "subtotal",
      "tax",
      "discount",
      "deposit",
      "total",
      "paid",
      "balance",
    ])
  );
}

export function isPartnerStatement(value: unknown): value is PartnerStatement {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["periodStart"] === "string" &&
    typeof value["periodEnd"] === "string" &&
    hasAmounts(value["amounts"], [
      "openingBalance",
      "invoices",
      "payments",
      "refunds",
      "credits",
      "closingBalance",
    ])
  );
}

export function isPartnerDocument(value: unknown): value is PartnerDocument {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["filename"] === "string" &&
    typeof value["version"] === "number" &&
    typeof value["byteSize"] === "number" &&
    typeof value["generatedAt"] === "string"
  );
}

export function isPartnerReportSummary(value: unknown): value is PartnerReportSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value["currency"] === "string" &&
    typeof value["invoiceCount"] === "number" &&
    isMoney(value["total"]) &&
    isMoney(value["paid"]) &&
    isMoney(value["balance"])
  );
}

export async function loadPartnerCommercial<T>(
  endpoint: string,
  resource: string,
  validate: (value: unknown) => value is T,
): Promise<PartnerCommercialState<T>> {
  const response = await callPartnerApi(`/api/portal/v2/${endpoint}?limit=100`, {
    timeoutMs: 20_000,
  }).catch(() => null);
  if (!response) return { status: "unavailable" };
  if (response.status === 401 || response.status === 403) return { status: "forbidden" };
  if ([404, 409, 501, 503].includes(response.status)) return { status: "unavailable" };
  if (!response.ok) return { status: "error" };

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload) || payload["ok"] !== true) return { status: "error" };
  const candidate = Array.isArray(payload[resource])
    ? payload[resource]
    : Array.isArray(payload["data"])
      ? payload["data"]
      : null;
  if (!candidate) return { status: "error" };
  const items = candidate.filter(validate);
  if (items.length !== candidate.length) return { status: "error" };
  const rawPage = isRecord(payload["page"]) ? payload["page"] : {};
  return {
    status: "ready",
    items,
    summary: Array.isArray(payload["summary"]) ? payload["summary"] : [],
    page: {
      nextCursor:
        typeof rawPage["nextCursor"] === "string" ? rawPage["nextCursor"] : null,
      hasMore: rawPage["hasMore"] === true,
    },
  };
}

export function formatPartnerMoney(value: PartnerMoney): string {
  const divisor = 10 ** Math.max(0, Math.min(value.minorUnit, 6));
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: value.currency,
      minimumFractionDigits: value.minorUnit,
      maximumFractionDigits: value.minorUnit,
    }).format(value.amountMinor / divisor);
  } catch {
    return `${value.currency} ${(value.amountMinor / divisor).toFixed(value.minorUnit)}`;
  }
}

export function formatPartnerDate(value: string | null): string {
  if (!value) return "Not available";
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}
