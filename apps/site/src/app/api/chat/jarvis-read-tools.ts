export type JarvisReadToolName =
  | "policy.get_all"
  | "system.health"
  | "web.analytics.summary"
  | "web.analytics.funnel"
  | "web.analytics.errors"
  | "web.analytics.vitals"
  | "finance.revenue.summary"
  | "finance.expenses.summary"
  | "finance.expenses.list"
  | "finance.pnl"
  | "schedule.summary"
  | "appointments.list"
  | "commissions.summary"
  | "crm.pipeline"
  | "crm.contacts.search"
  | "inbox.threads.list"
  | "inbox.thread.messages"
  | "inbox.thread.suggest_reply"
  | "outbound.queue"
  | "partners.list"
  | "seo.status"
  | "meta.ads.summary"
  | "google.ads.spend"
  | "google.ads.summary"
  | "google.ads.status";

export type JarvisReadToolCall = {
  tool: JarvisReadToolName;
  args: Record<string, unknown>;
};

export type JarvisToolStatus = "ok" | "not_configured" | "unavailable" | "no_data" | "error";

export type JarvisReadToolResult = {
  tool: JarvisReadToolName;
  status: JarvisToolStatus;
  httpStatus?: number;
  error?: string;
  data?: unknown;
};

type AdminContext = {
  apiBase: string;
  adminKey?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function truncateText(value: string, maxLen: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLen - 1))}…`;
}

function fmtUsdFromNumericString(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

async function adminFetchJson(
  ctx: AdminContext,
  input: { method?: "GET" | "POST"; path: string; query?: Record<string, string | number | null | undefined>; body?: unknown }
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string; data?: unknown }> {
  if (!ctx.adminKey) return { ok: false, status: 428, error: "admin_key_missing" };
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(input.query ?? {})) {
    if (v === null || v === undefined) continue;
    query.set(k, String(v));
  }
  const url = `${ctx.apiBase}${input.path}${query.size ? `?${query.toString()}` : ""}`;
  const res = await fetch(url, {
    method: input.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ctx.adminKey
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    cache: "no-store"
  }).catch(() => null);

  if (!res) return { ok: false, status: 503, error: "unreachable" };
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err =
      (isRecord(data) && typeof data["error"] === "string" && (data["error"] as string)) ||
      (isRecord(data) && typeof data["message"] === "string" && (data["message"] as string)) ||
      "request_failed";
    return { ok: false, status: res.status, error: err, data };
  }
  return { ok: true, data };
}

function toolNotConfigured(tool: JarvisReadToolName, error: string): JarvisReadToolResult {
  return { tool, status: "not_configured", error };
}

function toolUnavailable(tool: JarvisReadToolName, status: number, error: string, data?: unknown): JarvisReadToolResult {
  return { tool, status: "unavailable", httpStatus: status, error, ...(data !== undefined ? { data } : {}) };
}

function toolError(tool: JarvisReadToolName, status: number, error: string, data?: unknown): JarvisReadToolResult {
  return { tool, status: "error", httpStatus: status, error, ...(data !== undefined ? { data } : {}) };
}

function toolOk(tool: JarvisReadToolName, data: unknown): JarvisReadToolResult {
  return { tool, status: "ok", data };
}

export async function runJarvisReadTool(ctx: AdminContext, call: JarvisReadToolCall): Promise<JarvisReadToolResult> {
  if (!ctx.adminKey) return toolNotConfigured(call.tool, "ADMIN_API_KEY missing on site service");

  const tool = call.tool;
  const args = call.args ?? {};

  switch (tool) {
    case "policy.get_all": {
      const res = await adminFetchJson(ctx, { path: "/api/admin/policy" });
      if (!res.ok) return res.status === 428 ? toolNotConfigured(tool, res.error) : toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "system.health": {
      const res = await adminFetchJson(ctx, { path: "/api/admin/system/health" });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "web.analytics.summary":
    case "web.analytics.funnel":
    case "web.analytics.errors":
    case "web.analytics.vitals": {
      const rangeDays = Math.min(Math.max(asInt(args["rangeDays"], 7), 1), 30);
      const path =
        tool === "web.analytics.summary"
          ? "/api/admin/web/analytics/summary"
          : tool === "web.analytics.funnel"
            ? "/api/admin/web/analytics/funnel"
            : tool === "web.analytics.errors"
              ? "/api/admin/web/analytics/errors"
              : "/api/admin/web/analytics/vitals";
      const utmCampaign = tool === "web.analytics.summary" ? asString(args["utmCampaign"]) : null;
      const res = await adminFetchJson(ctx, { path, query: { rangeDays, ...(utmCampaign ? { utmCampaign } : {}) } });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "finance.revenue.summary": {
      const res = await adminFetchJson(ctx, { path: "/api/revenue/summary" });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "finance.expenses.summary": {
      const res = await adminFetchJson(ctx, { path: "/api/admin/expenses/summary" });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "finance.expenses.list": {
      const limit = Math.min(Math.max(asInt(args["limit"], 25), 1), 200);
      const from = asString(args["from"]);
      const to = asString(args["to"]);
      const res = await adminFetchJson(ctx, { path: "/api/admin/expenses", query: { limit, ...(from ? { from } : {}), ...(to ? { to } : {}) } });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "schedule.summary": {
      const range = asString(args["range"]) ?? "this_week";
      const statuses = asString(args["statuses"]);
      const res = await adminFetchJson(ctx, { path: "/api/admin/schedule/summary", query: { range, ...(statuses ? { statuses } : {}) } });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "appointments.list": {
      const status = asString(args["status"]) ?? "confirmed";
      const contactId = asString(args["contactId"]);
      const propertyId = asString(args["propertyId"]);
      const limit = Math.min(Math.max(asInt(args["limit"], 50), 1), 200);
      const res = await adminFetchJson(ctx, {
        path: "/api/appointments",
        query: { status, ...(contactId ? { contactId } : {}), ...(propertyId ? { propertyId } : {}), limit }
      });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "commissions.summary": {
      const res = await adminFetchJson(ctx, { path: "/api/admin/commissions/summary" });
      if (!res.ok) {
        if (res.error === "schema_not_ready") return { tool, status: "no_data", httpStatus: res.status, error: res.error, data: res.data };
        return toolUnavailable(tool, res.status, res.error, res.data);
      }
      return toolOk(tool, res.data);
    }
    case "crm.pipeline": {
      const res = await adminFetchJson(ctx, { path: "/api/admin/crm/pipeline" });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "crm.contacts.search": {
      const q = asString(args["q"]) ?? "";
      const limit = Math.min(Math.max(asInt(args["limit"], 12), 1), 50);
      const offset = Math.max(asInt(args["offset"], 0), 0);
      const excludeOutbound = args["excludeOutbound"] === true ? "1" : null;
      const onlyOutbound = args["onlyOutbound"] === true ? "1" : null;
      const res = await adminFetchJson(ctx, {
        path: "/api/admin/contacts",
        query: {
          ...(q ? { q } : {}),
          limit,
          offset,
          ...(excludeOutbound ? { excludeOutbound } : {}),
          ...(onlyOutbound ? { onlyOutbound } : {})
        }
      });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "inbox.threads.list": {
      const q = asString(args["q"]);
      const status = asString(args["status"]);
      const channel = asString(args["channel"]);
      const contactId = asString(args["contactId"]);
      const limit = Math.min(Math.max(asInt(args["limit"], 12), 1), 50);
      const offset = Math.max(asInt(args["offset"], 0), 0);
      const res = await adminFetchJson(ctx, {
        path: "/api/admin/inbox/threads",
        query: {
          ...(q ? { q } : {}),
          ...(status ? { status } : {}),
          ...(channel ? { channel } : {}),
          ...(contactId ? { contactId } : {}),
          limit,
          offset
        }
      });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "inbox.thread.messages": {
      const threadId = asString(args["threadId"]);
      if (!threadId) return toolError(tool, 400, "missing_thread_id");
      const limit = Math.min(Math.max(asInt(args["limit"], 50), 1), 200);
      const offset = Math.max(asInt(args["offset"], 0), 0);
      const res = await adminFetchJson(ctx, { path: `/api/admin/inbox/threads/${encodeURIComponent(threadId)}/messages`, query: { limit, offset } });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "inbox.thread.suggest_reply": {
      const threadId = asString(args["threadId"]);
      if (!threadId) return toolError(tool, 400, "missing_thread_id");
      const tone = asString(args["tone"]);
      const goal = asString(args["goal"]);
      const res = await adminFetchJson(ctx, {
        method: "POST",
        path: `/api/admin/inbox/threads/${encodeURIComponent(threadId)}/suggest`,
        body: { ...(tone ? { tone } : {}), ...(goal ? { goal } : {}) }
      });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "outbound.queue": {
      const memberId = asString(args["memberId"]);
      const q = asString(args["q"]);
      const campaign = asString(args["campaign"]);
      const due = asString(args["due"]);
      const has = asString(args["has"]);
      const attempt = asString(args["attempt"]);
      const limit = Math.min(Math.max(asInt(args["limit"], 12), 1), 50);
      const offset = Math.max(asInt(args["offset"], 0), 0);
      const res = await adminFetchJson(ctx, {
        path: "/api/admin/outbound/queue",
        query: {
          ...(memberId ? { memberId } : {}),
          ...(q ? { q } : {}),
          ...(campaign ? { campaign } : {}),
          ...(due ? { due } : {}),
          ...(has ? { has } : {}),
          ...(attempt ? { attempt } : {}),
          limit,
          offset
        }
      });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "partners.list": {
      const status = asString(args["status"]);
      const ownerId = asString(args["ownerId"]);
      const type = asString(args["type"]);
      const q = asString(args["q"]);
      const limit = Math.min(Math.max(asInt(args["limit"], 25), 1), 50);
      const offset = Math.max(asInt(args["offset"], 0), 0);
      const res = await adminFetchJson(ctx, {
        path: "/api/admin/partners",
        query: { ...(status ? { status } : {}), ...(ownerId ? { ownerId } : {}), ...(type ? { type } : {}), ...(q ? { q } : {}), limit, offset }
      });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "seo.status": {
      const res = await adminFetchJson(ctx, { path: "/api/admin/seo/status" });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "meta.ads.summary": {
      const level = asString(args["level"]) ?? "campaign";
      const since = asString(args["since"]);
      const until = asString(args["until"]);
      const res = await adminFetchJson(ctx, {
        path: "/api/admin/meta/ads/summary",
        query: { level, ...(since ? { since } : {}), ...(until ? { until } : {}) }
      });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "google.ads.spend": {
      const relative = asString(args["relative"]) ?? "yesterday";
      const date = asString(args["date"]);
      const campaignId = asString(args["campaignId"]);
      const res = await adminFetchJson(ctx, {
        path: "/api/admin/google/ads/spend",
        query: { ...(date ? { date } : { relative }), ...(campaignId ? { campaignId } : {}) }
      });
      if (!res.ok) {
        if (res.error === "google_ads_not_configured") return toolNotConfigured(tool, "Google Ads not connected in StonegateOS");
        return toolUnavailable(tool, res.status, res.error, res.data);
      }
      return toolOk(tool, res.data);
    }
    case "google.ads.summary": {
      const rangeDays = Math.min(Math.max(asInt(args["rangeDays"], 7), 1), 30);
      const res = await adminFetchJson(ctx, { path: "/api/admin/google/ads/summary", query: { rangeDays } });
      if (!res.ok) {
        if (res.error === "google_ads_not_configured") return toolNotConfigured(tool, "Google Ads not connected in StonegateOS");
        return toolUnavailable(tool, res.status, res.error, res.data);
      }
      return toolOk(tool, res.data);
    }
    case "google.ads.status": {
      const res = await adminFetchJson(ctx, { path: "/api/admin/google/ads/status" });
      if (!res.ok) {
        if (res.error === "google_ads_not_configured") return toolNotConfigured(tool, "Google Ads not connected in StonegateOS");
        return toolUnavailable(tool, res.status, res.error, res.data);
      }
      return toolOk(tool, res.data);
    }
    case "finance.pnl": {
      const [rev, exp] = await Promise.all([
        runJarvisReadTool(ctx, { tool: "finance.revenue.summary", args: {} }),
        runJarvisReadTool(ctx, { tool: "finance.expenses.summary", args: {} })
      ]);
      if (rev.status !== "ok" || exp.status !== "ok") {
        return {
          tool,
          status: "unavailable",
          error: "pnl_requires_revenue_and_expenses",
          data: { revenue: rev, expenses: exp }
        };
      }
      return toolOk(tool, { revenue: rev.data, expenses: exp.data });
    }
    default: {
      return toolError(tool, 400, "unknown_tool");
    }
  }
}

function stringifyForSystem(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatJarvisToolResultsForSystem(results: JarvisReadToolResult[]): string | null {
  if (!results.length) return null;
  const now = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`Live data (read-only) — generated ${now}:`);
  for (const r of results) {
    lines.push("");
    lines.push(`Tool: ${r.tool}`);
    lines.push(`Status: ${r.status}${typeof r.httpStatus === "number" ? ` (${r.httpStatus})` : ""}${r.error ? ` — ${r.error}` : ""}`);
    if (r.status === "ok" && r.tool === "google.ads.spend" && isRecord(r.data)) {
      const totals = isRecord(r.data["totals"]) ? (r.data["totals"] as Record<string, unknown>) : null;
      const cost = totals && typeof totals["cost"] === "string" ? (totals["cost"] as string) : "0";
      const clicks = totals && Number.isFinite(Number(totals["clicks"])) ? Number(totals["clicks"]) : 0;
      const impressions = totals && Number.isFinite(Number(totals["impressions"])) ? Number(totals["impressions"]) : 0;
      const date = typeof r.data["date"] === "string" ? (r.data["date"] as string) : "";
      lines.push(`Summary: Google Ads spend ${date || ""} = ${fmtUsdFromNumericString(cost)} (clicks ${clicks}, impressions ${impressions})`.trim());
    }
    if (r.data !== undefined) {
      const raw = stringifyForSystem(r.data);
      lines.push("Data:");
      lines.push(truncateText(raw, 2800));
    }
  }
  return lines.join("\n").trim();
}

