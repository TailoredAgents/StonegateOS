import type { Route } from "next";
import { teamSurfaceHref } from "./surface-registry";

export type OutboundView = "queue" | "import";

export type OutboundFilters = {
  q?: string;
  campaign?: string;
  attempt?: string;
  due?: string;
  has?: string;
  disposition?: string;
  taskId?: string;
  accountId?: string;
  cursor?: string;
  direction?: string;
};

export type OutboundLocation = {
  memberId?: string;
  view: OutboundView;
  filters: OutboundFilters;
};

const OUTBOUND_FILTER_QUERY_KEYS = {
  q: "out_q",
  campaign: "out_campaign",
  attempt: "out_attempt",
  due: "out_due",
  has: "out_has",
  disposition: "out_disposition",
  taskId: "out_taskId",
  accountId: "out_account",
  cursor: "out_cursor",
  direction: "out_direction",
} as const satisfies Readonly<Record<keyof OutboundFilters, string>>;

const OUTBOUND_ALLOWED_QUERY_KEYS = new Set([
  "memberId",
  "view",
  ...Object.values(OUTBOUND_FILTER_QUERY_KEYS),
]);

function normalizedValue(
  value: unknown,
  maximumLength = 500,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximumLength ? trimmed : undefined;
}

export function normalizeOutboundView(value: unknown): OutboundView {
  return value === "import" ? "import" : "queue";
}

export function buildOutboundHref(args: {
  memberId?: string;
  view?: OutboundView;
  filters: OutboundFilters;
  patch?: Partial<OutboundFilters>;
}): Route {
  const query = new URLSearchParams();
  const memberId = normalizedValue(args.memberId);
  if (memberId) query.set("memberId", memberId);

  const view = normalizeOutboundView(args.view);
  if (view === "import") query.set("view", view);

  const merged: OutboundFilters = { ...args.filters, ...(args.patch ?? {}) };
  for (const [filterKey, queryKey] of Object.entries(
    OUTBOUND_FILTER_QUERY_KEYS,
  ) as Array<[keyof OutboundFilters, string]>) {
    const value = normalizedValue(merged[filterKey]);
    if (value) query.set(queryKey, value);
  }

  return teamSurfaceHref("outbound", { query });
}

export function buildOutboundPartnersHref(args: {
  memberId?: string;
  view?: OutboundView;
  filters: OutboundFilters;
}): Route {
  const returnHref = buildOutboundHref(args);
  return teamSurfaceHref("partners", {
    query: { out_return: String(returnHref) },
  });
}

export function parseOutboundReturnHref(
  value: unknown,
): OutboundLocation | null {
  const raw = normalizedValue(value, 4_096);
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw, "https://team.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://team.invalid") return null;
  if (parsed.pathname !== "/team/sales/outbound" || parsed.hash) return null;

  for (const key of parsed.searchParams.keys()) {
    if (
      !OUTBOUND_ALLOWED_QUERY_KEYS.has(key) ||
      parsed.searchParams.getAll(key).length !== 1
    ) {
      return null;
    }
  }

  const filters: OutboundFilters = {};
  for (const [filterKey, queryKey] of Object.entries(
    OUTBOUND_FILTER_QUERY_KEYS,
  ) as Array<[keyof OutboundFilters, string]>) {
    const entry = normalizedValue(parsed.searchParams.get(queryKey));
    if (entry) filters[filterKey] = entry;
  }

  return {
    memberId: normalizedValue(parsed.searchParams.get("memberId")),
    view: normalizeOutboundView(parsed.searchParams.get("view")),
    filters,
  };
}

export function outboundSubviewHrefFromReturn(
  value: unknown,
  view: OutboundView,
): Route {
  const parsed = parseOutboundReturnHref(value);
  return buildOutboundHref({
    memberId: parsed?.memberId,
    filters: parsed?.filters ?? {},
    view,
  });
}
