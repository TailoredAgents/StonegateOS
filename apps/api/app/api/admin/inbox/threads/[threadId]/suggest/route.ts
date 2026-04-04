import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb,
  properties
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { getBusinessHoursPolicy, getCompanyProfilePolicy, getConversationPersonaPolicy, getSalesAutopilotPolicy, getServiceAreaPolicy, getTemplatesPolicy, isGeorgiaPostalCode, isPostalCodeAllowed, normalizePostalCode, resolveTemplateForChannel } from "@/lib/policy";
import { isAdminRequest } from "../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { loadOmniLeadContext } from "@/lib/omni-lead-context";
import { loadOmniThreadFacts } from "@/lib/omni-thread-context";
import { buildSalesAgentMemory, upsertSalesAgentMemory } from "@/lib/sales-agent-memory";
import { buildSalesAgentNextAction, getSalesAgentNextAction, upsertSalesAgentNextAction } from "@/lib/sales-agent-next-action";
import { ensureInboxThreadForContactChannel } from "@/lib/inbox";
import { getDmOpeningStrategy } from "@/lib/dm-autopilot";
import { loadChannelHandoffOutcomeSummary } from "@/lib/channel-handoff-outcomes";
import { loadFirstResponseOutcomeSummary } from "@/lib/first-response-outcomes";
import { getMediaJobAnalysis } from "@/lib/media-job-analysis";
import { loadAppointmentPreservationOutcomeSummary } from "@/lib/appointment-preservation-outcomes";
import { loadAppointmentReminderOutcomeSummary } from "@/lib/appointment-reminder-outcomes";
import { loadMediaQuoteOutcomeSummary } from "@/lib/media-quote-outcomes";
import { loadMissingInfoOutcomeSummary } from "@/lib/missing-info-outcomes";
import { loadObjectionSaveOutcomeSummary } from "@/lib/objection-save-outcomes";
import { loadQuoteFollowupOutcomeSummary } from "@/lib/quote-followup-outcomes";
import { loadQuoteAccuracyOutcomeSummary } from "@/lib/quote-accuracy-outcomes";
import { loadQuoteHotWindowOutcomeSummary } from "@/lib/quote-hot-window-outcomes";
import { loadQuoteCloseOutcomeSummary } from "@/lib/quote-close-outcomes";
import { loadReactivationOutcomeSummary } from "@/lib/reactivation-outcomes";

type ReplyChannel = "sms" | "email" | "dm";

type DatabaseClient = ReturnType<typeof getDb>;
type Tx = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer T) => Promise<unknown>
  ? T
  : never;

type ThreadContext = {
  id: string;
  channel: string;
  subject: string | null;
  state: string;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPhoneE164: string | null;
  propertyId: string | null;
  propertyPostalCode: string | null;
  propertyAddressLine1: string | null;
  propertyCity: string | null;
  propertyState: string | null;
};

type MessageContext = {
  id: string;
  direction: string;
  channel: string;
  subject: string | null;
  body: string;
  createdAt: Date;
  participantName: string | null;
  metadata: Record<string, unknown> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReplyChannel(value: string | null | undefined): value is ReplyChannel {
  return value === "sms" || value === "email" || value === "dm";
}

function isAiSuggestedDraft(meta: Record<string, unknown> | null | undefined): boolean {
  return Boolean(meta?.["draft"] === true && meta?.["aiSuggested"] === true);
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isSafePlannerFollowupAction(actionType: string | null | undefined): boolean {
  return (
    actionType === "missed_call_recovery" ||
    actionType === "appointment_checkin" ||
    actionType === "dm_sms_handoff" ||
    actionType === "follow_up_quote" ||
    actionType === "collect_missing_info" ||
    actionType === "handle_price_objection"
  );
}

function isPlannerProactiveDraftEligible(input: {
  actionType: string | null | undefined;
  status: string | null | undefined;
  dueAt: string | null | undefined;
  now: Date;
}): boolean {
  if (!isSafePlannerFollowupAction(input.actionType)) return false;
  if (input.status === "dismissed" || input.status === "blocked") return false;
  const dueAt = parseIsoDate(input.dueAt);
  if (!dueAt) return true;
  return dueAt.getTime() <= input.now.getTime();
}

function didCustomerAskAboutPrice(messages: MessageContext[]): boolean {
  const text = messages
    .filter((m) => m.direction === "inbound")
    .map((m) => m.body)
    .join("\n")
    .toLowerCase();
  return /\b(price|pricing|quote|cost|how much|estimate)\b/.test(text) || /\$\s*\d/.test(text);
}

function readEnvString(key: string): string | null {
  const value = process.env[key];
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function getOpenAIConfig(): { apiKey: string; thinkModel: string | null; writeModel: string } | null {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) return null;
  const thinkModel = readEnvString("OPENAI_INBOX_SUGGEST_THINK_MODEL") ?? null;
  const writeModel =
    readEnvString("OPENAI_INBOX_SUGGEST_WRITE_MODEL") ??
    readEnvString("OPENAI_INBOX_SUGGEST_MODEL") ??
    readEnvString("OPENAI_MODEL") ??
    "ft:gpt-4.1-mini-2025-04-14:tailored-agents:devon:CyO8flN3";
  return { apiKey, thinkModel, writeModel };
}

type ReasoningEffort = "low" | "medium" | "high";

function supportsReasoningEffort(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("gpt-5") || normalized.startsWith("o");
}

function tryParseJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // continue
  }

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (unfenced !== trimmed) {
    try {
      return JSON.parse(unfenced) as unknown;
    } catch {
      // continue
    }
  }

  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const sliced = unfenced.slice(start, end + 1);
    try {
      return JSON.parse(sliced) as unknown;
    } catch {
      return null;
    }
  }

  return null;
}

async function callOpenAIJsonSchema(input: {
  apiKey: string;
  model: string;
  fallbackModels?: string[];
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  schemaName: string;
  schema: Record<string, unknown>;
  reasoningEffort?: ReasoningEffort;
}): Promise<
  | { ok: true; value: unknown; modelUsed: string }
  | { ok: false; error: string; detail?: string | null; modelUsed: string }
> {
  async function request(targetModel: string) {
    const payload: Record<string, unknown> = {
      model: targetModel,
      input: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt }
      ],
      max_output_tokens: input.maxOutputTokens,
      text: {
        verbosity: "medium",
        format: {
          type: "json_schema",
          name: input.schemaName,
          strict: true,
          schema: input.schema
        }
      }
    };

    if (input.reasoningEffort && supportsReasoningEffort(targetModel)) {
      payload["reasoning"] = { effort: input.reasoningEffort };
    }

    return fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify(payload)
    });
  }

  const modelsToTry = [input.model, ...(input.fallbackModels ?? [])].filter(
    (model, index, list) => model.trim().length > 0 && list.indexOf(model) === index
  );

  let lastError: { error: string; detail?: string | null } = { error: "openai_request_failed" };

  for (const model of modelsToTry) {
    let response = await request(model);
    if (!response.ok) {
      const status = response.status;
      const bodyText = await response.text().catch(() => "");
      const isDev = process.env["NODE_ENV"] !== "production";
      if (isDev && (status === 400 || status === 404) && model !== "gpt-5") {
        response = await request("gpt-5");
        if (!response.ok) {
          const fallbackText = await response.text().catch(() => "");
          console.warn("[inbox.suggest] openai.fallback_failed", { status: response.status, bodyText: fallbackText });
          lastError = { error: "openai_request_failed", detail: fallbackText.slice(0, 300) };
          continue;
        }
      } else {
        console.warn("[inbox.suggest] openai.request_failed", { status, bodyText });
        lastError = { error: "openai_request_failed", detail: bodyText.slice(0, 300) };
        continue;
      }
    }

    try {
      const data = (await response.json()) as {
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
        output_text?: string;
      };
      const raw =
        (typeof data.output_text === "string" ? data.output_text : null) ??
        data.output
          ?.flatMap((item) => item.content ?? [])
          .find((chunk) => typeof chunk.text === "string")
          ?.text ??
        null;
      if (!raw) {
        lastError = { error: "openai_empty_response" };
        continue;
      }
      const parsed = tryParseJsonObject(raw);
      if (!parsed) {
        lastError = { error: "openai_parse_failed" };
        continue;
      }
      return { ok: true, value: parsed, modelUsed: model };
    } catch (error) {
      console.warn("[inbox.suggest] openai.response_error", { error: String(error) });
      lastError = { error: "openai_parse_failed" };
      continue;
    }
  }

  const modelUsed = modelsToTry[modelsToTry.length - 1] ?? input.model;
  return { ok: false, modelUsed, error: lastError.error, detail: lastError.detail ?? null };
}

type ReplySuggestion = { body: string; subject: string };

function isReplySuggestion(value: unknown): value is ReplySuggestion {
  if (!isRecord(value)) return false;
  return typeof value["body"] === "string" && typeof value["subject"] === "string";
}

type ReplyPlan = {
  intent: string;
  tone: string;
  facts: string[];
  questions: string[];
  next_action: string;
  constraints: string[];
};

function isReplyPlan(value: unknown): value is ReplyPlan {
  if (!isRecord(value)) return false;
  if (typeof value["intent"] !== "string") return false;
  if (typeof value["tone"] !== "string") return false;
  if (!Array.isArray(value["facts"]) || !value["facts"].every((item) => typeof item === "string")) return false;
  if (!Array.isArray(value["questions"]) || !value["questions"].every((item) => typeof item === "string")) return false;
  if (typeof value["next_action"] !== "string") return false;
  if (!Array.isArray(value["constraints"]) || !value["constraints"].every((item) => typeof item === "string")) return false;
  return true;
}

function stripDashLikeChars(text: string): string {
  return text
    .replace(/[-–—]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function containsDashLikeChars(text: string): boolean {
  return /[-–—]/.test(text);
}

const REPLY_SUGGESTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    body: { type: "string" },
    subject: { type: "string" }
  },
  required: ["body", "subject"]
};

const REPLY_PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string" },
    tone: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
    next_action: { type: "string" },
    constraints: { type: "array", items: { type: "string" } }
  },
  required: ["intent", "tone", "facts", "questions", "next_action", "constraints"]
};

async function ensureAiParticipant(tx: Tx, threadId: string, now: Date) {
  const [existing] = await tx
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        eq(conversationParticipants.participantType, "team"),
        eq(conversationParticipants.displayName, "Stonegate Assist"),
        sql`${conversationParticipants.teamMemberId} is null`
      )
    )
    .limit(1);

  if (existing?.id) return existing.id;

  const [created] = await tx
    .insert(conversationParticipants)
    .values({
      threadId,
      participantType: "team",
      teamMemberId: null,
      displayName: "Stonegate Assist",
      createdAt: now
    })
    .returning({ id: conversationParticipants.id });

  return created?.id ?? null;
}

function buildTranscript(messages: MessageContext[]): string {
  const lines = messages.map((message) => {
    const who = message.participantName ?? (message.direction === "inbound" ? "Customer" : "Team");
    const subject = message.subject ? ` (subject: ${message.subject})` : "";
    return `[${message.createdAt.toISOString()}] ${who}${subject}: ${message.body}`;
  });
  return lines.join("\n");
}

function buildPlannerInstruction(
  actionType: string | null | undefined,
  replyChannel: ReplyChannel,
): string | null {
  switch (actionType) {
    case "reply_now":
      return replyChannel === "dm"
        ? "Reply promptly in a short Messenger-chat style. Answer the latest inbound directly without sounding formal."
        : "Reply promptly, keep momentum, and answer the latest inbound directly.";
    case "missed_call_recovery":
      return "Write a short missed-call recovery text that gets the lead talking again without overcomplicating it.";
    case "appointment_checkin":
      return "Write a short pre-appointment check-in that reassures the customer, keeps the booking warm, and makes it easy for them to flag any issue before the appointment.";
    case "dm_sms_handoff":
      return "Write a short SMS that naturally picks up the earlier Messenger conversation and moves the lead into texting without sounding robotic.";
    case "call_now":
      return "Write a short reply that supports an immediate phone follow up and confirms availability to talk now.";
    case "follow_up_quote":
      return replyChannel === "dm"
        ? "Write a light Messenger follow-up that feels like a real chat. Keep it to one easy nudge toward booking, not a formal sales follow-up."
        : "Nudge the customer toward booking by reinforcing the quote, reducing hesitation, and asking for the booking decision.";
    case "collect_missing_info":
      return replyChannel === "dm"
        ? "Ask for exactly one missing detail in casual Messenger style. Make it feel quick and easy, and briefly say why that one detail helps."
        : "Ask for only one missing detail, and make it obvious why that one detail unlocks the next step.";
    case "handle_price_objection":
      return replyChannel === "dm"
        ? "Handle the price objection in a calm Messenger style. Keep it short, useful, and non-defensive."
        : "Address price resistance calmly, reinforce value, and try to keep the lead alive without sounding defensive.";
    case "wait_for_appointment":
      return "Do not re-qualify the lead. Only support the scheduled appointment and keep the message light.";
    case "human_follow_up":
      return "Keep the reply minimal and safe. Do not make new promises beyond acknowledged context.";
    default:
      return null;
  }
}

function buildChannelStyleInstruction(
  replyChannel: ReplyChannel,
  actionType: string | null | undefined,
): string | null {
  if (replyChannel !== "dm") return null;

  if (actionType === "follow_up_quote") {
    return "Messenger tone: 1 or 2 short sentences, one easy question max, no corporate 'following up on your quote request' phrasing, and no long explanation of pricing unless they ask.";
  }

  if (actionType === "collect_missing_info") {
    return "Messenger tone: ask for one thing only, keep it conversational, and make the request feel low-friction, like a quick reply or photo.";
  }

  if (actionType === "appointment_checkin") {
    return "Messenger tone: keep the check-in light and reassuring. Do not sound like an automated reminder blast or re-sell the job.";
  }

  if (actionType === "reply_now" || actionType === "handle_price_objection") {
    return "Messenger tone: write like a real Facebook chat. Keep it short, natural, and easy to reply to.";
  }

  return "Messenger tone: write like a short Facebook chat, not like an email or formal text script.";
}

function buildDmSalesAngleInstruction(input: {
  replyChannel: ReplyChannel;
  actionType: string | null | undefined;
  objections: string[];
}): string | null {
  if (input.replyChannel !== "dm") return null;

  const objections = new Set(input.objections);

  if (input.actionType === "follow_up_quote") {
    if (objections.has("price") || objections.has("comparison_shopping")) {
      return "Messenger sales angle: if they seem price-sensitive or are comparing companies, keep it short. Reinforce fairness and ease, do not dump a long value pitch, and end with one simple question that keeps the lead alive.";
    }
    if (objections.has("timing") || objections.has("decision_maker")) {
      return "Messenger sales angle: if they are thinking about it or need to check with someone, acknowledge that lightly and make the next step easy. Do not pressure. Offer a simple reopen question instead of a hard close.";
    }
    return "Messenger sales angle: push gently toward booking with one low-friction question, not a formal follow-up paragraph.";
  }

  if (input.actionType === "handle_price_objection") {
    if (objections.has("comparison_shopping")) {
      return "Messenger objection angle: answer like a confident human, not a script. Briefly separate Stonegate on speed, service, or reliability, and ask one soft question to keep the conversation moving.";
    }
    return "Messenger objection angle: address price calmly in 1 or 2 short sentences. Do not sound defensive. Keep the goal on reopening the conversation, not winning a debate.";
  }

  return null;
}

function buildDmOpeningInstruction(input: {
  replyChannel: ReplyChannel;
  actionType: string | null | undefined;
  messages: MessageContext[];
  memoryMissingFields: string[];
}): string | null {
  if (input.replyChannel !== "dm") return null;

  const opening = getDmOpeningStrategy(
    input.messages.map((message) => ({
      channel: message.channel,
      direction: message.direction,
      body: message.body,
    })),
  );

  if (opening.openingType === "lead_card") {
    return [
      "Messenger opening: this lead looks like a Facebook lead-card opener, not a normal typed first message.",
      "Acknowledge briefly, then move straight to the next useful step.",
      "Do not re-ask for basics that may already be in the lead card or CRM memory, like name, phone, ZIP, or timing, unless they are still truly missing.",
      input.actionType === "collect_missing_info" && input.memoryMissingFields.length > 0
        ? `If you ask for more info, ask for just one thing from this list: ${input.memoryMissingFields.join(", ")}.`
        : "If more info is needed, ask for only one easy thing, like a photo or one missing job detail.",
      "Keep it short and friendly, like picking up a conversation that already started.",
    ].join(" ");
  }

  if (opening.openingType === "mixed") {
    return [
      "Messenger opening: this thread started from lead-card info but now has real typed customer messages.",
      "Treat the typed message as the live conversation.",
      "Still avoid re-asking for basics already captured from the lead card or CRM memory.",
    ].join(" ");
  }

  if (opening.openingType === "typed_message") {
    return "Messenger opening: this is a normal typed DM conversation, so respond naturally to the latest message instead of using a lead-form style opener.";
  }

  return null;
}

function buildMediaReplyInstruction(input: {
  mediaAnalysis:
    | {
        source?: string | null;
        videoCount?: number | null;
        visibleVolumeRange?: string | null;
        mergedVolumeRange?: string | null;
        confidence?: string | null;
        visibleMattressCount?: number | null;
        visiblePaintCanCount?: number | null;
        visibleTireCount?: number | null;
        missingViews?: string[] | null;
        riskFlags?: string[] | null;
        summary?: string | null;
      }
    | null;
  actionType: string | null | undefined;
}): string | null {
  const analysis = input.mediaAnalysis;
  if (!analysis) return null;

  const missingViews = Array.isArray(analysis.missingViews)
    ? analysis.missingViews.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
  const riskFlags = Array.isArray(analysis.riskFlags)
    ? analysis.riskFlags.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
  const hasVideo = typeof analysis.videoCount === "number" && analysis.videoCount > 0;
  const hasMergedRange =
    typeof analysis.mergedVolumeRange === "string" && analysis.mergedVolumeRange.trim().length > 0;
  const hasVisibleRange =
    typeof analysis.visibleVolumeRange === "string" && analysis.visibleVolumeRange.trim().length > 0;
  const confidence = typeof analysis.confidence === "string" ? analysis.confidence.trim().toLowerCase() : "";

  const baseRules = [
    hasVideo
      ? "Media reasoning: video frames were analyzed along with any photos, so you may refer to what the customer's media shows."
      : "Media reasoning: photos were analyzed, so you may refer to what the customer's media shows.",
    "Do not invent exact item counts or exact load size beyond the media-analysis facts.",
    "If you reference load size, talk in approximate trailer-range language, not false precision.",
    "Do not mention dollar amounts unless the customer explicitly asks about price, quote, cost, or estimate.",
  ];

  if (hasMergedRange && hasVisibleRange && analysis.mergedVolumeRange !== analysis.visibleVolumeRange) {
    baseRules.push(
      "The merged estimate is wider than the visible estimate because the written scope suggests extra unpictured junk. If helpful, acknowledge that the current range accounts for items mentioned but not fully shown."
    );
  }

  if ((input.actionType === "collect_missing_info" || confidence === "low") && missingViews.length > 0) {
    baseRules.push(
      `If you ask for more media, ask for exactly one highest-signal missing view: ${missingViews[0]}.`
    );
    if (input.actionType === "follow_up_quote" || input.actionType === "reply_now") {
      baseRules.push(
        "Because media confidence is low, do not act like the estimate is fully locked in. Prefer tightening the scope with one better angle before making a strong close push."
      );
    }
  } else if (missingViews.length > 0 && (input.actionType === "follow_up_quote" || input.actionType === "reply_now")) {
    baseRules.push(
      "Only bring up an extra photo/video angle if it clearly helps tighten the estimate or answer the customer's question."
    );
  }

  if (riskFlags.some((flag) => flag.includes("stated_scope_exceeds_visible_media"))) {
    baseRules.push(
      "Be careful not to talk like the media shows the entire job if the notes/text imply more junk than is visible."
    );
  }

  const addOnNotes = [
    (analysis.visibleMattressCount ?? 0) > 0 ? `mattresses=${analysis.visibleMattressCount}` : null,
    (analysis.visiblePaintCanCount ?? 0) > 0 ? `paint=${analysis.visiblePaintCanCount}` : null,
    (analysis.visibleTireCount ?? 0) > 0 ? `tires=${analysis.visibleTireCount}` : null,
  ].filter((item): item is string => Boolean(item));

  if (addOnNotes.length > 0) {
    baseRules.push(
      `Visible add-on items were detected (${addOnNotes.join(", ")}). Only mention them if the customer asks or if they matter to the current reply.`
    );
  }

  if (typeof analysis.summary === "string" && analysis.summary.trim().length > 0) {
    baseRules.push(`Media summary: ${analysis.summary.trim()}`);
  }

  return baseRules.join(" ");
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const { threadId } = await context.params;
  if (!threadId) {
    return NextResponse.json({ error: "thread_id_required" }, { status: 400 });
  }

  const config = getOpenAIConfig();
  if (!config) {
    return NextResponse.json({ error: "openai_not_configured" }, { status: 400 });
  }

  const db = getDb();
  const [thread] = await db
    .select({
      id: conversationThreads.id,
      channel: conversationThreads.channel,
      subject: conversationThreads.subject,
      state: conversationThreads.state,
      contactId: conversationThreads.contactId,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      propertyId: conversationThreads.propertyId,
      propertyPostalCode: properties.postalCode,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state
    })
    .from(conversationThreads)
    .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
    .leftJoin(properties, eq(conversationThreads.propertyId, properties.id))
    .where(eq(conversationThreads.id, threadId))
    .limit(1);

  if (!thread) {
    return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  }

  const replyChannel = thread.channel;
  if (!isReplyChannel(replyChannel)) {
    return NextResponse.json({ error: "unsupported_channel" }, { status: 400 });
  }

  let toAddress: string | null = null;
  let dmMetadata: Record<string, unknown> | null = null;

  if (replyChannel === "sms") {
    toAddress = thread.contactPhoneE164 ?? thread.contactPhone ?? null;
  } else if (replyChannel === "email") {
    toAddress = thread.contactEmail ?? null;
  } else {
    const [latestInboundDm] = await db
      .select({
        fromAddress: conversationMessages.fromAddress,
        metadata: conversationMessages.metadata
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.threadId, threadId),
          eq(conversationMessages.direction, "inbound"),
          eq(conversationMessages.channel, "dm")
        )
      )
      .orderBy(desc(conversationMessages.createdAt))
      .limit(1);

    toAddress = latestInboundDm?.fromAddress ?? null;
    dmMetadata = isRecord(latestInboundDm?.metadata) ? latestInboundDm!.metadata : null;
  }

  const messageRows = await db
    .select({
      id: conversationMessages.id,
      direction: conversationMessages.direction,
      channel: conversationMessages.channel,
      subject: conversationMessages.subject,
      body: conversationMessages.body,
      createdAt: conversationMessages.createdAt,
      participantName: conversationParticipants.displayName,
      metadata: conversationMessages.metadata
    })
    .from(conversationMessages)
    .leftJoin(conversationParticipants, eq(conversationMessages.participantId, conversationParticipants.id))
    .where(eq(conversationMessages.threadId, threadId))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(12);

  const messages: MessageContext[] = messageRows
    .map((row) => ({
      id: row.id,
      direction: row.direction,
      channel: row.channel,
      subject: row.subject ?? null,
      body: row.body,
      createdAt: row.createdAt,
      participantName: row.participantName ?? null,
      metadata: isRecord(row.metadata) ? row.metadata : null
    }))
    .reverse();

  const latestInboundMessage = [...messages]
    .reverse()
    .find((message) => message.direction === "inbound");
  const latestSentOutboundMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        message.direction === "outbound" && !Boolean(message.metadata?.["draft"] === true),
    );
  const latestAiDraftMessage = [...messages]
    .reverse()
    .find((message) => message.direction === "outbound" && isAiSuggestedDraft(message.metadata));

  const contactName = [thread.contactFirstName, thread.contactLastName].filter(Boolean).join(" ").trim();
  const threadContext: ThreadContext = {
    id: thread.id,
    channel: thread.channel,
    subject: thread.subject ?? null,
    state: thread.state,
    contactId: thread.contactId ?? null,
    contactName: contactName.length > 0 ? contactName : null,
    contactEmail: thread.contactEmail ?? null,
    contactPhone: thread.contactPhone ?? null,
    contactPhoneE164: thread.contactPhoneE164 ?? null,
    propertyId: thread.propertyId ?? null,
    propertyPostalCode: thread.propertyPostalCode ?? null,
    propertyAddressLine1: thread.propertyAddressLine1 ?? null,
    propertyCity: thread.propertyCity ?? null,
    propertyState: thread.propertyState ?? null
  };

  const [templates, serviceArea, businessHours, companyProfile, persona, autopilotPolicy] = await Promise.all([
    getTemplatesPolicy(db),
    getServiceAreaPolicy(db),
    getBusinessHoursPolicy(db),
    getCompanyProfilePolicy(db),
    getConversationPersonaPolicy(db),
    getSalesAutopilotPolicy(db),
  ]);

 const normalizedPostal = normalizePostalCode(threadContext.propertyPostalCode ?? null);
  const inGeorgia = normalizedPostal !== null ? isGeorgiaPostalCode(normalizedPostal) : null;
  const outsideUsualArea =
    normalizedPostal !== null && inGeorgia === true ? !isPostalCodeAllowed(normalizedPostal, serviceArea) : null;

  const omni = await loadOmniThreadFacts(db, {
    threadId,
    contactId: threadContext.contactId,
    threadPostalCode: threadContext.propertyPostalCode ?? null,
    includeQuotePrice: didCustomerAskAboutPrice(messages)
  });
  const leadContext = threadContext.contactId
    ? await loadOmniLeadContext(db, {
        contactId: threadContext.contactId,
        includeQuotePrice: didCustomerAskAboutPrice(messages),
      })
    : null;
  const builtSalesAgentMemory = leadContext ? buildSalesAgentMemory(leadContext) : null;
  const appointmentPreservationOutcomeSummary = leadContext ? await loadAppointmentPreservationOutcomeSummary(db) : null;
  const appointmentReminderOutcomeSummary = leadContext ? await loadAppointmentReminderOutcomeSummary(db) : null;
  const channelHandoffOutcomeSummary = leadContext ? await loadChannelHandoffOutcomeSummary(db) : null;
  const firstResponseOutcomeSummary = leadContext ? await loadFirstResponseOutcomeSummary(db) : null;
  const mediaOutcomeSummary = leadContext ? await loadMediaQuoteOutcomeSummary(db) : null;
  const missingInfoOutcomeSummary = leadContext ? await loadMissingInfoOutcomeSummary(db) : null;
  const objectionSaveOutcomeSummary = leadContext ? await loadObjectionSaveOutcomeSummary(db) : null;
  const quoteAccuracyOutcomeSummary = leadContext ? await loadQuoteAccuracyOutcomeSummary(db) : null;
  const quoteHotWindowOutcomeSummary = leadContext ? await loadQuoteHotWindowOutcomeSummary(db) : null;
  const quoteCloseOutcomeSummary = leadContext ? await loadQuoteCloseOutcomeSummary(db) : null;
  const quoteFollowupOutcomeSummary = leadContext ? await loadQuoteFollowupOutcomeSummary(db) : null;
  const reactivationOutcomeSummary = leadContext ? await loadReactivationOutcomeSummary(db) : null;
  const salesAgentMemory =
    threadContext.contactId && leadContext && builtSalesAgentMemory
      ? await upsertSalesAgentMemory(db, {
          contactId: threadContext.contactId,
          leadId: leadContext.latestLead?.id ?? null,
          memory: builtSalesAgentMemory,
        })
      : null;
  const salesAgentNextAction =
    threadContext.contactId && leadContext && builtSalesAgentMemory
      ? await upsertSalesAgentNextAction(db, {
          contactId: threadContext.contactId,
          leadId: leadContext.latestLead?.id ?? null,
          action: buildSalesAgentNextAction({
            context: leadContext,
            memory: builtSalesAgentMemory,
            appointmentPreservationOutcomeSummary,
            appointmentReminderOutcomeSummary,
            channelHandoffOutcomeSummary,
            firstResponseOutcomeSummary,
            missingInfoOutcomeSummary,
            objectionSaveOutcomeSummary,
            mediaOutcomeSummary,
            quoteAccuracyOutcomeSummary,
            quoteHotWindowOutcomeSummary,
            quoteCloseOutcomeSummary,
            reactivationOutcomeSummary,
            quoteFollowupOutcomeSummary,
            autopilotPolicy,
          }),
        })
      : null;
  const mediaAnalysis = threadContext.contactId
    ? await getMediaJobAnalysis(db, threadContext.contactId)
    : null;
  const now = new Date();
  const proactivePlannerEligible = isPlannerProactiveDraftEligible({
    actionType: salesAgentNextAction?.actionType ?? null,
    status: salesAgentNextAction?.status ?? null,
    dueAt: salesAgentNextAction?.dueAt?.toISOString?.() ?? null,
    now,
  });
  const plannerTargetChannel = isReplyChannel(salesAgentNextAction?.channel)
    ? salesAgentNextAction.channel
    : null;
  const targetReplyChannel: ReplyChannel =
    proactivePlannerEligible && plannerTargetChannel ? plannerTargetChannel : replyChannel;
  let draftThreadId = threadId;
  if (
    threadContext.contactId &&
    targetReplyChannel !== replyChannel
  ) {
    draftThreadId =
      (await ensureInboxThreadForContactChannel(db, {
        contactId: threadContext.contactId,
        channel: targetReplyChannel,
        now,
      })) ?? threadId;
  }
  const targetDraftRows =
    draftThreadId === threadId
      ? []
      : await db
          .select({
            id: conversationMessages.id,
            subject: conversationMessages.subject,
            body: conversationMessages.body,
            createdAt: conversationMessages.createdAt,
            metadata: conversationMessages.metadata,
          })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.threadId, draftThreadId),
              eq(conversationMessages.direction, "outbound"),
              sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') = 'true'`,
              sql`coalesce(${conversationMessages.metadata} ->> 'aiSuggested', 'false') = 'true'`
            ),
          )
          .orderBy(desc(conversationMessages.createdAt))
          .limit(1);
  const targetAiDraftMessage =
    draftThreadId === threadId
      ? latestAiDraftMessage
      : targetDraftRows[0]
        ? {
            id: targetDraftRows[0].id,
            direction: "outbound",
            channel: targetReplyChannel,
            subject: targetDraftRows[0].subject ?? null,
            body: targetDraftRows[0].body,
            createdAt: targetDraftRows[0].createdAt,
            participantName: null,
            metadata: isRecord(targetDraftRows[0].metadata) ? targetDraftRows[0].metadata : null,
          }
        : null;
  const targetToAddress =
    targetReplyChannel === "sms"
      ? thread.contactPhoneE164 ?? thread.contactPhone ?? null
      : targetReplyChannel === "email"
        ? thread.contactEmail ?? null
        : toAddress;
  const targetDmMetadata = targetReplyChannel === "dm" ? dmMetadata : null;

  const latestInboundMs = latestInboundMessage?.createdAt.getTime() ?? Number.NaN;
  const latestOutboundMs = latestSentOutboundMessage?.createdAt.getTime() ?? Number.NaN;
  const latestAiDraftMs = targetAiDraftMessage?.createdAt.getTime() ?? Number.NaN;
  const referenceMs = Number.isFinite(latestInboundMs)
    ? latestInboundMs
    : Number.isFinite(latestOutboundMs)
      ? latestOutboundMs
      : Number.NaN;

  if (
    salesAgentNextAction?.status === "dismissed" &&
    Number.isFinite(referenceMs) &&
    salesAgentNextAction.updatedAt.getTime() >= referenceMs
  ) {
    return NextResponse.json({
      ok: true,
      skipped: "dismissed",
      channel: targetReplyChannel,
      threadId: draftThreadId,
    });
  }

  if (
    Number.isFinite(latestAiDraftMs) &&
    ((Number.isFinite(referenceMs) && latestAiDraftMs >= referenceMs) ||
      (!Number.isFinite(referenceMs) && proactivePlannerEligible))
  ) {
    return NextResponse.json({
      ok: true,
      reused: true,
      messageId: targetAiDraftMessage!.id,
      channel: targetReplyChannel,
      threadId: draftThreadId,
      draft: {
        subject: targetReplyChannel === "email" ? targetAiDraftMessage?.subject ?? null : null,
        body: targetAiDraftMessage!.body,
      },
    });
  }

  if (Number.isFinite(latestInboundMs) && Number.isFinite(latestOutboundMs) && latestOutboundMs >= latestInboundMs) {
    if (!proactivePlannerEligible) {
      return NextResponse.json({
        ok: true,
        skipped: "already_replied",
        channel: targetReplyChannel,
        threadId: draftThreadId,
      });
    }
  } else if (!Number.isFinite(latestInboundMs) && !proactivePlannerEligible) {
    return NextResponse.json({
      ok: true,
      skipped: "no_draft_trigger",
      channel: targetReplyChannel,
      threadId: draftThreadId,
    });
  }

  const firstTouchExample = resolveTemplateForChannel(templates.first_touch, {
    inboundChannel: replyChannel,
    replyChannel: targetReplyChannel
  });
  const followUpExample = resolveTemplateForChannel(templates.follow_up, {
    inboundChannel: replyChannel,
    replyChannel: targetReplyChannel
  });
  const outOfAreaExample =
    targetReplyChannel === "email" || targetReplyChannel === "sms"
      ? resolveTemplateForChannel(templates.out_of_area, { inboundChannel: replyChannel, replyChannel: targetReplyChannel })
      : null;

 const systemPrompt = `
 ${persona.systemPrompt}
 Output ONLY JSON with keys: body (string), subject (string). Use an empty string for subject when not needed.
 Never mention price or dollar amounts unless the customer explicitly asks about price/quote/cost/estimate.
 Treat sales agent memory facts as current CRM truth unless the latest transcript clearly overrides them.
 Do not ask for info already present in the sales agent memory or omni context.
 Follow the planner recommendation unless the latest inbound message clearly makes it outdated.

 Business hours policy timezone: ${businessHours.timezone}
 Company notes: We can message any time, and we typically schedule jobs during business hours.

 Company profile facts (use as truth):
 Business: ${companyProfile.businessName}
 Phone: ${companyProfile.primaryPhone}
 Service area: ${companyProfile.serviceAreaSummary}
 Trailer/pricing: ${companyProfile.trailerAndPricingSummary}
 What we do: ${companyProfile.whatWeDo}
 What we do not do: ${companyProfile.whatWeDontDo}
 Booking style: ${companyProfile.bookingStyle}
 Notes: ${companyProfile.agentNotes}
  `.trim();

  const crossChannelRecentSummary =
    salesAgentNextAction?.actionType === "dm_sms_handoff" && leadContext
      ? leadContext.recentMessages
          .slice(-6)
          .map((message) => {
            const who = message.direction === "inbound" ? "Customer" : "Team";
            return `[${message.channel.toUpperCase()}] ${who}: ${message.body}`;
          })
          .join("\n")
      : null;

  const contextLines = [
    `Reply channel: ${targetReplyChannel}`,
    targetReplyChannel !== replyChannel ? `Source thread channel: ${replyChannel}` : null,
    `Thread state: ${threadContext.state}`,
    `Customer name: ${threadContext.contactName ?? "Unknown"}`,
    salesAgentMemory?.summary ? `Sales agent memory: ${salesAgentMemory.summary}` : null,
    salesAgentMemory?.customerIntent ? `Memory intent: ${salesAgentMemory.customerIntent}` : null,
    salesAgentMemory?.channelPreference ? `Preferred channel: ${salesAgentMemory.channelPreference}` : null,
    leadContext?.derived.dmEntrySource ? `Messenger entry source: ${leadContext.derived.dmEntrySource.replace(/_/g, " ")}` : null,
    salesAgentMemory?.bookingReadiness ? `Booking readiness: ${salesAgentMemory.bookingReadiness}` : null,
    salesAgentMemory?.quoteConfidence ? `Quote confidence: ${salesAgentMemory.quoteConfidence}` : null,
    mediaAnalysis
      ? `Media estimate: visible=${mediaAnalysis.visibleVolumeRange}, merged=${mediaAnalysis.mergedVolumeRange}, confidence=${mediaAnalysis.confidence}, mattresses=${mediaAnalysis.visibleMattressCount}, paint=${mediaAnalysis.visiblePaintCanCount}${Array.isArray(mediaAnalysis.missingViews) && mediaAnalysis.missingViews.length ? `, missing views=${mediaAnalysis.missingViews.join(" | ")}` : ""}`
      : null,
    Array.isArray(salesAgentMemory?.objections) && salesAgentMemory.objections.length
      ? `Known objections: ${salesAgentMemory.objections.join(", ")}`
      : null,
    Array.isArray(salesAgentMemory?.missingFields) && salesAgentMemory.missingFields.length
      ? `Memory missing fields: ${salesAgentMemory.missingFields.join(", ")}`
      : null,
    salesAgentMemory?.lastPromisedNextStep ? `Last promised next step: ${salesAgentMemory.lastPromisedNextStep}` : null,
    salesAgentMemory?.lastHumanSummary ? `Last human summary: ${salesAgentMemory.lastHumanSummary}` : null,
    salesAgentNextAction?.actionType ? `Planner action type: ${salesAgentNextAction.actionType}` : null,
    salesAgentNextAction?.summary ? `Planner summary: ${salesAgentNextAction.summary}` : null,
    salesAgentNextAction?.reason ? `Planner reason: ${salesAgentNextAction.reason}` : null,
    salesAgentNextAction?.priority ? `Planner priority: ${salesAgentNextAction.priority}` : null,
    salesAgentNextAction?.confidence ? `Planner confidence: ${salesAgentNextAction.confidence}` : null,
    salesAgentNextAction?.channel ? `Planner channel: ${salesAgentNextAction.channel}` : null,
    Array.isArray(salesAgentNextAction?.facts) && salesAgentNextAction.facts.length
      ? `Planner facts: ${salesAgentNextAction.facts.join(" | ")}`
      : null,
    buildPlannerInstruction(salesAgentNextAction?.actionType, targetReplyChannel),
    buildChannelStyleInstruction(targetReplyChannel, salesAgentNextAction?.actionType),
    buildDmOpeningInstruction({
      replyChannel: targetReplyChannel,
      actionType: salesAgentNextAction?.actionType,
      messages,
      memoryMissingFields: Array.isArray(salesAgentMemory?.missingFields) ? salesAgentMemory.missingFields : [],
    }),
    buildDmSalesAngleInstruction({
      replyChannel: targetReplyChannel,
      actionType: salesAgentNextAction?.actionType,
      objections: Array.isArray(salesAgentMemory?.objections) ? salesAgentMemory.objections : [],
    }),
    buildMediaReplyInstruction({
      mediaAnalysis,
      actionType: salesAgentNextAction?.actionType,
    }),
    omni.pipelineStage ? `Pipeline stage: ${omni.pipelineStage}` : null,
    omni.pipelineNotes ? `CRM notes:\n${omni.pipelineNotes}` : null,
    omni.latestLead
      ? `Latest lead: ${omni.latestLead.source ?? "unknown_source"} (${omni.latestLead.status}) at ${omni.latestLead.createdAt.toISOString()}`
      : null,
    omni.instantQuote
      ? `Instant quote on file: job types=${omni.instantQuote.jobTypes.join(", ") || "unknown"}, size=${omni.instantQuote.perceivedSize}, timeframe=${omni.instantQuote.timeframe}, photos=${omni.instantQuote.photoUrls.length}${omni.instantQuote.priceLow !== null && omni.instantQuote.priceHigh !== null ? `, range=$${omni.instantQuote.priceLow}-$${omni.instantQuote.priceHigh}` : ", price hidden unless asked"}`
      : null,
    omni.nextAppointment
      ? `Appointment on file: ${omni.nextAppointment.type} (${omni.nextAppointment.status}) at ${omni.nextAppointment.startAt ? omni.nextAppointment.startAt.toISOString() : "TBD"}`
      : null,
    omni.otherChannelThreads.length
      ? `Other channels:\n${omni.otherChannelThreads
          .map((t) => `- ${t.channel} last=${t.lastMessageAt ? t.lastMessageAt.toISOString() : "unknown"}: ${t.lastMessagePreview ?? ""}`)
          .join("\n")}`
      : null,
    omni.missingFields.length ? `Missing info (ask at most one): ${omni.missingFields.join(", ")}` : `Missing info: none`,
    threadContext.contactPhoneE164 || threadContext.contactPhone ? `Customer phone: ${threadContext.contactPhoneE164 ?? threadContext.contactPhone}` : null,
    threadContext.contactEmail ? `Customer email: ${threadContext.contactEmail}` : null,
    threadContext.propertyAddressLine1 ? `Property: ${threadContext.propertyAddressLine1}, ${threadContext.propertyCity ?? ""}, ${threadContext.propertyState ?? ""} ${threadContext.propertyPostalCode ?? ""}` : null,
    normalizedPostal ? `ZIP: ${normalizedPostal}` : null,
    inGeorgia === false
      ? `Location: OUT OF STATE (Georgia only)`
      : outsideUsualArea === true
        ? `Location: outside usual area (confirm)`
        : outsideUsualArea === false
          ? `Location: OK`
          : `Location: unknown (ask for ZIP)`,
    firstTouchExample ? `Example (first touch): ${firstTouchExample}` : null,
    followUpExample ? `Example (follow up): ${followUpExample}` : null,
    outOfAreaExample ? `Example (out of area): ${outOfAreaExample}` : null,
    crossChannelRecentSummary ? `Recent cross-channel context:\n${crossChannelRecentSummary}` : null,
    `Transcript:\n${buildTranscript(messages)}`
  ].filter((line): line is string => Boolean(line));

  const baseUserPrompt = `Write the best next reply for this conversation.\n${contextLines.join("\n")}`;

  let plan: ReplyPlan | null = null;
  if (config.thinkModel) {
    const planSystemPrompt = `
You are Stonegate Assist. Read the conversation and produce a short internal plan for the best next reply.
Do not write the customer message. Output ONLY JSON matching the schema.
`.trim();

    const planResult = await callOpenAIJsonSchema({
      apiKey: config.apiKey,
      model: config.thinkModel,
      systemPrompt: planSystemPrompt,
      userPrompt: baseUserPrompt,
      maxOutputTokens: 600,
      schemaName: "reply_plan",
      schema: REPLY_PLAN_SCHEMA,
      reasoningEffort: "low"
    });

    if (planResult.ok && isReplyPlan(planResult.value)) {
      plan = planResult.value;
    } else if (!planResult.ok) {
      console.warn("[inbox.suggest] openai.plan_failed", { error: planResult.error, detail: planResult.detail ?? null });
    }
  }

  const userPrompt =
    plan
      ? `${baseUserPrompt}\n\nReply plan (internal):\n${JSON.stringify(plan)}`
      : baseUserPrompt;

  const suggestionResult = await callOpenAIJsonSchema({
    apiKey: config.apiKey,
    model: config.writeModel,
    fallbackModels: ["gpt-4.1", "gpt-5-mini"],
    systemPrompt,
    userPrompt,
    maxOutputTokens: 800,
    schemaName: "reply_suggestion",
    schema: REPLY_SUGGESTION_SCHEMA
  });

  if (!suggestionResult.ok) {
    return NextResponse.json(
      {
        error: suggestionResult.error,
        detail: suggestionResult.detail ?? null
      },
      { status: 502 }
    );
  }

  if (!isReplySuggestion(suggestionResult.value)) {
    return NextResponse.json({ error: "openai_invalid_response" }, { status: 502 });
  }

  const suggestion = {
    body: suggestionResult.value.body.trim(),
    subject: suggestionResult.value.subject.trim().length ? suggestionResult.value.subject.trim() : null
  };

  if (containsDashLikeChars(suggestion.body) || (suggestion.subject && containsDashLikeChars(suggestion.subject))) {
    const retryPrompt = `${userPrompt}\n\nIMPORTANT: Rewrite the reply with ZERO hyphen or dash characters of any kind. Do not use lists. Use only sentences.`;
    const retry = await callOpenAIJsonSchema({
      apiKey: config.apiKey,
      model: config.writeModel,
      fallbackModels: ["gpt-4.1", "gpt-5-mini"],
      systemPrompt,
      userPrompt: retryPrompt,
      maxOutputTokens: 800,
      schemaName: "reply_suggestion",
      schema: REPLY_SUGGESTION_SCHEMA
    });

    if (retry.ok && isReplySuggestion(retry.value)) {
      suggestion.body = retry.value.body.trim();
      suggestion.subject = retry.value.subject.trim().length ? retry.value.subject.trim() : null;
    }
  }

  suggestion.body = stripDashLikeChars(suggestion.body);
  if (suggestion.subject) {
    suggestion.subject = stripDashLikeChars(suggestion.subject);
  }

  if (!suggestion.body) {
    return NextResponse.json({ error: "openai_invalid_response" }, { status: 502 });
  }

  const created = await db.transaction(async (tx) => {
    await tx
      .delete(conversationMessages)
      .where(
        and(
          eq(conversationMessages.threadId, draftThreadId),
          eq(conversationMessages.direction, "outbound"),
          sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') = 'true'`,
          sql`coalesce(${conversationMessages.metadata} ->> 'aiSuggested', 'false') = 'true'`
        )
      );

    const participantId = await ensureAiParticipant(tx, draftThreadId, now);
    const [message] = await tx
      .insert(conversationMessages)
      .values({
        threadId: draftThreadId,
        participantId,
        direction: "outbound",
        channel: targetReplyChannel,
        subject: targetReplyChannel === "email" ? suggestion.subject ?? thread.subject ?? "Stonegate message" : null,
        body: suggestion.body,
        toAddress: targetToAddress,
        deliveryStatus: "queued",
        metadata: {
          ...(targetReplyChannel === "dm" ? (targetDmMetadata ?? {}) : {}),
          draft: true,
          aiSuggested: true,
          aiModel: suggestionResult.modelUsed,
          aiPlanIntent: plan?.intent ?? undefined,
          aiPlanTone: plan?.tone ?? undefined,
          aiPlanFacts: plan?.facts ?? undefined,
          aiPlanQuestions: plan?.questions ?? undefined,
          aiPlanNextAction: plan?.next_action ?? undefined,
          aiPlanConstraints: plan?.constraints ?? undefined,
          aiMemorySummary: salesAgentMemory?.summary ?? undefined,
          aiBookingReadiness: salesAgentMemory?.bookingReadiness ?? undefined,
          aiQuoteConfidence: salesAgentMemory?.quoteConfidence ?? undefined,
          aiChannelPreference: salesAgentMemory?.channelPreference ?? undefined,
          aiPlannerActionType: salesAgentNextAction?.actionType ?? undefined,
          aiPlannerSummary: salesAgentNextAction?.summary ?? undefined,
          aiPlannerReason: salesAgentNextAction?.reason ?? undefined,
          aiPlannerPriority: salesAgentNextAction?.priority ?? undefined,
          aiPlannerConfidence: salesAgentNextAction?.confidence ?? undefined,
          outOfArea: inGeorgia === false || outsideUsualArea === true ? true : undefined
        },
        createdAt: now
      })
      .returning({ id: conversationMessages.id });

    if (!message?.id) {
      throw new Error("draft_create_failed");
    }
    return message;
  });

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "inbox.suggest.draft_created",
    entityType: "conversation_thread",
    entityId: draftThreadId,
    meta: {
      channel: targetReplyChannel,
      messageId: created.id,
      sourceThreadId: threadId,
      targetThreadId: draftThreadId,
      handoff: targetReplyChannel !== replyChannel ? `${replyChannel}_to_${targetReplyChannel}` : undefined,
    }
  });

  return NextResponse.json({
    ok: true,
    created: true,
    messageId: created.id,
    channel: targetReplyChannel,
    threadId: draftThreadId,
    draft: {
      subject: targetReplyChannel === "email" ? suggestion.subject ?? null : null,
      body: suggestion.body
    }
  });
}
