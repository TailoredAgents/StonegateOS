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
  | "crm.contact.snapshot"
  | "crm.contact.instant_quote_photos"
  | "inbox.threads.list"
  | "inbox.thread.messages"
  | "inbox.contact.transcript"
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
  const head = trimmed.slice(0, Math.max(0, maxLen - 3));
  return `${head}...`;
}

function fmtUsdFromNumericString(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

function fmtMoneyCents(cents: number, currency: string | null | undefined): string {
  if (!Number.isFinite(cents)) return "$0.00";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function fmtPct(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return "0%";
  const pct = (numerator / denominator) * 100;
  if (!Number.isFinite(pct)) return "0%";
  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function toolSummaryLines(result: JarvisReadToolResult): string[] {
  if (result.status !== "ok") return [];
  const data = result.data;
  if (!isRecord(data)) return [];

  if (result.tool === "google.ads.spend") {
    const totals = isRecord(data["totals"]) ? (data["totals"] as Record<string, unknown>) : null;
    const cost = totals && typeof totals["cost"] === "string" ? (totals["cost"] as string) : "0";
    const clicks = totals ? asNumber(totals["clicks"], 0) : 0;
    const impressions = totals ? asNumber(totals["impressions"], 0) : 0;
    const date = typeof data["date"] === "string" ? (data["date"] as string) : "";
    const costNumber = Number(cost);
    const avgCpc = clicks > 0 && Number.isFinite(costNumber) ? `$${(costNumber / clicks).toFixed(2)}` : "$0.00";
    return [
      `Google Ads spend ${date || ""}: ${fmtUsdFromNumericString(cost)} (clicks ${clicks}, impr ${impressions}, avg CPC ${avgCpc})`.trim()
    ];
  }

  if (result.tool === "google.ads.summary") {
    const totals = isRecord(data["totals"]) ? (data["totals"] as Record<string, unknown>) : null;
    if (!totals) return [];
    const cost = typeof totals["cost"] === "string" ? (totals["cost"] as string) : "0";
    const clicks = asNumber(totals["clicks"], 0);
    const impressions = asNumber(totals["impressions"], 0);
    const conversionsRaw = totals["conversions"];
    const conversions = typeof conversionsRaw === "string" ? Number(conversionsRaw) : asNumber(conversionsRaw, 0);
    const days = asNumber(totals["days"], asNumber(data["rangeDays"], 0));
    const costNumber = Number(cost);
    const avgCpc = clicks > 0 && Number.isFinite(costNumber) ? `$${(costNumber / clicks).toFixed(2)}` : "$0.00";
    const cvr = clicks > 0 ? fmtPct(conversions, clicks) : "0%";
    return [
      `Google Ads last ${days || "?"} day(s): ${fmtUsdFromNumericString(cost)} spend, ${clicks} clicks, ${impressions} impr, ${Number.isFinite(conversions) ? conversions : 0} conv (CVR ${cvr}, avg CPC ${avgCpc})`
    ];
  }

  if (result.tool === "web.analytics.summary") {
    const totals = isRecord(data["totals"]) ? (data["totals"] as Record<string, unknown>) : null;
    if (!totals) return [];
    const visits = asNumber(totals["visits"], 0);
    const pageViews = asNumber(totals["pageViews"], 0);
    const callClicks = asNumber(totals["callClicks"], 0);
    const step1 = asNumber(totals["bookStep1Views"], 0);
    const submits = asNumber(totals["bookStep1Submits"], 0);
    const quotes = asNumber(totals["bookQuoteSuccess"], 0);
    const selfServe = asNumber(totals["bookBookingSuccess"], 0);
    const bookedAny = asNumber(totals["bookedAnyChannel"], 0);
    return [
      `Web: ${visits} visits, ${pageViews} pageviews, ${callClicks} call-clicks`,
      `/book: step1 ${step1} → submits ${submits} (${fmtPct(submits, step1)}) → quotes ${quotes} (${fmtPct(quotes, submits)}) → self-serve booked ${selfServe} (${fmtPct(selfServe, quotes)})`,
      `Booked (any channel, non-canceled): ${bookedAny}`
    ];
  }

  if (result.tool === "web.analytics.errors") {
    const items = Array.isArray(data["items"]) ? (data["items"] as unknown[]) : [];
    const total = items.reduce<number>((acc, item) => acc + (isRecord(item) ? asNumber(item["count"], 0) : 0), 0);
    const top = items
      .slice(0, 3)
      .map((item) => (isRecord(item) ? `${String(item["event"] ?? "event")}: ${asNumber(item["count"], 0)}` : null))
      .filter((v): v is string => Boolean(v && v.trim().length));
    return [`Tracked failures: ${total}${top.length ? ` (top: ${top.join(", ")})` : ""}`];
  }

  if (result.tool === "schedule.summary") {
    const total = asNumber(data["total"], 0);
    const byStatus = isRecord(data["byStatus"]) ? (data["byStatus"] as Record<string, unknown>) : null;
    const statusBits = byStatus
      ? Object.entries(byStatus)
          .slice(0, 6)
          .map(([k, v]) => `${k}: ${asNumber(v, 0)}`)
          .join(", ")
      : "";
    return [`Schedule: ${total} appt(s)${statusBits ? ` (${statusBits})` : ""}`];
  }

  if (result.tool === "finance.revenue.summary") {
    const currency = typeof data["currency"] === "string" ? (data["currency"] as string) : "USD";
    const windows = isRecord(data["windows"]) ? (data["windows"] as Record<string, unknown>) : null;
    if (!windows) return [];
    const lines: string[] = [];
    for (const key of ["monthToDate", "last30Days", "yearToDate"] as const) {
      const w = isRecord(windows[key]) ? (windows[key] as Record<string, unknown>) : null;
      if (!w) continue;
      const totalCents = asNumber(w["totalCents"], 0);
      const count = asNumber(w["count"], 0);
      const label = key === "monthToDate" ? "MTD" : key === "last30Days" ? "Last 30d" : "YTD";
      lines.push(`Revenue ${label}: ${fmtMoneyCents(totalCents, currency)} (${count} completed)`);
    }
    return lines;
  }

  if (result.tool === "finance.expenses.summary") {
    const currency = typeof data["currency"] === "string" ? (data["currency"] as string) : "USD";
    const windows = isRecord(data["windows"]) ? (data["windows"] as Record<string, unknown>) : null;
    if (!windows) return [];
    const lines: string[] = [];
    for (const key of ["monthToDate", "last30Days", "yearToDate"] as const) {
      const w = isRecord(windows[key]) ? (windows[key] as Record<string, unknown>) : null;
      if (!w) continue;
      const totalCents = asNumber(w["totalCents"], 0);
      const count = asNumber(w["count"], 0);
      const label = key === "monthToDate" ? "MTD" : key === "last30Days" ? "Last 30d" : "YTD";
      lines.push(`Expenses ${label}: ${fmtMoneyCents(totalCents, currency)} (${count} items)`);
    }
    return lines;
  }

  if (result.tool === "finance.pnl") {
    const revenue = isRecord(data["revenue"]) ? (data["revenue"] as Record<string, unknown>) : null;
    const expenses = isRecord(data["expenses"]) ? (data["expenses"] as Record<string, unknown>) : null;
    const currency = (revenue && typeof revenue["currency"] === "string" ? (revenue["currency"] as string) : null) ?? "USD";
    const rw = revenue && isRecord(revenue["windows"]) ? (revenue["windows"] as Record<string, unknown>) : null;
    const ew = expenses && isRecord(expenses["windows"]) ? (expenses["windows"] as Record<string, unknown>) : null;
    if (!rw || !ew) return [];

    const lines: string[] = [];
    for (const key of ["monthToDate", "last30Days", "yearToDate"] as const) {
      const r = isRecord(rw[key]) ? (rw[key] as Record<string, unknown>) : null;
      const e = isRecord(ew[key]) ? (ew[key] as Record<string, unknown>) : null;
      if (!r || !e) continue;
      const profit = asNumber(r["totalCents"], 0) - asNumber(e["totalCents"], 0);
      const label = key === "monthToDate" ? "MTD" : key === "last30Days" ? "Last 30d" : "YTD";
      lines.push(`Profit ${label}: ${fmtMoneyCents(profit, currency)}`);
    }
    return lines;
  }

  if (result.tool === "crm.pipeline") {
    const lanes = Array.isArray(data["lanes"]) ? (data["lanes"] as unknown[]) : [];
    const stageCounts = lanes
      .map((lane) => {
        if (!isRecord(lane)) return null;
        const stage = String(lane["stage"] ?? "").trim();
        const contacts = Array.isArray(lane["contacts"]) ? (lane["contacts"] as unknown[]) : [];
        return stage ? { stage, count: contacts.length } : null;
      })
      .filter((v): v is { stage: string; count: number } => Boolean(v));
    const total = stageCounts.reduce((acc, v) => acc + v.count, 0);
    const bits = stageCounts.slice(0, 6).map((v) => `${v.stage}: ${v.count}`).join(", ");
    return [`Pipeline: ${total} total${bits ? ` (${bits})` : ""}`];
  }

  if (result.tool === "inbox.threads.list") {
    const threads = Array.isArray(data["threads"]) ? (data["threads"] as unknown[]) : [];
    if (!threads.length) return ["Inbox: 0 threads match."];
    const top = threads
      .slice(0, 5)
      .map((t) => {
        if (!isRecord(t)) return null;
        const channel = String(t["channel"] ?? "unknown");
        const status = String(t["status"] ?? "unknown");
        const subject = typeof t["subject"] === "string" ? t["subject"] : "";
        const preview = typeof t["lastMessagePreview"] === "string" ? t["lastMessagePreview"] : "";
        const line = `${channel}/${status}${subject ? ` - ${truncateText(subject, 40)}` : ""}${preview ? `: ${truncateText(preview, 80)}` : ""}`;
        return line.trim();
      })
      .filter((v): v is string => Boolean(v && v.trim().length));
    return [`Inbox threads: ${threads.length} match(es).`, ...(top.length ? top.map((l) => `- ${l}`) : [])];
  }

  if (result.tool === "crm.contact.snapshot") {
    const contacts = Array.isArray(data["contacts"]) ? (data["contacts"] as unknown[]) : [];
    const first = contacts.length > 0 && isRecord(contacts[0]) ? (contacts[0] as Record<string, unknown>) : null;
    if (!first) return [];
    const name = typeof first["name"] === "string" ? first["name"] : "Unknown";
    const phone = typeof first["phoneE164"] === "string" ? first["phoneE164"] : typeof first["phone"] === "string" ? first["phone"] : "";
    const pipeline = isRecord(first["pipeline"]) ? (first["pipeline"] as Record<string, unknown>) : null;
    const stage = pipeline && typeof pipeline["stage"] === "string" ? (pipeline["stage"] as string) : "";
    const props = Array.isArray(first["properties"]) ? (first["properties"] as unknown[]) : [];
    const prop = props.length > 0 && isRecord(props[0]) ? (props[0] as Record<string, unknown>) : null;
    const city = prop && typeof prop["city"] === "string" ? (prop["city"] as string) : "";
    const zip = prop && typeof prop["postalCode"] === "string" ? (prop["postalCode"] as string) : "";
    const lastActivityAt = typeof first["lastActivityAt"] === "string" ? (first["lastActivityAt"] as string) : "";
    const place = [city || null, zip || null].filter(Boolean).join(" ");
    return [
      `Contact: ${name}${phone ? ` (${phone})` : ""}`,
      `${stage ? `Pipeline: ${stage}` : "Pipeline: unknown"}${place ? ` - ${place}` : ""}${lastActivityAt ? ` - last activity ${lastActivityAt}` : ""}`
    ];
  }

  if (result.tool === "crm.contact.instant_quote_photos") {
    const quotes = Array.isArray(data["quotes"]) ? (data["quotes"] as unknown[]) : [];
    const photoUrls = Array.isArray(data["photoUrls"]) ? (data["photoUrls"] as unknown[]) : [];
    const first = quotes.length > 0 && isRecord(quotes[0]) ? (quotes[0] as Record<string, unknown>) : null;
    const createdAt = first && typeof first["createdAt"] === "string" ? (first["createdAt"] as string) : "";
    const jobTypes = first && Array.isArray(first["jobTypes"]) ? (first["jobTypes"] as unknown[]) : [];
    const perceivedSize = first && typeof first["perceivedSize"] === "string" ? (first["perceivedSize"] as string) : "";
    const jobTypesText = jobTypes.filter((j) => typeof j === "string" && j.trim().length).slice(0, 4).join(", ");
    return [
      `Instant quote photos: ${photoUrls.length} photo(s) across ${quotes.length} quote(s)`,
      `${createdAt ? `Latest: ${createdAt}` : "Latest: unknown"}${perceivedSize ? ` - size ${perceivedSize}` : ""}${jobTypesText ? ` - types ${jobTypesText}` : ""}`
    ];
  }

  return [];
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
      const contactId = asString(args["contactId"]);
      const limit = Math.min(Math.max(asInt(args["limit"], 12), 1), 50);
      const offset = Math.max(asInt(args["offset"], 0), 0);
      const excludeOutbound = args["excludeOutbound"] === true ? "1" : null;
      const onlyOutbound = args["onlyOutbound"] === true ? "1" : null;
      const res = await adminFetchJson(ctx, {
        path: "/api/admin/contacts",
        query: {
          ...(q ? { q } : {}),
          ...(contactId ? { contactId } : {}),
          limit,
          offset,
          ...(excludeOutbound ? { excludeOutbound } : {}),
          ...(onlyOutbound ? { onlyOutbound } : {})
        }
      });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "crm.contact.snapshot": {
      const contactId = asString(args["contactId"]);
      if (!contactId) return toolError(tool, 400, "missing_contact_id");
      const res = await adminFetchJson(ctx, { path: "/api/admin/contacts", query: { contactId, limit: 1, offset: 0 } });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);
      return toolOk(tool, res.data);
    }
    case "crm.contact.instant_quote_photos": {
      const contactId = asString(args["contactId"]);
      if (!contactId) return toolError(tool, 400, "missing_contact_id");
      const res = await adminFetchJson(ctx, { path: `/api/admin/contacts/${encodeURIComponent(contactId)}/instant-quote-photos` });
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
      const limit = Math.min(Math.max(asInt(args["limit"], 20), 1), 200);
      const res = await adminFetchJson(ctx, { path: `/api/admin/inbox/threads/${encodeURIComponent(threadId)}` });
      if (!res.ok) return toolUnavailable(tool, res.status, res.error, res.data);

      const payload = res.data;
      if (!isRecord(payload)) return toolOk(tool, payload);
      const thread = isRecord(payload["thread"]) ? (payload["thread"] as Record<string, unknown>) : null;
      const messagesRaw = Array.isArray(payload["messages"]) ? (payload["messages"] as unknown[]) : [];
      const messages = messagesRaw.filter((m) => m && typeof m === "object").slice(-limit);
      return toolOk(tool, { ...(thread ? { thread } : {}), messages });
    }
    case "inbox.contact.transcript": {
      const contactId = asString(args["contactId"]);
      if (!contactId) return toolError(tool, 400, "missing_contact_id");
      const threadLimit = Math.min(Math.max(asInt(args["threadLimit"], 6), 1), 12);
      const messageLimit = Math.min(Math.max(asInt(args["messageLimit"], 20), 1), 80);

      const threadsRes = await adminFetchJson(ctx, {
        path: "/api/admin/inbox/threads",
        query: { contactId, limit: threadLimit, offset: 0 }
      });
      if (!threadsRes.ok) return toolUnavailable(tool, threadsRes.status, threadsRes.error, threadsRes.data);

      const payload = threadsRes.data;
      const threads = isRecord(payload) && Array.isArray(payload["threads"]) ? (payload["threads"] as unknown[]) : [];
      const first = threads.length > 0 && isRecord(threads[0]) ? (threads[0] as Record<string, unknown>) : null;
      const threadId = first && typeof first["id"] === "string" ? (first["id"] as string) : null;
      if (!threadId) {
        return { tool, status: "no_data", httpStatus: 200, error: "no_threads_for_contact", data: { threads: [] } };
      }

      const transcriptRes = await runJarvisReadTool(ctx, { tool: "inbox.thread.messages", args: { threadId, limit: messageLimit } });
      if (transcriptRes.status !== "ok") return transcriptRes;

      return toolOk(tool, { threads, transcript: transcriptRes.data });
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
  const dataMaxLen = results.length > 3 ? 1400 : 2800;
  lines.push(`Live data (read-only) — generated ${now}:`);
  for (const r of results) {
    lines.push("");
    lines.push(`Tool: ${r.tool}`);
    lines.push(`Status: ${r.status}${typeof r.httpStatus === "number" ? ` (${r.httpStatus})` : ""}${r.error ? ` — ${r.error}` : ""}`);
    const summary = toolSummaryLines(r);
    if (summary.length) {
      lines.push("Summary:");
      for (const s of summary) {
        lines.push(`- ${truncateText(s, 220)}`);
      }
    }
    if (r.data !== undefined) {
      const raw = stringifyForSystem(r.data);
      lines.push("Data:");
      lines.push(truncateText(raw, dataMaxLen));
    }
  }
  return lines.join("\n").trim();
}
