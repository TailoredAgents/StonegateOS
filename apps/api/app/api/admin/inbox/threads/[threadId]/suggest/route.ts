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
import { getBusinessHoursPolicy, getCompanyProfilePolicy, getServiceAreaPolicy, getTemplatesPolicy, isPostalCodeAllowed, normalizePostalCode, resolveTemplateForChannel } from "@/lib/policy";
import { isAdminRequest } from "../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

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
  direction: string;
  channel: string;
  subject: string | null;
  body: string;
  createdAt: Date;
  participantName: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReplyChannel(value: string): value is ReplyChannel {
  return value === "sms" || value === "email" || value === "dm";
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
    "gpt-5-mini";
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

  let response = await request(input.model);
  if (!response.ok) {
    const status = response.status;
    const bodyText = await response.text().catch(() => "");
    const isDev = process.env["NODE_ENV"] !== "production";
    if (isDev && (status === 400 || status === 404) && input.model !== "gpt-5") {
      response = await request("gpt-5");
      if (!response.ok) {
        const fallbackText = await response.text().catch(() => "");
        console.warn("[inbox.suggest] openai.fallback_failed", { status: response.status, bodyText: fallbackText });
        return { ok: false, error: "openai_request_failed", detail: fallbackText.slice(0, 300) };
      }
    } else {
      console.warn("[inbox.suggest] openai.request_failed", { status, bodyText });
      return { ok: false, error: "openai_request_failed", detail: bodyText.slice(0, 300) };
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
    if (!raw) return { ok: false, error: "openai_empty_response" };
    const parsed = tryParseJsonObject(raw);
    if (!parsed) return { ok: false, error: "openai_parse_failed" };
    return { ok: true, value: parsed };
  } catch (error) {
    console.warn("[inbox.suggest] openai.response_error", { error: String(error) });
    return { ok: false, error: "openai_parse_failed" };
  }
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

  const [templates, serviceArea, businessHours, companyProfile] = await Promise.all([
    getTemplatesPolicy(db),
    getServiceAreaPolicy(db),
    getBusinessHoursPolicy(db),
    getCompanyProfilePolicy(db)
  ]);

  const normalizedPostal = normalizePostalCode(threadContext.propertyPostalCode ?? null);
  const outOfArea =
    normalizedPostal !== null ? !isPostalCodeAllowed(normalizedPostal, serviceArea) : null;

  const firstTouchExample = resolveTemplateForChannel(templates.first_touch, {
    inboundChannel: replyChannel,
    replyChannel
  });
  const followUpExample = resolveTemplateForChannel(templates.follow_up, {
    inboundChannel: replyChannel,
    replyChannel
  });
  const outOfAreaExample =
    replyChannel === "email" || replyChannel === "sms"
      ? resolveTemplateForChannel(templates.out_of_area, { inboundChannel: replyChannel, replyChannel })
      : null;

  const systemPrompt = `
 You are Stonegate Assist, the warm, human, front-office voice for Stonegate Junk Removal in North Metro Atlanta.
 Write a reply the customer will receive.

 Rules:
 - Sound like a helpful local office rep. No emojis. Keep it natural and human.
 - Be concise and specific; avoid filler.
 - No bullet points, no numbered lists, no hyphens/dashes (do not use "-" "–" "—" anywhere in the customer message).
 - Ask for only the missing info needed to book: address (or ZIP), item details, and preferred timing.
 - If the customer is out of the service area, politely explain service area limits and offer a phone call.
 - Do NOT mention internal systems, databases, webhooks, or that you're an AI.
 - Output ONLY JSON with keys: body (string), subject (string). Use an empty string for subject when not needed.

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

  const contextLines = [
    `Channel: ${replyChannel}`,
    `Thread state: ${threadContext.state}`,
    `Customer name: ${threadContext.contactName ?? "Unknown"}`,
    threadContext.contactPhoneE164 || threadContext.contactPhone ? `Customer phone: ${threadContext.contactPhoneE164 ?? threadContext.contactPhone}` : null,
    threadContext.contactEmail ? `Customer email: ${threadContext.contactEmail}` : null,
    threadContext.propertyAddressLine1 ? `Property: ${threadContext.propertyAddressLine1}, ${threadContext.propertyCity ?? ""}, ${threadContext.propertyState ?? ""} ${threadContext.propertyPostalCode ?? ""}` : null,
    normalizedPostal ? `ZIP: ${normalizedPostal}` : null,
    outOfArea === true ? `Service area: OUT OF AREA` : outOfArea === false ? `Service area: OK` : `Service area: unknown (ask for ZIP)`,
    firstTouchExample ? `Example (first touch): ${firstTouchExample}` : null,
    followUpExample ? `Example (follow up): ${followUpExample}` : null,
    outOfAreaExample ? `Example (out of area): ${outOfAreaExample}` : null,
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

  const now = new Date();
  const created = await db.transaction(async (tx) => {
    const participantId = await ensureAiParticipant(tx, threadId, now);
    const [message] = await tx
      .insert(conversationMessages)
      .values({
        threadId,
        participantId,
        direction: "outbound",
        channel: replyChannel,
        subject: replyChannel === "email" ? suggestion.subject ?? thread.subject ?? "Stonegate message" : null,
        body: suggestion.body,
        toAddress,
        deliveryStatus: "queued",
        metadata: {
          ...(replyChannel === "dm" ? (dmMetadata ?? {}) : {}),
          draft: true,
          aiSuggested: true,
          aiModel: config.writeModel,
          outOfArea: outOfArea === true ? true : undefined
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
    entityId: threadId,
    meta: { channel: replyChannel, messageId: created.id }
  });

  return NextResponse.json({
    ok: true,
    messageId: created.id,
    channel: replyChannel,
    draft: {
      subject: replyChannel === "email" ? suggestion.subject ?? null : null,
      body: suggestion.body
    }
  });
}
