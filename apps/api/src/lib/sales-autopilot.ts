import { DateTime } from "luxon";
import { and, desc, eq, gt, gte, isNotNull, ne, or, sql } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import {
  auditLogs,
  appointments,
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  crmPipeline,
  getDb,
  outboxEvents,
  properties
} from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import {
  getCompanyProfilePolicy,
  getSalesAutopilotPolicy,
  getServiceAreaPolicy,
  getTemplatesPolicy,
  isGeorgiaPostalCode,
  isPostalCodeAllowed,
  normalizePostalCode,
  resolveTemplateForChannel
} from "@/lib/policy";

type DatabaseClient = ReturnType<typeof getDb>;
type Tx = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer T) => Promise<unknown> ? T : never;

type ReplyChannel = "sms" | "email" | "dm";

type ReasoningEffort = "low" | "medium" | "high";

type OutboxOutcome = {
  status: "processed" | "skipped" | "retry";
  error?: string | null;
  nextAttemptAt?: Date;
};

type MessageContext = {
  direction: string;
  channel: string;
  subject: string | null;
  body: string;
  createdAt: Date;
  participantName: string | null;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnvString(key: string): string | null {
  const value = process.env[key];
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function getOpenAIConfig():
  | { apiKey: string; thinkModel: string | null; writeModel: string }
  | null {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) return null;
  const thinkModel = readEnvString("OPENAI_SALES_AUTOPILOT_THINK_MODEL") ?? "gpt-5-mini";
  const writeModel = readEnvString("OPENAI_SALES_AUTOPILOT_WRITE_MODEL") ?? "gpt-4.1";
  return { apiKey, thinkModel, writeModel };
}

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
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  schemaName: string;
  schema: Record<string, unknown>;
  reasoningEffort?: ReasoningEffort;
}): Promise<{ ok: true; value: unknown } | { ok: false; error: string; detail?: string | null }> {
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

  const response = await request(input.model);
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return { ok: false, error: "openai_request_failed", detail: bodyText.slice(0, 300) };
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
    if (!raw) return { ok: false, error: "openai_empty_response" };
    const parsed = tryParseJsonObject(raw);
    if (!parsed) return { ok: false, error: "openai_parse_failed" };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: "openai_parse_failed", detail: String(error) };
  }
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

type DraftCandidate = { body: string; subject: string };
type DraftResult = { best: DraftCandidate; alternatives: DraftCandidate[]; missing_info: string[] };

function isDraftResult(value: unknown): value is DraftResult {
  if (!isRecord(value)) return false;
  if (!isRecord(value["best"])) return false;
  const best = value["best"] as Record<string, unknown>;
  if (typeof best["body"] !== "string" || typeof best["subject"] !== "string") return false;
  if (!Array.isArray(value["alternatives"])) return false;
  if (!value["alternatives"].every((item) => isRecord(item) && typeof item["body"] === "string" && typeof item["subject"] === "string")) {
    return false;
  }
  if (!Array.isArray(value["missing_info"]) || !value["missing_info"].every((item) => typeof item === "string")) return false;
  return true;
}

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

const AUTOPILOT_DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    best: {
      type: "object",
      additionalProperties: false,
      properties: {
        body: { type: "string" },
        subject: { type: "string" }
      },
      required: ["body", "subject"]
    },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          body: { type: "string" },
          subject: { type: "string" }
        },
        required: ["body", "subject"]
      }
    },
    missing_info: { type: "array", items: { type: "string" } }
  },
  required: ["best", "alternatives", "missing_info"]
};

function stripDashLikeChars(text: string): string {
  return text
    .replace(/[\u002d\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE63\uFF0D]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripLinks(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\bstonegatejunkremoval\.com\S*/gi, "")
    .replace(/\/book\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function buildTranscript(messages: MessageContext[]): string {
  const lines = messages.map((message) => {
    const who = message.participantName ?? (message.direction === "inbound" ? "Customer" : "Team");
    const subject = message.subject ? ` (subject: ${message.subject})` : "";
    return `[${message.createdAt.toISOString()}] ${who}${subject}: ${message.body}`;
  });
  return lines.join("\n");
}

function extractZipFromText(text: string): string | null {
  const match = text.match(/\b\d{5}\b/);
  return match ? match[0] : null;
}

function extractPhoneFromText(text: string): { raw: string; e164: string } | null {
  const candidates = text.match(/\+?\d[\d(). \-]{7,}\d/g) ?? [];
  for (const candidate of candidates) {
    const phone = parsePhoneNumberFromString(candidate, "US");
    if (phone?.isValid()) {
      return { raw: candidate.trim(), e164: phone.number };
    }
  }
  return null;
}

function isMessengerLeadCard(body: string): boolean {
  const text = body.toLowerCase();
  const markers = ["phone number:", "email:", "zip code:", "first name:", "when do you want it gone?:"];
  const hitCount = markers.reduce((count, marker) => (text.includes(marker) ? count + 1 : count), 0);
  return hitCount >= 3;
}

function shouldAllowDmAutosend(messages: MessageContext[], currentInboundBody: string): boolean {
  if (isMessengerLeadCard(currentInboundBody)) return false;
  const nonLeadDmInbounds = messages.filter(
    (m) => m.direction === "inbound" && m.channel === "dm" && typeof m.body === "string" && m.body.trim().length > 0 && !isMessengerLeadCard(m.body)
  );
  return nonLeadDmInbounds.length >= 2;
}

function stripAutopilotFooter(body: string): string {
  const lower = body.toLowerCase();
  const markers = ["missing info", "missing information", "info checklist", "checklist:"];
  const idx = markers
    .map((marker) => lower.indexOf(marker))
    .filter((pos) => pos >= 0)
    .reduce((min, pos) => Math.min(min, pos), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(idx)) return body;
  return body.slice(0, idx).trim();
}

function normalizeReplyCandidate(candidate: DraftCandidate): DraftCandidate {
  const cleanedBody = stripAutopilotFooter(stripLinks(stripDashLikeChars(candidate.body)));
  return {
    body: cleanedBody,
    subject: stripLinks(stripDashLikeChars(candidate.subject))
  };
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

function clampReplyBody(body: string, channel: ReplyChannel): string {
  const trimmed = body.trim();
  const maxChars = channel === "email" ? 900 : 240;
  const withoutFooter = stripAutopilotFooter(trimmed);

  if (channel !== "email") {
    const sentences = withoutFooter
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length >= 3) {
      return sentences.slice(0, 2).join(" ").slice(0, maxChars).trim();
    }
  }

  if (withoutFooter.length <= maxChars) return withoutFooter;
  const slice = withoutFooter.slice(0, maxChars);
  const lastPunctuation = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  if (lastPunctuation >= 80) {
    return slice.slice(0, lastPunctuation + 1).trim();
  }
  return slice.trim();
}

async function ensureAutopilotParticipant(tx: Tx, threadId: string, now: Date, displayName: string) {
  const [existing] = await tx
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        eq(conversationParticipants.participantType, "team"),
        eq(conversationParticipants.displayName, displayName),
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
      displayName,
      createdAt: now
    })
    .returning({ id: conversationParticipants.id });

  return created?.id ?? null;
}

async function resolveReplyAddress(db: DatabaseClient, input: { threadId: string; channel: ReplyChannel; contact: ThreadContext }): Promise<{ toAddress: string | null; dmMetadata: Record<string, unknown> | null }> {
  if (input.channel === "sms") {
    return { toAddress: input.contact.contactPhoneE164 ?? input.contact.contactPhone ?? null, dmMetadata: null };
  }
  if (input.channel === "email") {
    return { toAddress: input.contact.contactEmail ?? null, dmMetadata: null };
  }

  const [latestInboundDm] = await db
    .select({
      fromAddress: conversationMessages.fromAddress,
      metadata: conversationMessages.metadata
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.threadId, input.threadId),
        eq(conversationMessages.direction, "inbound"),
        eq(conversationMessages.channel, "dm")
      )
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1);

  const dmMetadata = isRecord(latestInboundDm?.metadata) ? (latestInboundDm!.metadata as Record<string, unknown>) : null;
  return { toAddress: latestInboundDm?.fromAddress ?? null, dmMetadata };
}

export async function handleInboundSalesAutopilot(messageId: string): Promise<OutboxOutcome> {
  const db = getDb();
  const policy = await getSalesAutopilotPolicy(db);
  if (!policy.enabled) {
    return { status: "skipped" };
  }

  const config = getOpenAIConfig();
  if (!config) {
    return { status: "processed" };
  }

  const [inbound] = await db
    .select({
      messageId: conversationMessages.id,
      direction: conversationMessages.direction,
      channel: conversationMessages.channel,
      body: conversationMessages.body,
      createdAt: conversationMessages.createdAt,
      threadId: conversationThreads.id,
      threadChannel: conversationThreads.channel,
      threadSubject: conversationThreads.subject,
      threadState: conversationThreads.state,
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
    .from(conversationMessages)
    .leftJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
    .leftJoin(properties, eq(conversationThreads.propertyId, properties.id))
    .where(eq(conversationMessages.id, messageId))
    .limit(1);

  if (!inbound?.threadId) {
    return { status: "skipped" };
  }
  const threadId: string = inbound.threadId;

  if (inbound.direction !== "inbound") {
    return { status: "skipped" };
  }

  const replyChannel = inbound.threadChannel as ReplyChannel;
  if (replyChannel !== "sms" && replyChannel !== "email" && replyChannel !== "dm") {
    return { status: "skipped" };
  }

  const [existingDraft] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.threadId, threadId),
        eq(conversationMessages.direction, "outbound"),
        sql`${conversationMessages.metadata} ->> 'salesAutopilotForMessageId' = ${messageId}`
      )
    )
    .limit(1);

  if (existingDraft?.id) {
    return { status: "processed" };
  }

  const contactName = [inbound.contactFirstName, inbound.contactLastName].filter(Boolean).join(" ").trim();
  const threadContext: ThreadContext = {
    id: inbound.threadId,
    channel: inbound.threadChannel ?? inbound.channel ?? "sms",
    subject: inbound.threadSubject ?? null,
    state: inbound.threadState ?? "new",
    contactId: inbound.contactId ?? null,
    contactName: contactName.length ? contactName : null,
    contactEmail: inbound.contactEmail ?? null,
    contactPhone: inbound.contactPhone ?? null,
    contactPhoneE164: inbound.contactPhoneE164 ?? null,
    propertyId: inbound.propertyId ?? null,
    propertyPostalCode: inbound.propertyPostalCode ?? null,
    propertyAddressLine1: inbound.propertyAddressLine1 ?? null,
    propertyCity: inbound.propertyCity ?? null,
    propertyState: inbound.propertyState ?? null
  };

  const { toAddress, dmMetadata } = await resolveReplyAddress(db, { threadId, channel: replyChannel, contact: threadContext });
  if (!toAddress) {
    return { status: "processed" };
  }

  const messageRows = await db
    .select({
      direction: conversationMessages.direction,
      channel: conversationMessages.channel,
      subject: conversationMessages.subject,
      body: conversationMessages.body,
      createdAt: conversationMessages.createdAt,
      participantName: conversationParticipants.displayName
    })
    .from(conversationMessages)
    .leftJoin(conversationParticipants, eq(conversationMessages.participantId, conversationParticipants.id))
    .where(eq(conversationMessages.threadId, threadId))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(12);

  const messages: MessageContext[] = messageRows
    .map((row) => ({
      direction: row.direction,
      channel: row.channel,
      subject: row.subject ?? null,
      body: row.body,
      createdAt: row.createdAt,
      participantName: row.participantName ?? null
    }))
    .reverse();

  const templates = await getTemplatesPolicy(db);
  const serviceArea = await getServiceAreaPolicy(db);
  const companyProfile = await getCompanyProfilePolicy(db);
  const zipFromThread = normalizePostalCode(threadContext.propertyPostalCode ?? null);
  const zipFromBody = normalizePostalCode(extractZipFromText(inbound.body) ?? null);
  const zipFromTranscript = normalizePostalCode(extractZipFromText(messages.map((m) => m.body).join("\n")) ?? null);
  const normalizedPostal = zipFromThread ?? zipFromBody ?? zipFromTranscript;
  const inGeorgia = normalizedPostal !== null ? isGeorgiaPostalCode(normalizedPostal) : null;
  const outOfServiceArea = normalizedPostal !== null ? !isPostalCodeAllowed(normalizedPostal, serviceArea) : null;
  const autoSendEligible = true;
  const extractedPhone = extractPhoneFromText(messages.map((m) => m.body).join("\n"));

  const firstTouchExample = resolveTemplateForChannel(templates.first_touch, { inboundChannel: replyChannel, replyChannel });
  const followUpExample = resolveTemplateForChannel(templates.follow_up, { inboundChannel: replyChannel, replyChannel });
  const outOfAreaExample =
    replyChannel === "email" || replyChannel === "sms"
      ? resolveTemplateForChannel(templates.out_of_area, { inboundChannel: replyChannel, replyChannel })
      : null;

  const agentName = policy.agentDisplayName;
  const systemPrompt = `
You are ${agentName}, a real human salesperson for ${companyProfile.businessName} in North Metro Atlanta.
Write the next reply the customer will receive.

Rules:
- Sound like a real person. No emojis. Keep it short and natural.
- If you introduce yourself, use the name "${agentName}" and do not introduce yourself as anyone else.
- Do NOT use bullet points, numbered lists, or hyphen/dash characters of any kind.
- Do NOT include any links, URLs, domains, or paths (including "/book").
- Ask only for what you still need to move forward: items, timing, ZIP/address, and photos when helpful.
- Do NOT include a checklist in the message body. Put missing items in "missing_info" only.
- Keep the reply concise. For SMS or DM, aim for 1 to 2 short sentences.
- If the ZIP is outside our service area, politely say we can't serve that area. Use "Service area:" below as truth.
- Do NOT mention that you are an AI or reference internal systems.
- Output ONLY JSON matching the schema.

Company profile (use as truth):
Business: ${companyProfile.businessName}
Phone: ${companyProfile.primaryPhone}
Service area: ${companyProfile.serviceAreaSummary}
Trailer/pricing: ${companyProfile.trailerAndPricingSummary}
What we do: ${companyProfile.whatWeDo}
What we do not do: ${companyProfile.whatWeDontDo}
Booking style: ${companyProfile.bookingStyle}
Notes: ${companyProfile.agentNotes}
  `.trim();

  const contextLines = [
    `Channel: ${replyChannel}`,
    `Thread state: ${threadContext.state}`,
    `Customer name: ${threadContext.contactName ?? "Unknown"}`,
    normalizedPostal ? `ZIP: ${normalizedPostal}` : null,
    normalizedPostal === null
      ? `Location: unknown (ask for ZIP)`
      : outOfServiceArea === true
        ? `Location: OUT OF SERVICE AREA`
        : `Location: OK`,
    firstTouchExample ? `Example (first touch): ${firstTouchExample}` : null,
    followUpExample ? `Example (follow up): ${followUpExample}` : null,
    outOfAreaExample ? `Example (out of area): ${outOfAreaExample}` : null,
    `Transcript:\n${buildTranscript(messages)}`
  ].filter((line): line is string => Boolean(line));

  const baseUserPrompt = `Write a reply in the voice of ${policy.agentDisplayName}.\n${contextLines.join("\n")}`;

  let plan: ReplyPlan | null = null;
  if (config.thinkModel) {
    const planSystemPrompt = `
You are ${agentName}. Read the conversation and produce a short internal plan for the best next reply.
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
    }
  }

  const userPrompt = plan ? `${baseUserPrompt}\n\nReply plan (internal):\n${JSON.stringify(plan)}` : baseUserPrompt;

  const draftResult = await callOpenAIJsonSchema({
    apiKey: config.apiKey,
    model: config.writeModel,
    systemPrompt,
    userPrompt,
    maxOutputTokens: 900,
    schemaName: "autopilot_draft",
    schema: AUTOPILOT_DRAFT_SCHEMA
  });

  if (!draftResult.ok) {
    console.warn("[sales.autopilot] openai_failed", { messageId, error: draftResult.error, detail: draftResult.detail ?? null });
    return { status: "retry", error: draftResult.error };
  }

  if (!isDraftResult(draftResult.value)) {
    return { status: "retry", error: "openai_invalid_response" };
  }

  const best = normalizeReplyCandidate(draftResult.value.best);
  const alternatives = draftResult.value.alternatives.map(normalizeReplyCandidate).filter((c) => c.body.length > 0).slice(0, 2);
  const missingInfo = draftResult.value.missing_info.map((item) => item.trim()).filter(Boolean).slice(0, 8);

  const bestBody = clampReplyBody(best.body, replyChannel);
  const bestSubject = replyChannel === "email" ? best.subject.trim() : "";
  if (!bestBody) {
    return { status: "retry", error: "openai_empty_response" };
  }

  const now = new Date();
  const draftId = await db.transaction(async (tx) => {
    const participantId = await ensureAutopilotParticipant(tx, threadId, now, policy.agentDisplayName);
    const dmAutosendAllowed =
      replyChannel === "dm" && typeof inbound.body === "string" ? shouldAllowDmAutosend(messages, inbound.body) : true;
    const noAutosend = !autoSendEligible || (replyChannel === "dm" && !dmAutosendAllowed);
    const [message] = await tx
      .insert(conversationMessages)
      .values({
        threadId,
        participantId,
        direction: "outbound",
        channel: replyChannel,
        subject: replyChannel === "email" ? (bestSubject.length ? bestSubject : "") : null,
        body: bestBody,
        toAddress,
        deliveryStatus: "queued",
        metadata: {
          ...(replyChannel === "dm" ? (dmMetadata ?? {}) : {}),
          draft: true,
          salesAutopilot: true,
          salesAutopilotForMessageId: messageId,
          salesAutopilotNoAutosend: noAutosend ? true : undefined,
          aiModel: config.writeModel,
          missingInfo,
          alternatives,
          extractedPhoneE164: extractedPhone?.e164 ?? undefined
        },
        createdAt: now
      })
      .returning({ id: conversationMessages.id });

    if (!message?.id) {
      throw new Error("draft_create_failed");
    }

    if (!noAutosend) {
      await tx.insert(outboxEvents).values({
        type: "sales.autopilot.autosend",
        payload: { draftMessageId: message.id, inboundMessageId: messageId },
        nextAttemptAt: DateTime.fromJSDate(now).plus({ minutes: policy.autoSendAfterMinutes }).toJSDate(),
        createdAt: now
      });
    }

    return message.id;
  });

  await recordAuditEvent({
    actor: { type: "ai", label: "sales-autopilot" },
    action: "sales.autopilot.draft_created",
    entityType: "conversation_message",
    entityId: draftId,
    meta: { threadId, channel: replyChannel, inboundMessageId: messageId }
  });

  return { status: "processed" };
}

function isDraftMessage(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.["draft"] === true;
}

function randomHumanisticDelayMs(): number {
  const min = 10_000;
  const max = 30_000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function hasRecentActivityAcrossChannels(db: DatabaseClient, contactId: string, since: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .where(and(eq(conversationThreads.contactId, contactId), gte(conversationMessages.createdAt, since)))
    .limit(1);
  return Boolean(row?.id);
}

async function hasHumanTouchSince(db: DatabaseClient, contactId: string, since: Date): Promise<boolean> {
  const [outboundTeam] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .innerJoin(conversationParticipants, eq(conversationMessages.participantId, conversationParticipants.id))
    .where(
      and(
        eq(conversationThreads.contactId, contactId),
        eq(conversationMessages.direction, "outbound"),
        eq(conversationParticipants.participantType, "team"),
        isNotNull(conversationParticipants.teamMemberId),
        gte(conversationMessages.createdAt, since)
      )
    )
    .limit(1);
  if (outboundTeam?.id) return true;

  const [connectedForContact] = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, "sales.escalation.call.connected"),
        gte(auditLogs.createdAt, since),
        sql`${auditLogs.meta} ->> 'contactId' = ${contactId}`
      )
    )
    .limit(1);

  return Boolean(connectedForContact?.id);
}

function stripDraftFlag(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return null;
  const copy = { ...metadata };
  delete copy["draft"];
  return copy;
}

async function getLastSalespersonAssignmentChangeAt(db: DatabaseClient, contactId: string, sinceExclusive: Date): Promise<Date | null> {
  const [row] = await db
    .select({
      at: sql<Date | null>`max(${auditLogs.createdAt})`
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, "contact.updated"),
        eq(auditLogs.entityType, "contact"),
        eq(auditLogs.entityId, contactId),
        gt(auditLogs.createdAt, sinceExclusive),
        sql`${auditLogs.meta} -> 'fields' ? 'salespersonMemberId'`
      )
    )
    .limit(1);
  return row?.at ?? null;
}

export async function handleSalesAutopilotAutosend(input: { draftMessageId: string; inboundMessageId?: string | null }): Promise<OutboxOutcome> {
  const db = getDb();
  const [row] = await db
    .select({
      id: conversationMessages.id,
      threadId: conversationMessages.threadId,
      createdAt: conversationMessages.createdAt,
      body: conversationMessages.body,
      metadata: conversationMessages.metadata,
      deliveryStatus: conversationMessages.deliveryStatus,
      channel: conversationMessages.channel,
      threadContactId: conversationThreads.contactId
    })
    .from(conversationMessages)
    .leftJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .where(eq(conversationMessages.id, input.draftMessageId))
    .limit(1);

  if (!row?.id) {
    return { status: "processed" };
  }

  const meta = isRecord(row.metadata) ? (row.metadata as Record<string, unknown>) : null;
  const isAutoFirstTouch = meta?.["autoFirstTouch"] === true;

  const policy = await getSalesAutopilotPolicy(db);
  if (!policy.enabled && !isAutoFirstTouch) {
    return { status: "processed" };
  }

  if (!isDraftMessage(meta) || meta?.["salesAutopilot"] !== true) {
    return { status: "processed" };
  }
  if (meta?.["salesAutopilotNoAutosend"] === true) {
    await recordAuditEvent({
      actor: { type: "ai", label: "sales-autopilot" },
      action: "sales.autopilot.autosend_skipped",
      entityType: "conversation_message",
      entityId: row.id,
      meta: { reason: "autosend_disabled" }
    });
    return { status: "processed" };
  }

  const contactId = row.threadContactId ?? null;
  if (!contactId) {
    return { status: "processed" };
  }

  if (input.inboundMessageId) {
    const [latestInbound] = await db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
      .where(and(eq(conversationThreads.contactId, contactId), eq(conversationMessages.direction, "inbound")))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(1);
    if (latestInbound?.id && latestInbound.id !== input.inboundMessageId) {
      await recordAuditEvent({
        actor: { type: "ai", label: "sales-autopilot" },
        action: "sales.autopilot.autosend_skipped",
        entityType: "conversation_message",
        entityId: row.id,
        meta: { reason: "newer_inbound", inboundMessageId: input.inboundMessageId, latestInboundMessageId: latestInbound.id }
      });
      return { status: "processed" };
    }
  }

  const [pipeline] = await db
    .select({ stage: crmPipeline.stage })
    .from(crmPipeline)
    .where(eq(crmPipeline.contactId, contactId))
    .limit(1);
  const stage = typeof pipeline?.stage === "string" ? pipeline.stage : "new";

  const [appointment] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.contactId, contactId), ne(appointments.status, "canceled")))
    .limit(1);
  const isBooked = Boolean(appointment?.id);

  if (stage !== "new" || isBooked) {
    await recordAuditEvent({
      actor: { type: "ai", label: "sales-autopilot" },
      action: "sales.autopilot.autosend_skipped",
      entityType: "conversation_message",
      entityId: row.id,
      meta: { reason: "handled", stage, booked: isBooked }
    });
    return { status: "processed" };
  }

  if (row.channel === "dm") {
    const [latestInboundForContact] = await db
      .select({
        body: conversationMessages.body,
        channel: conversationMessages.channel,
        createdAt: conversationMessages.createdAt
      })
      .from(conversationMessages)
      .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
      .where(and(eq(conversationThreads.contactId, contactId), eq(conversationMessages.direction, "inbound")))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(1);

    if (
      latestInboundForContact?.channel === "dm" &&
      typeof latestInboundForContact.body === "string" &&
      latestInboundForContact.body.trim().length > 0 &&
      !isMessengerLeadCard(latestInboundForContact.body)
    ) {
      const now = new Date();
      const fallbackAt = DateTime.fromJSDate(latestInboundForContact.createdAt)
        .plus({ minutes: policy.dmSmsFallbackAfterMinutes })
        .toJSDate();
      if (now < fallbackAt) {
        return { status: "retry", error: "dm_cooldown", nextAttemptAt: fallbackAt };
      }

      const silenceUntil = DateTime.fromJSDate(latestInboundForContact.createdAt)
        .plus({ minutes: policy.dmMinSilenceBeforeSmsMinutes })
        .toJSDate();
      if (now < silenceUntil) {
        return { status: "retry", error: "dm_recent_inbound", nextAttemptAt: silenceUntil };
      }
    }
  }

  const inboundId =
    (typeof input.inboundMessageId === "string" ? input.inboundMessageId : null) ??
    (typeof meta?.["salesAutopilotForMessageId"] === "string" ? (meta["salesAutopilotForMessageId"] as string) : null);

  let since = row.createdAt;
  if (inboundId) {
    const [inbound] = await db
      .select({ createdAt: conversationMessages.createdAt })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, inboundId))
      .limit(1);
    if (inbound?.createdAt) {
      since = inbound.createdAt;
    }
  }

  const now = new Date();

  const assignmentChangedAt = await getLastSalespersonAssignmentChangeAt(db, contactId, since);
  if (assignmentChangedAt) {
    const assignmentGate = DateTime.fromJSDate(assignmentChangedAt).plus({ minutes: policy.autoSendAfterMinutes }).toJSDate();
    if (now < assignmentGate) {
      return { status: "retry", error: "assignee_changed", nextAttemptAt: assignmentGate };
    }
    since = assignmentChangedAt;
  }

  const [newerInbound] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.threadId, row.threadId), eq(conversationMessages.direction, "inbound"), gt(conversationMessages.createdAt, since)))
    .limit(1);
  if (newerInbound?.id) {
    await recordAuditEvent({
      actor: { type: "ai", label: "sales-autopilot" },
      action: "sales.autopilot.autosend_skipped",
      entityType: "conversation_message",
      entityId: row.id,
      meta: { reason: "stale_inbound", inboundId }
    });
    return { status: "processed" };
  }

  const [latestDraftForContact] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .where(
      and(
        eq(conversationThreads.contactId, contactId),
        eq(conversationMessages.direction, "outbound"),
        sql`${conversationMessages.metadata} ->> 'salesAutopilot' = 'true'`,
        sql`${conversationMessages.metadata} ->> 'draft' = 'true'`
      )
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1);
  if (latestDraftForContact?.id && latestDraftForContact.id !== row.id) {
    await recordAuditEvent({
      actor: { type: "ai", label: "sales-autopilot" },
      action: "sales.autopilot.autosend_skipped",
      entityType: "conversation_message",
      entityId: row.id,
      meta: { reason: "stale_draft" }
    });
    return { status: "processed" };
  }

  const [priorSent] = await db
    .select({ body: conversationMessages.body })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.threadId, row.threadId),
        eq(conversationMessages.direction, "outbound"),
        sql`${conversationMessages.metadata} ->> 'salesAutopilot' = 'true'`,
        or(eq(conversationMessages.deliveryStatus, "sent"), eq(conversationMessages.deliveryStatus, "delivered"))
      )
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1);
  if (typeof priorSent?.body === "string" && normalizeForCompare(priorSent.body) === normalizeForCompare(row.body)) {
    await recordAuditEvent({
      actor: { type: "ai", label: "sales-autopilot" },
      action: "sales.autopilot.autosend_skipped",
      entityType: "conversation_message",
      entityId: row.id,
      meta: { reason: "duplicate_body" }
    });
    return { status: "processed" };
  }

  if (await hasHumanTouchSince(db, contactId, since)) {
    await recordAuditEvent({
      actor: { type: "ai", label: "sales-autopilot" },
      action: "sales.autopilot.autosend_skipped",
      entityType: "conversation_message",
      entityId: row.id,
      meta: { reason: "human_touch", contactId }
    });
    return { status: "processed" };
  }

  const activitySince = DateTime.fromJSDate(now).minus({ minutes: policy.activityWindowMinutes }).toJSDate();
  if (await hasRecentActivityAcrossChannels(db, contactId, activitySince)) {
    const nextAttemptAt = DateTime.fromJSDate(now).plus({ minutes: policy.retryDelayMinutes }).toJSDate();
    return { status: "retry", error: "recent_activity", nextAttemptAt };
  }

  if (row.channel === "sms") {
    const [latestInboundForContact] = await db
      .select({
        body: conversationMessages.body,
        channel: conversationMessages.channel,
        createdAt: conversationMessages.createdAt
      })
      .from(conversationMessages)
      .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
      .where(and(eq(conversationThreads.contactId, contactId), eq(conversationMessages.direction, "inbound")))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(1);

    if (
      latestInboundForContact?.channel === "dm" &&
      typeof latestInboundForContact.body === "string" &&
      latestInboundForContact.body.trim().length > 0 &&
      !isMessengerLeadCard(latestInboundForContact.body)
    ) {
      const fallbackAt = DateTime.fromJSDate(latestInboundForContact.createdAt)
        .plus({ minutes: policy.dmSmsFallbackAfterMinutes })
        .toJSDate();
      if (now < fallbackAt) {
        return { status: "retry", error: "dm_cooldown", nextAttemptAt: fallbackAt };
      }

      const silenceUntil = DateTime.fromJSDate(latestInboundForContact.createdAt)
        .plus({ minutes: policy.dmMinSilenceBeforeSmsMinutes })
        .toJSDate();
      if (now < silenceUntil) {
        return { status: "retry", error: "dm_recent_inbound", nextAttemptAt: silenceUntil };
      }
    }
  }

  const wantsSmsFallback = row.channel === "dm";
  let smsToAddress: string | null = null;
  if (wantsSmsFallback) {
    const [contact] = await db
      .select({ phone: contacts.phone, phoneE164: contacts.phoneE164 })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);

    const extracted = typeof meta?.["extractedPhoneE164"] === "string" ? (meta["extractedPhoneE164"] as string) : null;
    smsToAddress = (contact?.phoneE164 ?? contact?.phone ?? extracted ?? "").trim() || null;
    if (smsToAddress) {
      const parsed = parsePhoneNumberFromString(smsToAddress, "US");
      smsToAddress = parsed?.isValid() ? parsed.number : null;
    }
  }

  const sendAt = DateTime.fromJSDate(now).plus({ milliseconds: randomHumanisticDelayMs() }).toJSDate();

  if (wantsSmsFallback && smsToAddress) {
    const smsBody = clampReplyBody(row.body ?? "", "sms");
    if (!smsBody) {
      return { status: "processed" };
    }

    await db.transaction(async (tx) => {
      const participantId = await ensureAutopilotParticipant(tx, row.threadId, now, policy.agentDisplayName);
      const [message] = await tx
        .insert(conversationMessages)
        .values({
          threadId: row.threadId,
          participantId,
          direction: "outbound",
          channel: "sms",
          subject: null,
          body: smsBody,
          toAddress: smsToAddress,
          deliveryStatus: "queued",
          metadata: {
            salesAutopilot: true,
            salesAutopilotDerivedFromDraftId: row.id,
            salesAutopilotDerivedFromInboundId: inboundId ?? undefined
          },
          createdAt: now
        })
        .returning({ id: conversationMessages.id });

      if (!message?.id) {
        throw new Error("autosend_sms_create_failed");
      }

      await tx
        .update(conversationThreads)
        .set({
          lastMessagePreview: smsBody.slice(0, 140),
          lastMessageAt: now,
          updatedAt: now
        })
        .where(eq(conversationThreads.id, row.threadId));

      await tx.insert(outboxEvents).values({
        type: "message.send",
        payload: { messageId: message.id },
        nextAttemptAt: sendAt,
        createdAt: now
      });
    });

    await recordAuditEvent({
      actor: { type: "ai", label: "sales-autopilot" },
      action: "sales.autopilot.autosent",
      entityType: "conversation_message",
      entityId: row.id,
      meta: { contactId, via: "sms_fallback" }
    });

    return { status: "processed" };
  }

  if (wantsSmsFallback && !smsToAddress) {
    await recordAuditEvent({
      actor: { type: "ai", label: "sales-autopilot" },
      action: "sales.autopilot.autosend_skipped",
      entityType: "conversation_message",
      entityId: row.id,
      meta: { reason: "no_sms_recipient" }
    });
    return { status: "processed" };
  }

  await db.transaction(async (tx) => {
    const existingSend = await tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.type, "message.send"), sql`payload->>'messageId' = ${row.id}`, sql`${outboxEvents.processedAt} is null`)
      )
      .limit(1);

    await tx
      .update(conversationMessages)
      .set({
        deliveryStatus: "queued",
        metadata: stripDraftFlag(meta)
      })
      .where(eq(conversationMessages.id, row.id));

    await tx
      .update(conversationThreads)
      .set({
        lastMessagePreview: (row.body ?? "").slice(0, 140),
        lastMessageAt: now,
        updatedAt: now
      })
      .where(eq(conversationThreads.id, row.threadId));

    if (existingSend[0]?.id) {
      await tx
        .update(outboxEvents)
        .set({ attempts: 0, nextAttemptAt: row.channel === "dm" ? now : sendAt, lastError: null })
        .where(eq(outboxEvents.id, existingSend[0].id));
    } else {
      await tx.insert(outboxEvents).values({
        type: "message.send",
        payload: { messageId: row.id },
        nextAttemptAt: row.channel === "dm" ? now : sendAt,
        createdAt: now
      });
    }
  });

  await recordAuditEvent({
    actor: { type: "ai", label: "sales-autopilot" },
    action: "sales.autopilot.autosent",
    entityType: "conversation_message",
    entityId: row.id,
    meta: { contactId }
  });

  return { status: "processed" };
}
