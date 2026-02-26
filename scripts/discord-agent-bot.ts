import "dotenv/config";
import Module from "node:module";
import path from "node:path";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { DateTime } from "luxon";

function registerAliases() {
  const originalResolve = (Module as unknown as { _resolveFilename: Module["_resolveFilename"] })._resolveFilename;
  (Module as unknown as { _resolveFilename: Module["_resolveFilename"] })._resolveFilename = function (
    request: string,
    parent: any,
    isMain: boolean,
    options: any
  ) {
    if (request.startsWith("@/")) {
      const absolute = path.resolve("apps/api/src", request.slice(2));
      return originalResolve.call(this, absolute, parent, isMain, options);
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
}

function mustEnv(key: string): string {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(`Missing env var: ${key}`);
  }
  return value.trim();
}

function parseCsv(input: string | undefined | null): string[] {
  return (input ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTimeOfDayFromText(text: string): string | null {
  const match = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (meridiem === "am" || meridiem === "pm") {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    if (meridiem === "pm") hour = hour === 12 ? 12 : hour + 12;
  } else {
    if (hour < 0 || hour > 23) return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function pickTimezoneFromText(text: string, fallback: string): string {
  const lower = text.toLowerCase();
  if (/\b(et|est|edt)\b/.test(lower)) return "America/New_York";
  return fallback;
}

function normalizeIntentText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRangeDaysFromText(text: string): number | null {
  const normalized = normalizeIntentText(text);
  const numMatch = normalized.match(/\b(?:last|past)\s+(\d{1,2})\s+days?\b/);
  if (numMatch?.[1]) {
    const n = Number(numMatch[1]);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.floor(n), 1), 30) : null;
  }

  const weekMatch = normalized.match(/\b(?:last|past)\s+(\d{1,2})\s+weeks?\b/);
  if (weekMatch?.[1]) {
    const n = Number(weekMatch[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(Math.max(Math.floor(n * 7), 1), 30);
  }

  if (/\blast week\b/.test(normalized) || /\bpast week\b/.test(normalized)) return 7;
  if (/\blast 14\b/.test(normalized)) return 14;
  return null;
}

type ReportIntent = {
  kind: "run" | "subscribe" | "unsubscribe";
  comparisonRangeDays?: number | null;
  timeOfDay?: string | null;
  timezone?: string | null;
};

function detectDailyReportIntent(text: string): ReportIntent | null {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;

  const mentionsReport =
    normalized.includes("report") ||
    normalized.includes("stats") ||
    normalized.includes("numbers") ||
    normalized.includes("metrics") ||
    normalized.includes("summary");
  if (!mentionsReport) return null;

  const mentionsDaily =
    normalized.includes("daily") ||
    normalized.includes("weekly") ||
    normalized.includes("week") ||
    normalized.includes("past week") ||
    normalized.includes("last week") ||
    normalized.includes("every morning") ||
    normalized.includes("each morning") ||
    normalized.includes("today") ||
    normalized.includes("yesterday") ||
    normalized.includes("this morning") ||
    normalized.includes("ops");
  if (!mentionsDaily) return null;

  const wantsStop =
    normalized.includes("unsubscribe") ||
    normalized.includes("stop sending") ||
    normalized.includes("stop posting") ||
    normalized.includes("dont send") ||
    normalized.includes("do not send") ||
    normalized.includes("turn off");

  if (wantsStop) {
    return { kind: "unsubscribe" };
  }

  const wantsSchedule =
    normalized.includes("subscribe") ||
    normalized.includes("every day") ||
    normalized.includes("each day") ||
    normalized.includes("daily at") ||
    (normalized.includes("every") && normalized.includes("morning")) ||
    (normalized.includes("send") && normalized.includes("daily")) ||
    (normalized.includes("post") && normalized.includes("daily"));

  const comparisonRangeDays = parseRangeDaysFromText(text);
  const timeOfDay = parseTimeOfDayFromText(text);

  if (wantsSchedule) {
    return { kind: "subscribe", comparisonRangeDays, timeOfDay };
  }

  // Default: run now for any "daily report" ask.
  return { kind: "run", comparisonRangeDays };
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/$/, "");
}

function stripBotMention(text: string, botUserId: string) {
  const pattern = new RegExp(`<@!?${botUserId}>`, "g");
  return text.replace(pattern, "").trim();
}

function stripWakeWord(text: string, wakeWords: string[]): { matched: boolean; prompt: string } {
  const trimmed = text.trim();
  if (!trimmed) return { matched: false, prompt: "" };

  const lower = trimmed.toLowerCase();
  const sorted = [...wakeWords]
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const wake of sorted) {
    if (!lower.startsWith(wake)) continue;
    const next = trimmed.slice(wake.length);
    // Ensure we matched a whole wake phrase, not a prefix inside a word.
    if (next.length && !/^[\s,:;\-—]/.test(next)) continue;
    const prompt = next.replace(/^[\s,:;\-—]+/, "").trim();
    return { matched: true, prompt };
  }

  return { matched: false, prompt: trimmed };
}

type AgentChatResponse = {
  ok?: boolean;
  reply?: string;
  actions?: Array<{ type?: string; summary?: string; payload?: Record<string, unknown> }>;
  error?: string;
  message?: string;
};

type DiscordTranscriptLine = { role: "user" | "assistant"; content: string };

async function buildDiscordTranscript(message: any, limit: number): Promise<DiscordTranscriptLine[]> {
  try {
    const channel = message.channel;
    if (!channel || typeof channel.messages?.fetch !== "function") return [];

    const fetched = await channel.messages.fetch({ limit: Math.max(1, Math.min(50, limit)) }).catch(() => null);
    if (!fetched) return [];

    const botId = message.client?.user?.id ? String(message.client.user.id) : null;
    const authorId = message.author?.id ? String(message.author.id) : null;
    const sorted = Array.from(fetched.values()).sort(
      (a: any, b: any) => Number(a.createdTimestamp) - Number(b.createdTimestamp)
    );

    const lines: DiscordTranscriptLine[] = [];
    for (const msg of sorted) {
      if (!msg) continue;
      const content = typeof msg.content === "string" ? msg.content.trim() : "";
      if (!content) continue;
      if (msg.author?.bot && botId && String(msg.author.id) !== botId) continue;
      if (!msg.author?.bot && authorId && String(msg.author.id) !== authorId) continue;

      const role: DiscordTranscriptLine["role"] =
        botId && String(msg.author?.id ?? "") === botId ? "assistant" : "user";
      lines.push({ role, content });
    }

    return lines.slice(-limit);
  } catch {
    return [];
  }
}

function formatTranscriptForSystem(lines: DiscordTranscriptLine[]): string {
  if (!lines.length) return "";
  const rendered = lines.map((l) => `${l.role === "assistant" ? "Assistant" : "User"}: ${l.content}`).join("\n");
  return [
    "Discord transcript (most recent messages).",
    "Use this for context. Do not mention Discord or the transcript unless asked.",
    rendered
  ].join("\n");
}

type ActionCandidate = {
  id: string;
  name?: string | null;
  phoneE164?: string | null;
  email?: string | null;
  lastActivityAt?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
};

type AppointmentCandidate = {
  id: string;
  startAt?: string | null;
  status?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
};

type MemoryCandidate = {
  id: string;
  title?: string | null;
  content?: string | null;
  memoryType?: string | null;
  scope?: string | null;
  pinned?: boolean | null;
  updatedAt?: string | null;
};

function getCandidates(action: { payload?: Record<string, unknown> }): ActionCandidate[] {
  const raw = action.payload?.["contactCandidates"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => (c && typeof c === "object" ? (c as ActionCandidate) : null))
    .filter((c): c is ActionCandidate => Boolean(c && typeof c.id === "string" && c.id.trim().length > 0));
}

function getContactId(action: { payload?: Record<string, unknown> }): string | null {
  const raw = action.payload?.["contactId"];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function getAppointmentCandidates(action: { payload?: Record<string, unknown> }): AppointmentCandidate[] {
  const raw = action.payload?.["appointmentCandidates"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => (c && typeof c === "object" ? (c as AppointmentCandidate) : null))
    .filter((c): c is AppointmentCandidate => Boolean(c && typeof c.id === "string" && c.id.trim().length > 0));
}

function getAppointmentId(action: { payload?: Record<string, unknown> }): string | null {
  const raw = action.payload?.["appointmentId"];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function withPickedContactId(
  action: { type?: string; payload?: Record<string, unknown> },
  pickedContactId: string
) {
  return {
    ...action,
    payload: {
      ...(action.payload ?? {}),
      contactId: pickedContactId
    }
  };
}

function withPickedAppointmentId(
  action: { type?: string; payload?: Record<string, unknown> },
  pickedAppointmentId: string
) {
  return {
    ...action,
    payload: {
      ...(action.payload ?? {}),
      appointmentId: pickedAppointmentId
    }
  };
}

function formatCandidateLine(candidate: ActionCandidate) {
  const name = (candidate.name ?? "").trim() || "Unknown";
  const phone = (candidate.phoneE164 ?? "").trim();
  const email = (candidate.email ?? "").trim();
  const zip = (candidate.postalCode ?? "").trim();
  const city = (candidate.city ?? "").trim();
  const state = (candidate.state ?? "").trim();
  const addr = (candidate.addressLine1 ?? "").trim();
  const bits = [phone, email, [addr, city, state, zip].filter(Boolean).join(", ")].filter(Boolean);
  return bits.length ? `${name} — ${bits.join(" | ")}` : name;
}

function formatAppointmentCandidateLine(candidate: AppointmentCandidate) {
  const startAt = typeof candidate.startAt === "string" ? candidate.startAt : "";
  const when = startAt && !Number.isNaN(Date.parse(startAt)) ? new Date(startAt).toLocaleString() : "unscheduled";
  const status = (candidate.status ?? "").trim();
  const zip = (candidate.postalCode ?? "").trim();
  const city = (candidate.city ?? "").trim();
  const state = (candidate.state ?? "").trim();
  const addr = (candidate.addressLine1 ?? "").trim();
  const place = [addr, city, state, zip].filter(Boolean).join(", ");
  const bits = [status ? `(${status})` : null, place || null].filter(Boolean);
  return bits.length ? `${when} ${bits.join(" ")}` : when;
}

function formatMemoryCandidateLine(candidate: MemoryCandidate) {
  const title = (candidate.title ?? "").trim() || "Untitled";
  const type = (candidate.memoryType ?? "").trim();
  const scope = (candidate.scope ?? "").trim();
  const pin = candidate.pinned ? " (pinned)" : "";
  const meta = [type || null, scope || null].filter(Boolean).join("/");
  return `${meta ? `[${meta}] ` : ""}${title}${pin}`;
}

async function callAgentChat(input: {
  siteUrl: string;
  botKey: string;
  message: string;
  system?: string;
}): Promise<AgentChatResponse> {
  const res = await fetch(`${input.siteUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-stonegate-bot-key": input.botKey
    },
    body: JSON.stringify({
      mode: "team",
      message: input.message,
      ...(input.system ? { system: input.system } : {})
    })
  });

  const data = (await res.json().catch(() => null)) as AgentChatResponse | null;
  if (!res.ok || !data) {
    return { ok: false, error: "agent_unavailable", message: `Agent request failed (${res.status}).` };
  }
  return data;
}

async function executeAgentAction(input: {
  siteUrl: string;
  botKey: string;
  type: string;
  payload: Record<string, unknown>;
}) {
  const res = await fetch(`${input.siteUrl}/api/chat/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-stonegate-bot-key": input.botKey
    },
    body: JSON.stringify({ type: input.type, payload: input.payload })
  });
  const data = (await res.json().catch(() => null)) as any;
  return { ok: res.ok, status: res.status, data };
}

function parseApproval(content: string): { kind: "approve" | "cancel"; pick?: number | null } | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "cancel" || lower === "deny") return { kind: "cancel" };
  if (lower === "approve" || lower === "ok" || lower === "yes") return { kind: "approve" };
  const match = lower.match(/^approve\s+(\d+)$/);
  if (match) return { kind: "approve", pick: Number(match[1]) };
  return null;
}

function splitActions(actions: Array<{ type?: string; summary?: string; payload?: Record<string, unknown> }>) {
  return actions
    .filter((a) => a && typeof a.type === "string" && typeof a.payload === "object" && a.payload)
    .slice(0, 3) as Array<{ type: string; summary?: string; payload: Record<string, unknown> }>;
}

function detectRememberIntent(text: string): { content: string; scope?: "channel" | "guild"; pinned?: boolean } | null {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;

  const wantsRemember =
    normalized.startsWith("remember ") ||
    normalized.startsWith("remember that ") ||
    normalized.startsWith("note ") ||
    normalized.startsWith("note to self ") ||
    normalized.includes("save this") ||
    normalized.includes("save that") ||
    normalized.includes("add to memory") ||
    normalized.includes("keep in mind");
  if (!wantsRemember) return null;

  let content = text.trim();
  content = content.replace(/^remember(\s+that)?\s+/i, "");
  content = content.replace(/^note(\s+to\s+self)?\s*[:\-]?\s+/i, "");
  content = content.replace(/^save\s+(this|that)\s*[:\-]?\s*/i, "");
  content = content.trim();
  if (!content) return null;

  const scope: "channel" | "guild" | undefined =
    /\b(global|whole\s+server|entire\s+server|for\s+everyone|for\s+the\s+team)\b/i.test(normalized) ? "guild" : undefined;
  const pinned = /\bpin(ned)?\b/i.test(normalized) ? true : undefined;

  return { content, scope, pinned };
}

function detectRecallIntent(text: string): { q: string } | null {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;
  if (!(normalized.includes("remember") || normalized.includes("memory"))) return null;
  const match =
    text.match(/what do you remember about\s+(.+)/i) ??
    text.match(/do you remember\s+(.+)/i) ??
    text.match(/show me (?:your )?memory(?: about)?\s+(.+)/i);
  const q = (match?.[1] ?? "").trim();
  if (!q) return null;
  return { q };
}

function detectForgetIntent(text: string): { q: string } | null {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;
  if (!(normalized.startsWith("forget ") || normalized.includes("remove memory") || normalized.includes("delete memory"))) {
    return null;
  }
  const q = text.replace(/^forget\s+/i, "").trim();
  return q ? { q } : null;
}

async function main() {
  registerAliases();
  const {
    createDiscordActionIntent,
    findPendingDiscordActionIntentByBotMessageId,
    findLatestPendingDiscordActionIntent,
    findLatestPendingDiscordActionIntentForChannel,
    markDiscordActionIntentApproved,
    cancelDiscordActionIntent,
    markDiscordActionIntentExecuted
  } = await import("../apps/api/src/lib/discord-agent-intents");

  const {
    upsertDiscordReportSubscription,
    disableDiscordReportSubscription,
    listEnabledDiscordReportSubscriptions,
    markDiscordReportSubscriptionSent
  } = await import("../apps/api/src/lib/discord-report-subscriptions");

  const { buildDailyOpsReportMarkdown } = await import("../apps/api/src/lib/ops-reports");
  const { computeOpsMonitorAlerts, formatOpsMonitorAlertsMarkdown } = await import("../apps/api/src/lib/ops-monitor");
  const { buildOpsDiagnosticsMarkdown } = await import("../apps/api/src/lib/ops-diagnostics");

  const {
    createDiscordAgentMemory,
    listDiscordAgentMemoryForContext,
    searchDiscordAgentMemory,
    archiveDiscordAgentMemory
  } = await import("../apps/api/src/lib/discord-agent-memory");

  const discordToken = mustEnv("DISCORD_BOT_TOKEN");
  const botKey = mustEnv("AGENT_BOT_SHARED_SECRET");
  const siteUrl = normalizeBaseUrl(
    process.env["DISCORD_AGENT_SITE_URL"] ??
      process.env["SITE_URL"] ??
      process.env["NEXT_PUBLIC_SITE_URL"] ??
      "http://localhost:3000"
  );

  const allowedGuildIds = parseCsv(process.env["DISCORD_GUILD_IDS"] ?? process.env["DISCORD_GUILD_ID"]);
  const approverRoleIds = new Set(parseCsv(process.env["DISCORD_APPROVER_ROLE_IDS"]));
  const commandPrefix = (process.env["DISCORD_COMMAND_PREFIX"] ?? "!sg").trim();
  const requireMention = process.env["DISCORD_REQUIRE_MENTION"] !== "false";
  const respondAll = process.env["DISCORD_RESPOND_ALL"] === "true";
  const dmOnly = process.env["DISCORD_DM_ONLY"] === "true";
  const wakeWords = parseCsv(process.env["DISCORD_WAKE_WORDS"] ?? "jarvis,stonegate assist,stonegate");
  const intentTtlMinutes = Number(process.env["DISCORD_INTENT_TTL_MIN"] ?? 30);
  const contextLimit = Number(process.env["DISCORD_CONTEXT_MESSAGE_LIMIT"] ?? 20);
  const reportsEnabled = process.env["DISCORD_REPORTS_ENABLED"] !== "false";
  const reportCheckMs = Number(process.env["DISCORD_REPORT_CHECK_MS"] ?? 30_000);
  const defaultReportTz =
    (process.env["DISCORD_REPORT_TIMEZONE"] ?? process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York").trim() ||
    "America/New_York";
  const defaultReportTime = (process.env["DISCORD_DAILY_REPORT_AT"] ?? "08:30").trim() || "08:30";
  const memoryEnabled = process.env["DISCORD_MEMORY_ENABLED"] !== "false";
  const memoryMaxItems = Number(process.env["DISCORD_MEMORY_MAX_ITEMS"] ?? 12);
  const monitorEnabled = process.env["DISCORD_MONITOR_ENABLED"] !== "false";
  const monitorCheckMs = Number(process.env["DISCORD_MONITOR_CHECK_MS"] ?? 120_000);
  const monitorCooldownMin = Number(process.env["DISCORD_MONITOR_COOLDOWN_MIN"] ?? 30);
  const monitorDiagnosticsEnabled = process.env["DISCORD_MONITOR_DIAGNOSTICS_ENABLED"] !== "false";

  const memoryCache = new Map<string, { at: number; items: MemoryCandidate[] }>();
  const monitorState = new Map<string, { at: number; fingerprint: string }>();
  const monitorDiagnosticsState = new Map<string, { at: number; fingerprint: string }>();
  async function getMemoryContext(input: { guildId: string | null; channelId: string }): Promise<string> {
    if (!memoryEnabled) return "";
    const key = `${input.channelId}:${input.guildId ?? ""}`;
    const nowMs = Date.now();
    const cached = memoryCache.get(key);
    if (cached && nowMs - cached.at < 30_000) {
      const items = cached.items;
      if (!items.length) return "";
      const lines = items.slice(0, 12).map((m) => `- ${formatMemoryCandidateLine(m)}\n  ${String(m.content ?? "").trim().slice(0, 260)}`);
      return ["Persistent memory (keep these facts/preferences consistent):", ...lines].join("\n");
    }

    const rows = await listDiscordAgentMemoryForContext({
      discordGuildId: input.guildId,
      discordChannelId: input.channelId,
      maxItems: Number.isFinite(memoryMaxItems) ? memoryMaxItems : 12
    }).catch(() => []);

    const items: MemoryCandidate[] = Array.isArray(rows)
      ? rows.map((r: any) => ({
          id: String(r.id),
          title: typeof r.title === "string" ? r.title : null,
          content: typeof r.content === "string" ? r.content : null,
          memoryType: typeof r.memoryType === "string" ? r.memoryType : typeof r.memory_type === "string" ? r.memory_type : null,
          scope: typeof r.scope === "string" ? r.scope : null,
          pinned: Boolean(r.pinned),
          updatedAt: r.updatedAt ? String(r.updatedAt) : null
        }))
      : [];

    memoryCache.set(key, { at: nowMs, items });
    if (!items.length) return "";
    const lines = items.slice(0, 12).map((m) => `- ${formatMemoryCandidateLine(m)}\n  ${String(m.content ?? "").trim().slice(0, 260)}`);
    return ["Persistent memory (keep these facts/preferences consistent):", ...lines].join("\n");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
  });

  async function isAuthorized(message: any): Promise<boolean> {
    if (message.author?.bot) return false;

    if (message.inGuild?.()) {
      const guildId = String(message.guildId ?? "");
      if (allowedGuildIds.length && !allowedGuildIds.includes(guildId)) return false;

      if (approverRoleIds.size === 0) return true;

      const member =
        message.member ??
        (message.guild ? await message.guild.members.fetch(message.author.id).catch(() => null) : null);
      if (!member) return false;
      const roleIds: string[] = member.roles?.cache ? Array.from(member.roles.cache.keys()) : [];
      return roleIds.some((id) => approverRoleIds.has(id));
    }

    // DM: allow if they are a member of at least one allowed guild (or any mutual guild if none specified).
    const guildsToCheck = allowedGuildIds.length ? allowedGuildIds : Array.from(client.guilds.cache.keys());
    for (const guildId of guildsToCheck) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) continue;
      const member = await guild.members.fetch(message.author.id).catch(() => null);
      if (!member) continue;
      if (approverRoleIds.size === 0) return true;
      const roleIds: string[] = member.roles?.cache ? Array.from(member.roles.cache.keys()) : [];
      if (roleIds.some((id) => approverRoleIds.has(id))) return true;
    }
    return false;
  }

  client.once(Events.ClientReady, () => {
    console.log(
      JSON.stringify(
        {
          ok: true,
          msg: "discord_agent_ready",
          siteUrl,
          guilds: client.guilds.cache.size
        },
        null,
        2
      )
    );

    if (reportsEnabled) {
      const interval = Number.isFinite(reportCheckMs) && reportCheckMs > 5_000 ? Math.floor(reportCheckMs) : 30_000;
      const monitorInterval =
        monitorEnabled && Number.isFinite(monitorCheckMs) && monitorCheckMs > 15_000 ? Math.floor(monitorCheckMs) : 120_000;
      const cooldownMs =
        Number.isFinite(monitorCooldownMin) && monitorCooldownMin >= 5 ? Math.floor(monitorCooldownMin * 60_000) : 30 * 60_000;
      let nextMonitorAt = Date.now() + 10_000;
      setInterval(async () => {
        try {
          const subs = await listEnabledDiscordReportSubscriptions("daily_ops");
          if (!subs.length) return;

          for (const sub of subs) {
            const tz = (sub.timezone ?? defaultReportTz).trim() || defaultReportTz;
            const timeOfDay = (sub.timeOfDay ?? defaultReportTime).trim() || defaultReportTime;
            const [hhRaw, mmRaw] = timeOfDay.split(":");
            const hh = Number(hhRaw);
            const mm = Number(mmRaw);
            if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;

            const now = DateTime.now().setZone(tz);
            if (!now.isValid) continue;
            const target = now.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
            if (now < target) continue;
            const minutesLate = now.diff(target, "minutes").minutes;
            if (!Number.isFinite(minutesLate) || minutesLate > 5) continue;

            if (sub.lastSentAt) {
              const last = DateTime.fromJSDate(new Date(sub.lastSentAt as any)).setZone(tz);
              if (last.isValid && last.toISODate() === now.toISODate()) continue;
            }

            const content = await buildDailyOpsReportMarkdown({ tz });
            const channel = await client.channels.fetch(String(sub.discordChannelId)).catch(() => null);
            if (!channel || typeof (channel as any).isTextBased !== "function" || !(channel as any).isTextBased()) continue;

            await (channel as any).send(String(content).slice(0, 1900));
            await markDiscordReportSubscriptionSent({ id: String(sub.id) });
          }

          if (monitorEnabled && Date.now() >= nextMonitorAt) {
            const channelIds = Array.from(new Set(subs.map((s) => String(s.discordChannelId)))).filter(Boolean);
            for (const channelId of channelIds) {
              const tz =
                (subs.find((s) => String(s.discordChannelId) === channelId)?.timezone ?? defaultReportTz).trim() ||
                defaultReportTz;

              const alerts = await computeOpsMonitorAlerts({ tz }).catch(() => []);
              if (!alerts.length) continue;

              const fingerprint = alerts
                .map((a) => `${a.key}|${a.severity}|${String(a.detail ?? "").slice(0, 200)}`)
                .sort()
                .join("\n");

              const prior = monitorState.get(channelId);
              const nowMs = Date.now();
              const withinCooldown = prior && nowMs - prior.at < cooldownMs;
              if (withinCooldown && prior?.fingerprint === fingerprint) continue;

              const body = formatOpsMonitorAlertsMarkdown({ alerts, tz });
              if (!body) continue;

              const channel = await client.channels.fetch(channelId).catch(() => null);
              if (!channel || typeof (channel as any).isTextBased !== "function" || !(channel as any).isTextBased()) continue;

              const hasCritical = alerts.some((a) => a && typeof a.severity === "string" && a.severity === "critical");
              const diagPrior = monitorDiagnosticsState.get(channelId);
              const diagWithinCooldown = diagPrior && nowMs - diagPrior.at < cooldownMs;
              const shouldOfferDiagnostics =
                monitorDiagnosticsEnabled && hasCritical && !(diagWithinCooldown && diagPrior?.fingerprint === fingerprint);

              if (shouldOfferDiagnostics) {
                const cta = '\n\nReply "approve" to run an ops diagnostic snapshot (or "cancel").';
                const maxLen = Math.max(0, 1900 - cta.length);
                const combined = `${String(body).slice(0, maxLen)}${cta}`;
                const sent = await (channel as any).send(combined);
                const sentId = sent?.id ? String(sent.id) : "";

                if (sentId) {
                  const expiresAt = intentTtlMinutes > 0 ? new Date(Date.now() + intentTtlMinutes * 60_000) : null;
                  const subForChannel = subs.find((s) => String(s.discordChannelId) === channelId);
                  await createDiscordActionIntent({
                    discordGuildId: subForChannel?.discordGuildId ? String(subForChannel.discordGuildId) : null,
                    discordChannelId: String(channelId),
                    discordIntentMessageId: sentId,
                    requestedByDiscordUserId: "system",
                    requestText: "ops_monitor_alerts",
                    agentReply: "ops_diagnose",
                    actions: [
                      {
                        type: "ops_diagnose",
                        summary: "Run ops diagnostic snapshot",
                        payload: { discordChannelId: String(channelId), tz }
                      }
                    ],
                    expiresAt
                  });
                }

                monitorDiagnosticsState.set(channelId, { at: nowMs, fingerprint });
              } else {
                await (channel as any).send(String(body).slice(0, 1900));
              }
              monitorState.set(channelId, { at: nowMs, fingerprint });
            }

            nextMonitorAt = Date.now() + monitorInterval;
          }
        } catch (error) {
          console.warn("[discord-agent] report_tick_failed", String(error));
        }
      }, interval);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!(await isAuthorized(message))) return;

      const isDm = !message.inGuild?.();
      const approval = parseApproval(message.content);
      const referencedId = message.reference?.messageId;
      if (approval) {
        const intent = referencedId
          ? await findPendingDiscordActionIntentByBotMessageId(String(referencedId))
          : (await findLatestPendingDiscordActionIntent({
              discordChannelId: String(message.channelId),
              requestedByDiscordUserId: String(message.author.id)
            })) ??
            (await findLatestPendingDiscordActionIntentForChannel({
              discordChannelId: String(message.channelId),
              requestedByDiscordUserId: "system"
            }));
        if (!intent) {
          await message.reply("I don’t see a pending action to approve/cancel.");
          return;
        }

        if (approval.kind === "cancel") {
          await cancelDiscordActionIntent(intent.id, String(message.author.id));
          await message.reply("Canceled.");
          return;
        }

        const stagedActions = Array.isArray(intent.actions) ? intent.actions : [];
        const actions = splitActions(
          stagedActions as Array<{ type?: string; summary?: string; payload?: Record<string, unknown> }>
        );
        if (!actions.length) {
          await cancelDiscordActionIntent(intent.id, String(message.author.id));
          await message.reply("Nothing to run (no actions staged).");
          return;
        }

        const pickIndex = approval.pick && Number.isFinite(approval.pick) ? Math.max(1, approval.pick) : null;

        const normalizedActions = actions
          .map((action) => {
            const existingId = getContactId(action);
            if (existingId) return action;
            const candidates = getCandidates(action);
            if (candidates.length === 1) return withPickedContactId(action, candidates[0].id);
            if (pickIndex && pickIndex <= candidates.length) return withPickedContactId(action, candidates[pickIndex - 1].id);
            return action;
          })
          .map((action) => {
            const existingId = getAppointmentId(action);
            if (existingId) return action;
            const candidates = getAppointmentCandidates(action);
            if (candidates.length === 1) return withPickedAppointmentId(action, candidates[0].id);
            if (pickIndex && pickIndex <= candidates.length) return withPickedAppointmentId(action, candidates[pickIndex - 1].id);
            return action;
          });

        const missing = normalizedActions.find((action) => {
          if (action.type === "send_text" || action.type === "book_appointment") {
            return !getContactId(action);
          }
          if (action.type === "cancel_appointment" || action.type === "reschedule_appointment") {
            return !getAppointmentId(action);
          }
          return false;
        });

        if (missing) {
          const contactCandidates = getCandidates(missing);
          const apptCandidates = getAppointmentCandidates(missing);
          if (contactCandidates.length > 1) {
            const lines = contactCandidates.slice(0, 8).map((c, idx) => `${idx + 1}) ${formatCandidateLine(c)}`);
            await message.reply(
              [
                `Pick a contact for \`${missing.type}\`:`,
                ...(lines.length ? ["", ...lines] : []),
                "",
                "Reply `approve N` to run (or `cancel`)."
              ].join("\n")
            );
          } else if (apptCandidates.length > 1) {
            const lines = apptCandidates.slice(0, 8).map((c, idx) => `${idx + 1}) ${formatAppointmentCandidateLine(c)}`);
            await message.reply(
              [
                `Pick an appointment for \`${missing.type}\`:`,
                ...(lines.length ? ["", ...lines] : []),
                "",
                "Reply `approve N` to run (or `cancel`)."
              ].join("\n")
            );
          } else {
            await message.reply("I’m missing required info to run that action. Can you be more specific?");
          }
          return;
        }

        const approved = await markDiscordActionIntentApproved(intent.id, String(message.author.id));
        if (!approved) {
          await message.reply("That action is no longer pending.");
          return;
        }

        const results: Array<{ type: string; ok: boolean; status: number; error?: string }> = [];
        for (const action of normalizedActions) {
          const type = action.type;
          const payload = action.payload;
          const exec =
            type === "subscribe_daily_ops_report"
              ? (() => {
                  const channelId = String(payload["discordChannelId"] ?? "");
                  const reportType = String(payload["reportType"] ?? "");
                  const timezone = typeof payload["timezone"] === "string" ? String(payload["timezone"]) : defaultReportTz;
                  const timeOfDay = typeof payload["timeOfDay"] === "string" ? String(payload["timeOfDay"]) : defaultReportTime;
                  if (!channelId || reportType !== "daily_ops") {
                    return Promise.resolve({ ok: false, status: 400, data: { error: "invalid_subscription_payload" } });
                  }
                  return upsertDiscordReportSubscription({
                    discordGuildId: typeof payload["discordGuildId"] === "string" ? String(payload["discordGuildId"]) : null,
                    discordChannelId: channelId,
                    reportType: "daily_ops",
                    timezone,
                    timeOfDay,
                    createdByDiscordUserId: String(message.author.id)
                  }).then(
                    () => ({ ok: true, status: 200, data: { ok: true } }),
                    (err: any) => ({ ok: false, status: 500, data: { error: String(err) } })
                  );
                })()
              : type === "unsubscribe_daily_ops_report"
                ? (() => {
                    const channelId = String(payload["discordChannelId"] ?? "");
                    const reportType = String(payload["reportType"] ?? "");
                    if (!channelId || reportType !== "daily_ops") {
                      return Promise.resolve({ ok: false, status: 400, data: { error: "invalid_unsubscribe_payload" } });
                    }
                    return disableDiscordReportSubscription({
                      discordChannelId: channelId,
                      reportType: "daily_ops"
                    }).then(
                      () => ({ ok: true, status: 200, data: { ok: true } }),
                      (err: any) => ({ ok: false, status: 500, data: { error: String(err) } })
                    );
                  })()
                : type === "remember_memory"
                  ? (() => {
                      const discordChannelId = String(payload["discordChannelId"] ?? "");
                      const title = typeof payload["title"] === "string" ? String(payload["title"]) : "";
                      const content = typeof payload["content"] === "string" ? String(payload["content"]) : "";
                      if (!discordChannelId || !title.trim() || !content.trim()) {
                        return Promise.resolve({ ok: false, status: 400, data: { error: "invalid_memory_payload" } });
                      }
                      const scope = typeof payload["scope"] === "string" ? String(payload["scope"]) : "channel";
                      const memoryType = typeof payload["memoryType"] === "string" ? String(payload["memoryType"]) : "note";
                      const pinned = Boolean(payload["pinned"]);
                      return createDiscordAgentMemory({
                        discordGuildId: typeof payload["discordGuildId"] === "string" ? String(payload["discordGuildId"]) : null,
                        discordChannelId,
                        scope,
                        memoryType,
                        title,
                        content,
                        pinned,
                        createdByDiscordUserId: String(message.author.id)
                      }).then(
                        () => ({ ok: true, status: 200, data: { ok: true } }),
                        (err: any) => ({ ok: false, status: 500, data: { error: String(err) } })
                      );
                    })()
                  : type === "archive_memory"
                    ? (() => {
                        const id = String(payload["id"] ?? "");
                        if (!id) return Promise.resolve({ ok: false, status: 400, data: { error: "missing_memory_id" } });
                        return archiveDiscordAgentMemory({ id }).then(
                          () => ({ ok: true, status: 200, data: { ok: true } }),
                          (err: any) => ({ ok: false, status: 500, data: { error: String(err) } })
                        );
                      })()
                  : type === "ops_diagnose"
                    ? (async () => {
                        const tz = typeof payload["tz"] === "string" ? String(payload["tz"]) : defaultReportTz;
                        const channelId =
                          typeof payload["discordChannelId"] === "string" ? String(payload["discordChannelId"]) : String(message.channelId);
                        const content = await buildOpsDiagnosticsMarkdown({ tz }).catch((e: any) => `ops_diagnose_failed: ${String(e)}`);
                        const channel = await client.channels.fetch(channelId).catch(() => null);
                        if (channel && typeof (channel as any).isTextBased === "function" && (channel as any).isTextBased()) {
                          await (channel as any).send(String(content).slice(0, 1900));
                        }
                        return { ok: true, status: 200, data: { ok: true } };
                      })()
                : await executeAgentAction({
                    siteUrl,
                    botKey,
                    type,
                    payload
                  });
          results.push({
            type,
            ok: exec.ok,
            status: exec.status,
            error: exec.ok ? undefined : exec.data?.error ?? "failed"
          });
          if (!exec.ok) break;
        }

        const ok = results.every((r) => r.ok);
        await markDiscordActionIntentExecuted({
          id: intent.id,
          ok,
          result: { results }
        });

        const summaryLines = results.map((r) => `${r.ok ? "OK" : "FAIL"} ${r.type} (${r.status})${r.error ? `: ${r.error}` : ""}`);
        await message.reply([ok ? "Done." : "Stopped (an action failed).", "", ...summaryLines].join("\n"));
        return;
      }

      if (dmOnly && !isDm) return;
      const botUserId = client.user?.id;
      if (!botUserId) return;

      const trimmed = message.content.trim();
      if (reportsEnabled && trimmed) {
        const reportIntent = detectDailyReportIntent(trimmed);
        if (reportIntent?.kind === "run") {
          const rangeDays =
            typeof reportIntent.comparisonRangeDays === "number" && Number.isFinite(reportIntent.comparisonRangeDays)
              ? reportIntent.comparisonRangeDays
              : 7;
          const content = await buildDailyOpsReportMarkdown({ tz: defaultReportTz, comparisonRangeDays: rangeDays });
          await message.reply(String(content).slice(0, 1900));
          return;
        }

        if (reportIntent?.kind === "subscribe") {
          const timeOfDay = reportIntent.timeOfDay ?? defaultReportTime;
          const timezone = pickTimezoneFromText(trimmed, defaultReportTz);
          const response = await message.reply(
            `Got it. I can post the daily ops report in this channel every day at ${timeOfDay} (${timezone}). Reply \`approve\` to turn it on (or \`cancel\`).`
          );

          const expiresAt = intentTtlMinutes > 0 ? new Date(Date.now() + intentTtlMinutes * 60_000) : null;
          await createDiscordActionIntent({
            discordGuildId: message.guildId ? String(message.guildId) : null,
            discordChannelId: String(message.channelId),
            discordIntentMessageId: String(response.id),
            requestedByDiscordUserId: String(message.author.id),
            requestText: trimmed,
            agentReply: "subscribe_daily_ops_report",
            actions: [
              {
                type: "subscribe_daily_ops_report",
                summary: `Subscribe this channel to daily ops report at ${timeOfDay} (${timezone})`,
                payload: {
                  discordGuildId: message.guildId ? String(message.guildId) : null,
                  discordChannelId: String(message.channelId),
                  reportType: "daily_ops",
                  timezone,
                  timeOfDay
                }
              }
            ],
            expiresAt
          });
          return;
        }

        if (reportIntent?.kind === "unsubscribe") {
          const response = await message.reply(
            "Okay — I can stop posting the daily ops report in this channel. Reply `approve` to confirm (or `cancel`)."
          );

          const expiresAt = intentTtlMinutes > 0 ? new Date(Date.now() + intentTtlMinutes * 60_000) : null;
          await createDiscordActionIntent({
            discordGuildId: message.guildId ? String(message.guildId) : null,
            discordChannelId: String(message.channelId),
            discordIntentMessageId: String(response.id),
            requestedByDiscordUserId: String(message.author.id),
            requestText: trimmed,
            agentReply: "unsubscribe_daily_ops_report",
            actions: [
              {
                type: "unsubscribe_daily_ops_report",
                summary: "Unsubscribe this channel from daily ops report",
                payload: {
                  discordChannelId: String(message.channelId),
                  reportType: "daily_ops"
                }
              }
            ],
            expiresAt
          });
          return;
        }
      }

      if (memoryEnabled && trimmed) {
        const recall = detectRecallIntent(trimmed);
        if (recall) {
          const rows = await searchDiscordAgentMemory({
            discordGuildId: message.guildId ? String(message.guildId) : null,
            discordChannelId: String(message.channelId),
            q: recall.q,
            maxItems: 8
          }).catch(() => []);
          if (!rows.length) {
            await message.reply("I don’t have anything saved about that yet.");
            return;
          }
          const lines = rows.slice(0, 8).map((r: any) => `- ${formatMemoryCandidateLine(r)}\n  ${String(r.content ?? "").trim().slice(0, 320)}`);
          await message.reply(["Here’s what I have saved:", "", ...lines].join("\n").slice(0, 1900));
          return;
        }

        const remember = detectRememberIntent(trimmed);
        if (remember) {
          const content = remember.content.trim();
          const title = content.length > 80 ? `${content.slice(0, 77)}…` : content;
          const scope = remember.scope ?? "channel";
          const pinned = Boolean(remember.pinned);
          const response = await message.reply(
            `Got it. I can save this to memory (${scope}${pinned ? ", pinned" : ""}). Reply \`approve\` to save (or \`cancel\`).`
          );
          const expiresAt = intentTtlMinutes > 0 ? new Date(Date.now() + intentTtlMinutes * 60_000) : null;
          await createDiscordActionIntent({
            discordGuildId: message.guildId ? String(message.guildId) : null,
            discordChannelId: String(message.channelId),
            discordIntentMessageId: String(response.id),
            requestedByDiscordUserId: String(message.author.id),
            requestText: trimmed,
            agentReply: "remember_memory",
            actions: [
              {
                type: "remember_memory",
                summary: `Save memory: ${title}`,
                payload: {
                  discordGuildId: message.guildId ? String(message.guildId) : null,
                  discordChannelId: String(message.channelId),
                  scope,
                  memoryType: "note",
                  title,
                  content,
                  pinned
                }
              }
            ],
            expiresAt
          });
          return;
        }

        const forget = detectForgetIntent(trimmed);
        if (forget) {
          const rows = await searchDiscordAgentMemory({
            discordGuildId: message.guildId ? String(message.guildId) : null,
            discordChannelId: String(message.channelId),
            q: forget.q,
            maxItems: 5
          }).catch(() => []);
          if (rows.length !== 1) {
            const lines = rows.slice(0, 5).map((r: any) => `- ${String(r.id).slice(0, 8)}… ${formatMemoryCandidateLine(r)}`);
            await message.reply(
              [
                "Tell me which memory to remove by ID (example: `forget 123e4567-...`).",
                ...(lines.length ? ["", "Matches:", ...lines] : [])
              ].join("\n").slice(0, 1900)
            );
            return;
          }

          const match = rows[0] as any;
          const response = await message.reply(
            `I can archive this memory: ${formatMemoryCandidateLine(match)}. Reply \`approve\` to confirm (or \`cancel\`).`
          );
          const expiresAt = intentTtlMinutes > 0 ? new Date(Date.now() + intentTtlMinutes * 60_000) : null;
          await createDiscordActionIntent({
            discordGuildId: message.guildId ? String(message.guildId) : null,
            discordChannelId: String(message.channelId),
            discordIntentMessageId: String(response.id),
            requestedByDiscordUserId: String(message.author.id),
            requestText: trimmed,
            agentReply: "archive_memory",
            actions: [
              {
                type: "archive_memory",
                summary: `Archive memory: ${String(match.title ?? "").trim() || String(match.id)}`,
                payload: { id: String(match.id) }
              }
            ],
            expiresAt
          });
          return;
        }
      }
      const mentioned = message.mentions?.has?.(botUserId) ?? false;
      const prefixed = trimmed.toLowerCase().startsWith(commandPrefix.toLowerCase());
      const wake = stripWakeWord(trimmed, wakeWords);

      if (!isDm && !respondAll) {
        if (requireMention && !mentioned && !prefixed && !wake.matched) return;
        if (!requireMention && !mentioned && !prefixed && !wake.matched) return;
      }

      let prompt = trimmed;
      if (prefixed) {
        prompt = prompt.slice(commandPrefix.length).trim();
      } else if (mentioned) {
        prompt = stripBotMention(prompt, botUserId);
      } else if (wake.matched) {
        prompt = wake.prompt;
      }
      if (!prompt) {
        await message.reply("Yep — what do you need?");
        return;
      }

      const transcript =
        Number.isFinite(contextLimit) && contextLimit > 0
          ? await buildDiscordTranscript(message, Math.floor(contextLimit))
          : [];
      const memorySystem = await getMemoryContext({
        guildId: message.guildId ? String(message.guildId) : null,
        channelId: String(message.channelId)
      });
      const transcriptSystem = transcript.length ? formatTranscriptForSystem(transcript) : "";
      const system = [memorySystem, transcriptSystem].filter((v) => v && v.trim().length).join("\n\n");

      const agentRes = await callAgentChat({ siteUrl, botKey, message: prompt, system });
      const replyText = (agentRes.reply ?? "").trim() || "Okay.";
      const actions = splitActions(agentRes.actions ?? []);

      const lines: string[] = [];
      lines.push(replyText);

      if (actions.length) {
        lines.push("", "**Proposed action(s)**");
        actions.forEach((a, idx) => lines.push(`${idx + 1}) ${a.summary ?? a.type}`));

        const needsPick = actions.find(
          (a) => (a.type === "send_text" || a.type === "book_appointment") && !getContactId(a) && getCandidates(a).length > 1
        );
        const singlePick = actions.find(
          (a) => (a.type === "send_text" || a.type === "book_appointment") && !getContactId(a) && getCandidates(a).length === 1
        );
        const needsApptPick = actions.find(
          (a) =>
            (a.type === "cancel_appointment" || a.type === "reschedule_appointment") &&
            !getAppointmentId(a) &&
            getAppointmentCandidates(a).length > 1
        );
        const singleApptPick = actions.find(
          (a) =>
            (a.type === "cancel_appointment" || a.type === "reschedule_appointment") &&
            !getAppointmentId(a) &&
            getAppointmentCandidates(a).length === 1
        );

        if (needsPick) {
          const candidates = getCandidates(needsPick);
          const candidateLines = candidates.slice(0, 8).map((c, idx) => `${idx + 1}) ${formatCandidateLine(c)}`);
          lines.push("", `Pick a contact for \`${needsPick.type}\`:` , ...candidateLines, "", "Reply `approve N` to run (or `cancel`).");
        } else if (needsApptPick) {
          const candidates = getAppointmentCandidates(needsApptPick);
          const candidateLines = candidates.slice(0, 8).map((c, idx) => `${idx + 1}) ${formatAppointmentCandidateLine(c)}`);
          lines.push("", `Pick an appointment for \`${needsApptPick.type}\`:` , ...candidateLines, "", "Reply `approve N` to run (or `cancel`).");
        } else if (singlePick || singleApptPick) {
          lines.push("", "Reply `approve` to run (or `cancel`).");
        } else {
          lines.push("", "Reply `approve` to run (or `cancel`).");
        }
      }

      const response = await message.reply(lines.join("\n").slice(0, 1900));

      if (actions.length) {
        const expiresAt = intentTtlMinutes > 0 ? new Date(Date.now() + intentTtlMinutes * 60_000) : null;
        await createDiscordActionIntent({
          discordGuildId: message.guildId ? String(message.guildId) : null,
          discordChannelId: String(message.channelId),
          discordIntentMessageId: String(response.id),
          requestedByDiscordUserId: String(message.author.id),
          requestText: prompt,
          agentReply: replyText,
          actions: actions as unknown as Array<Record<string, unknown>>,
          expiresAt
        });
      }
    } catch (error) {
      console.warn("[discord-agent] message_failed", String(error));
      try {
        await message.reply("Something went wrong on my side. Try again in a minute.");
      } catch {}
    }
  });

  await client.login(discordToken);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
