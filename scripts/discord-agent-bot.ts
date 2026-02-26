import "dotenv/config";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

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

async function callAgentChat(input: {
  siteUrl: string;
  botKey: string;
  message: string;
}): Promise<AgentChatResponse> {
  const res = await fetch(`${input.siteUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-stonegate-bot-key": input.botKey
    },
    body: JSON.stringify({ mode: "team", message: input.message })
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

async function main() {
  const {
    createDiscordActionIntent,
    findPendingDiscordActionIntentByBotMessageId,
    markDiscordActionIntentApproved,
    cancelDiscordActionIntent,
    markDiscordActionIntentExecuted
  } = await import("../apps/api/src/lib/discord-agent-intents");

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
  const wakeWords = parseCsv(process.env["DISCORD_WAKE_WORDS"] ?? "jarvis,stonegate assist,stonegate");
  const intentTtlMinutes = Number(process.env["DISCORD_INTENT_TTL_MIN"] ?? 30);

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
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!(await isAuthorized(message))) return;

      const approval = parseApproval(message.content);
      const referencedId = message.reference?.messageId;
      if (approval && referencedId) {
        const intent = await findPendingDiscordActionIntentByBotMessageId(String(referencedId));
        if (!intent) {
          await message.reply("I don’t see a pending action for that message.");
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

        const approved = await markDiscordActionIntentApproved(intent.id, String(message.author.id));
        if (!approved) {
          await message.reply("That action is no longer pending.");
          return;
        }

        const pickIndex = approval.pick && Number.isFinite(approval.pick) ? Math.max(1, approval.pick) : null;

        const normalizedActions = actions.map((action) => {
          const existingId = getContactId(action);
          if (existingId) return action;
          const candidates = getCandidates(action);
          if (candidates.length === 1) return withPickedContactId(action, candidates[0].id);
          if (pickIndex && pickIndex <= candidates.length) return withPickedContactId(action, candidates[pickIndex - 1].id);
          return action;
        });

        const missing = normalizedActions.find((action) => {
          if (action.type === "send_text" || action.type === "book_appointment") {
            return !getContactId(action);
          }
          return false;
        });

        if (missing) {
          const candidates = getCandidates(missing);
          const lines = candidates.slice(0, 8).map((c, idx) => `${idx + 1}) ${formatCandidateLine(c)}`);
          await markDiscordActionIntentExecuted({
            id: intent.id,
            ok: false,
            error: "missing_contact_selection",
            result: { missingAction: missing.type, candidates: candidates.map((c) => c.id) }
          });
          await message.reply(
            [
              `I need you to pick which contact for \`${missing.type}\`.`,
              ...(lines.length ? ["", ...lines] : []),
              "",
              "Reply `approve N` (as a reply to my read-back) to run it, where N is the contact number above."
            ].join("\n")
          );
          return;
        }

        const results: Array<{ type: string; ok: boolean; status: number; error?: string }> = [];
        for (const action of normalizedActions) {
          const exec = await executeAgentAction({
            siteUrl,
            botKey,
            type: action.type,
            payload: action.payload
          });
          results.push({
            type: action.type,
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
      if (approval && !referencedId) return;

      const isDm = !message.inGuild?.();
      const botUserId = client.user?.id;
      if (!botUserId) return;

      const trimmed = message.content.trim();
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

      const agentRes = await callAgentChat({ siteUrl, botKey, message: prompt });
      const replyText = (agentRes.reply ?? "").trim() || "Okay.";
      const actions = splitActions(agentRes.actions ?? []);

      const lines: string[] = [];
      lines.push(replyText);

      if (actions.length) {
        lines.push("", "**Proposed action(s)**");
        actions.forEach((a, idx) => lines.push(`${idx + 1}) ${a.summary ?? a.type}`));

        const needsPick = actions.find((a) => (a.type === "send_text" || a.type === "book_appointment") && !getContactId(a) && getCandidates(a).length > 1);
        const singlePick = actions.find((a) => (a.type === "send_text" || a.type === "book_appointment") && !getContactId(a) && getCandidates(a).length === 1);

        if (needsPick) {
          const candidates = getCandidates(needsPick);
          const candidateLines = candidates.slice(0, 8).map((c, idx) => `${idx + 1}) ${formatCandidateLine(c)}`);
          lines.push("", `Pick a contact for \`${needsPick.type}\`:` , ...candidateLines, "", "Reply `approve N` to run (or `cancel`).");
        } else if (singlePick) {
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
