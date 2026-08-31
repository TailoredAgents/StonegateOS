import "server-only";

import { callPartnerApi } from "./api";
import type {
  PartnerDocument,
  PartnerInvoice,
  PartnerMoney,
  PartnerQuote,
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

export function isPartnerQuote(value: unknown): value is PartnerQuote {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["status"] === "string" &&
    typeof value["version"] === "number" &&
    hasAmounts(value["amounts"], ["subtotal", "tax", "discount", "total"])
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
