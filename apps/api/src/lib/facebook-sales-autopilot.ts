import { DateTime } from "luxon";
import { and, eq, gt } from "drizzle-orm";
import {
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  crmTasks,
  facebookSalesAutopilotActions,
  facebookSalesAutopilotSessions,
  getDb,
  outboxEvents,
} from "@/db";
import type { DatabaseClient } from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import { getAutonomousBookingDurationMinutes, isAfterHoursAutonomyActive } from "@/lib/after-hours-autonomy";
import { buildMediaJobAnalysisWithVision, getMediaJobAnalysis, upsertMediaJobAnalysis } from "@/lib/media-job-analysis";
import { loadOmniLeadContext, type OmniLeadContext } from "@/lib/omni-lead-context";
import { getSalesAutopilotPolicy, normalizePostalCode, type SalesAutopilotPolicy } from "@/lib/policy";
import { normalizePhoneE164 } from "@/lib/team-auth";

type AutonomyMode = SalesAutopilotPolicy["facebookCloser"]["mode"];
type FacebookCoaching = SalesAutopilotPolicy["facebookCoaching"];
type Stage =
  | "new_inquiry"
  | "missing_info"
  | "quote_ready"
  | "quote_sent"
  | "offered_times"
  | "confirmed_booking"
  | "needs_human_review"
  | "booked";
type ProposedAction =
  | "no_op"
  | "request_quote_details"
  | "request_photos"
  | "request_address"
  | "send_quote_range"
  | "offer_times"
  | "book_job"
  | "handoff_sms"
  | "human_review";

type OfferedSlot = { label: string; startAt: string; endAt?: string | null };

export type SimulatedSalesChatMessage = {
  role: "customer" | "agent";
  body: string;
  mediaUrls?: string[] | null;
  createdAt?: string | null;
};

export type SimulatedSalesChatResult = {
  reply: string | null;
  stage: Stage;
  proposedAction: ProposedAction;
  executedAction: "simulated_message" | "simulated_booking" | "simulated_human_review" | "none";
  reason: string;
  humanReviewReason: string | null;
  confidence: "low" | "medium" | "high";
  quoteRange: { lowCents: number; highCents: number; confidence: "low" | "medium" | "high" } | null;
  offeredSlots: OfferedSlot[];
  confirmedSlot: OfferedSlot | null;
  mode: AutonomyMode;
  channel: "dm" | "sms";
  debug: Record<string, unknown>;
};

type EvaluatedMessage = {
  id: string;
  threadId: string;
  channel: string;
  direction: string;
  body: string;
  mediaUrls: string[] | null;
  provider: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  receivedAt: Date | null;
  contactId: string | null;
  leadId: string | null;
  propertyId: string | null;
  toAddress: string | null;
  fromAddress: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnabledEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isSalesAutonomyTestOverrideActive(input: {
  row: Pick<EvaluatedMessage, "channel" | "fromAddress" | "toAddress">;
  context?: Pick<OmniLeadContext, "contact"> | null;
}): boolean {
  if (!isEnabledEnv(process.env["SALES_AUTONOMY_TEST_FORCE_AFTER_HOURS"])) return false;
  const targetPhone = normalizePhoneE164(process.env["SALES_AUTONOMY_TEST_PHONE_E164"]);
  if (!targetPhone) return false;
  const candidates = [
    input.row.channel === "sms" ? input.row.fromAddress : null,
    input.context?.contact.phoneE164 ?? null,
    input.context?.contact.phone ?? null,
  ];
  return candidates.some((candidate) => normalizePhoneE164(candidate) === targetPhone);
}

function forcedAfterHoursConversationAt(at: Date): Date {
  const zone = process.env["APPOINTMENT_TIMEZONE"] ?? process.env["GOOGLE_CALENDAR_TIMEZONE"] ?? "America/New_York";
  const local = DateTime.fromJSDate(at, { zone: "utc" }).setZone(zone);
  const base = local.isValid ? local : DateTime.now().setZone(zone);
  return base.set({ hour: 20, minute: 0, second: 0, millisecond: 0 }).toUTC().toJSDate();
}

const RISK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(demo|demolition|tear\s?down|knock\s?down)\b/i, "demolition"],
  [/\b(brush|land clearing|tree|stump|forestry)\b/i, "brush_or_land_clearing"],
  [/\b(dumpster|roll off|rolloff)\b/i, "dumpster"],
  [/\b(hot\s?tub|playset|shed|concrete|dirt|rock|paint|hazmat|hazardous|oil|chemical)\b/i, "non_standard_item"],
  [/\b(hoard|estate|whole house|entire house|commercial cleanout)\b/i, "large_cleanout"],
];

export function detectClearBookingConfirmation(body: string, offeredSlots: OfferedSlot[]): OfferedSlot | null {
  const text = body.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text || offeredSlots.length === 0) return null;
  const positive = /\b(yes|yeah|yep|ok|okay|sure|works|book|schedule|confirm|lock it|that works)\b/i.test(text);
  if (!positive) return null;

  const ordinalMatch = text.match(/\b(option\s*)?([123]|first|second|third|1st|2nd|3rd)\b/i);
  if (ordinalMatch) {
    const token = ordinalMatch[2]?.toLowerCase();
    const idx = token === "first" || token === "1st" || token === "1" ? 0 : token === "second" || token === "2nd" || token === "2" ? 1 : 2;
    return offeredSlots[idx] ?? null;
  }

  for (const slot of offeredSlots) {
    const dt = DateTime.fromISO(slot.startAt, { zone: "utc" }).setZone(process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York");
    if (!dt.isValid) continue;
    const weekday = dt.toFormat("cccc").toLowerCase();
    const shortWeekday = dt.toFormat("ccc").toLowerCase();
    const hour = dt.toFormat("h");
    const hourAmPm = dt.toFormat("h a").toLowerCase();
    if ((text.includes(weekday) || text.includes(shortWeekday)) && (text.includes(hourAmPm) || text.includes(`${hour} `) || text.endsWith(hour))) {
      return slot;
    }
  }

  return offeredSlots.length === 1 ? offeredSlots[0] ?? null : null;
}

export function estimateJunkQuoteRangeFromVolume(input: {
  volumeRange?: string | null;
  confidence?: string | null;
}): { lowCents: number; highCents: number; confidence: "low" | "medium" | "high" } | null {
  const confidence = input.confidence === "high" || input.confidence === "medium" ? input.confidence : "low";
  switch ((input.volumeRange ?? "").toLowerCase()) {
    case "under_quarter":
      return { lowCents: 17500, highCents: 19500, confidence };
    case "quarter":
      return { lowCents: 19500, highCents: 31000, confidence };
    case "quarter_to_half":
      return { lowCents: 25000, highCents: 40000, confidence };
    case "half":
      return { lowCents: 32000, highCents: 47000, confidence };
    case "half_to_three_quarters":
      return { lowCents: 48000, highCents: 62000, confidence };
    case "three_quarters":
      return { lowCents: 55000, highCents: 70000, confidence };
    case "three_quarters_to_full":
      return { lowCents: 63000, highCents: 85000, confidence };
    case "full":
      return { lowCents: 85000, highCents: 110000, confidence };
    default:
      return null;
  }
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function latestMeaningfulInboundAt(context: OmniLeadContext, channel: string): Date | null {
  for (let i = context.recentMessages.length - 1; i >= 0; i -= 1) {
    const msg = context.recentMessages[i];
    if (msg?.channel === channel && msg.direction === "inbound" && msg.body.trim().length > 0) {
      const parsed = new Date(msg.receivedAt ?? msg.createdAt);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }
  return null;
}

function hasUsableProperty(context: OmniLeadContext): boolean {
  const property = context.properties[0];
  if (!property) return false;
  if (!property.addressLine1 || /^\[(FB Lead|Manual booking)/i.test(property.addressLine1)) return false;
  if (!property.city || property.city === "Unknown") return false;
  if (!property.postalCode || property.postalCode === "00000") return false;
  return true;
}

export function detectFacebookSalesRisk(context: Pick<OmniLeadContext, "latestLead" | "instantQuote" | "recentMessages">): string | null {
  const text = [
    context.latestLead?.notes,
    context.instantQuote?.notes,
    ...context.recentMessages.filter((msg) => msg.direction === "inbound").map((msg) => msg.body),
  ]
    .filter(Boolean)
    .join("\n");
  for (const [pattern, reason] of RISK_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

function customerAskedForTimes(body: string): boolean {
  return /\b(when|time|times|available|availability|schedule|book|appointment|come out|today|tomorrow|friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/i.test(body);
}

function customerAskedForQuote(body: string): boolean {
  return /\b(price|pricing|quote|estimate|cost|how much|\$)\b/i.test(body);
}

function customerAcceptedQuoteOrScheduling(body: string): boolean {
  return /\b(yes|yeah|yep|ok|okay|sounds good|looks good|that works|works for me|i like|book|schedule|set it up|let's do|lets do|go ahead)\b/i.test(
    body,
  );
}

function confidenceMeetsPolicy(confidence: "low" | "medium" | "high", min: "medium" | "high"): boolean {
  if (min === "high") return confidence === "high";
  return confidence === "medium" || confidence === "high";
}

function normalizeKeywordText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function findCoachingKeyword(body: string, keywords: string[]): string | null {
  const text = normalizeKeywordText(body);
  for (const keyword of keywords) {
    const normalized = normalizeKeywordText(keyword);
    if (normalized && text.includes(normalized)) return normalized;
  }
  return null;
}

function isOutboundAutomationAction(action: ProposedAction): boolean {
  return (
    action === "request_quote_details" ||
    action === "request_photos" ||
    action === "request_address" ||
    action === "send_quote_range" ||
    action === "offer_times" ||
    action === "book_job"
  );
}

export function applyFacebookCoachingGuards(input: {
  body: string;
  action: ProposedAction;
  stage: Stage;
  mediaCount: number;
  coaching: FacebookCoaching;
}): { action: ProposedAction; stage: Stage; reason: string | null; humanReviewReason: string | null } | null {
  const { body, coaching } = input;
  if (!coaching.enabled) return null;

  const reviewKeyword = findCoachingKeyword(body, coaching.humanReviewKeywords);
  if (reviewKeyword) {
    return {
      action: "human_review",
      stage: "needs_human_review",
      reason: `owner_coaching_review_keyword:${reviewKeyword}`,
      humanReviewReason: `owner_coaching_review_keyword:${reviewKeyword}`,
    };
  }

  const blockedKeyword = findCoachingKeyword(body, coaching.blockedAutoReplyKeywords);
  if (blockedKeyword && isOutboundAutomationAction(input.action)) {
    return {
      action: "human_review",
      stage: "needs_human_review",
      reason: `owner_coaching_blocked_auto_reply:${blockedKeyword}`,
      humanReviewReason: `owner_coaching_blocked_auto_reply:${blockedKeyword}`,
    };
  }

  if (
    coaching.requirePhotosBeforeQuote &&
    input.mediaCount === 0 &&
    (input.action === "send_quote_range" || input.action === "offer_times" || input.action === "book_job")
  ) {
    return {
      action: "request_photos",
      stage: "missing_info",
      reason: "owner_coaching_photos_required",
      humanReviewReason: null,
    };
  }

  if (coaching.requireHumanReviewBeforeBooking && input.action === "book_job") {
    return {
      action: "human_review",
      stage: "needs_human_review",
      reason: "owner_coaching_booking_review_required",
      humanReviewReason: "owner_coaching_booking_review_required",
    };
  }

  return null;
}

async function getEvaluatedMessage(db: DatabaseClient, messageId: string): Promise<EvaluatedMessage | null> {
  const [row] = await db
    .select({
      id: conversationMessages.id,
      threadId: conversationMessages.threadId,
      channel: conversationMessages.channel,
      direction: conversationMessages.direction,
      body: conversationMessages.body,
      mediaUrls: conversationMessages.mediaUrls,
      provider: conversationMessages.provider,
      metadata: conversationMessages.metadata,
      createdAt: conversationMessages.createdAt,
      receivedAt: conversationMessages.receivedAt,
      contactId: conversationThreads.contactId,
      leadId: conversationThreads.leadId,
      propertyId: conversationThreads.propertyId,
      toAddress: conversationMessages.toAddress,
      fromAddress: conversationMessages.fromAddress,
    })
    .from(conversationMessages)
    .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .where(eq(conversationMessages.id, messageId))
    .limit(1);
  return row ? (row as EvaluatedMessage) : null;
}

async function ensureSession(input: {
  db: DatabaseClient;
  row: EvaluatedMessage;
  stage: Stage;
  mode: AutonomyMode;
  lastDecision: ProposedAction;
  reason: string;
  humanReviewReason?: string | null;
  quoteLowCents?: number | null;
  quoteHighCents?: number | null;
  offeredSlots?: OfferedSlot[] | null;
  lastMeaningfulInboundAt?: Date | null;
}) {
  const now = new Date();
  const values = {
    contactId: input.row.contactId,
    leadId: input.row.leadId,
    threadId: input.row.threadId,
    channel: "dm",
    stage: input.stage,
    autonomyMode: input.mode,
    lastDecision: input.lastDecision,
    lastDecisionReason: input.reason,
    lastHumanReviewReason: input.humanReviewReason ?? null,
    lastEvaluatedMessageId: input.row.id,
    lastMeaningfulInboundAt: input.lastMeaningfulInboundAt ?? input.row.receivedAt ?? input.row.createdAt,
    quoteLowCents: input.quoteLowCents ?? null,
    quoteHighCents: input.quoteHighCents ?? null,
    offeredSlotsJson: input.offeredSlots ?? null,
    metadata: { source: "facebook_sales_autopilot_v1" },
    createdAt: now,
    updatedAt: now,
  };
  const [session] = await input.db
    .insert(facebookSalesAutopilotSessions)
    .values(values)
    .onConflictDoUpdate({
      target: facebookSalesAutopilotSessions.threadId,
      set: {
        contactId: values.contactId,
        leadId: values.leadId,
        stage: values.stage,
        autonomyMode: values.autonomyMode,
        lastDecision: values.lastDecision,
        lastDecisionReason: values.lastDecisionReason,
        lastHumanReviewReason: values.lastHumanReviewReason,
        lastEvaluatedMessageId: values.lastEvaluatedMessageId,
        lastMeaningfulInboundAt: values.lastMeaningfulInboundAt,
        quoteLowCents: values.quoteLowCents,
        quoteHighCents: values.quoteHighCents,
        offeredSlotsJson: values.offeredSlotsJson,
        metadata: values.metadata,
        updatedAt: now,
      },
    })
    .returning();
  return session;
}

async function recordAction(input: {
  db: DatabaseClient;
  sessionId: string | null;
  row: EvaluatedMessage;
  stage: Stage;
  mode: AutonomyMode;
  proposedAction: ProposedAction;
  executedAction?: string | null;
  confidence?: "low" | "medium" | "high";
  reason: string;
  humanReviewReason?: string | null;
  inputSnapshot?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}) {
  const [action] = await input.db
    .insert(facebookSalesAutopilotActions)
    .values({
      sessionId: input.sessionId,
      contactId: input.row.contactId,
      leadId: input.row.leadId,
      threadId: input.row.threadId,
      messageId: input.row.id,
      proposedAction: input.proposedAction,
      executedAction: input.executedAction ?? null,
      autonomyMode: input.mode,
      stage: input.stage,
      confidence: input.confidence ?? "medium",
      decisionReason: input.reason,
      humanReviewReason: input.humanReviewReason ?? null,
      inputSnapshot: input.inputSnapshot ?? null,
      resultJson: input.result ?? null,
      error: input.error ?? null,
      createdAt: new Date(),
    })
    .returning({ id: facebookSalesAutopilotActions.id });
  return action?.id ?? null;
}

async function createOutboundDmDraft(input: {
  db: DatabaseClient;
  row: EvaluatedMessage;
  body: string;
  mode: AutonomyMode;
  send: boolean;
  channel?: "dm" | "sms";
}): Promise<string | null> {
  const channel = input.channel ?? (input.row.channel === "sms" ? "sms" : "dm");
  const now = new Date();
  const [existingRecentOutbound] = await input.db
    .select({ id: conversationMessages.id, metadata: conversationMessages.metadata })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.threadId, input.row.threadId),
        eq(conversationMessages.direction, "outbound"),
        eq(conversationMessages.channel, channel),
        gt(conversationMessages.createdAt, input.row.createdAt),
      ),
    )
    .limit(1);
  if (existingRecentOutbound?.id) {
    const existingMeta = isRecord(existingRecentOutbound.metadata)
      ? existingRecentOutbound.metadata
      : null;
    if (existingMeta?.["draft"] !== true) return null;
    await input.db.delete(conversationMessages).where(eq(conversationMessages.id, existingRecentOutbound.id));
  }

  let [participant] = await input.db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(and(eq(conversationParticipants.threadId, input.row.threadId), eq(conversationParticipants.participantType, "system")))
    .limit(1);
  if (!participant?.id) {
    [participant] = await input.db
      .insert(conversationParticipants)
      .values({
        threadId: input.row.threadId,
        participantType: "system",
        displayName: "Stonegate Assistant",
        createdAt: now,
      })
      .returning({ id: conversationParticipants.id });
  }

  const [message] = await input.db
    .insert(conversationMessages)
    .values({
      threadId: input.row.threadId,
      participantId: participant?.id ?? null,
      direction: "outbound",
      channel,
      body: input.body,
      toAddress: input.row.fromAddress,
      deliveryStatus: input.send ? "queued" : "queued",
      metadata: {
        ...(input.row.metadata ?? {}),
        ...(input.send ? {} : { draft: true }),
        facebookSalesAutopilot: true,
        facebookSalesAutopilotMode: input.mode,
      },
      createdAt: now,
    })
    .returning({ id: conversationMessages.id });

  if (!message?.id) return null;
  if (input.send) {
    await input.db.insert(outboxEvents).values({
      type: "message.send",
      payload: { messageId: message.id },
      createdAt: now,
    });
  }
  return message.id;
}

export function buildQuoteMessage(range: { lowCents: number; highCents: number }, summary: string | null, coaching: FacebookCoaching): string {
  const scope = summary ? ` From the photos, ${summary.replace(/\s+/g, " ").slice(0, 180)}` : "";
  if (coaching.enabled && coaching.tone === "concise") {
    return `Looks like ${money(range.lowCents)}-${money(range.highCents)} based on what I can tell.${scope} Want to schedule a free in-person quote?`;
  }
  if (coaching.enabled && coaching.tone === "professional") {
    return `Based on the information available, the job is likely around ${money(range.lowCents)}-${money(range.highCents)}.${scope} Final pricing can change if volume, weight, access, or materials differ in person. Would you like to schedule a free in-person quote?`;
  }
  return `Based on what I can tell, you're likely around ${money(range.lowCents)}-${money(range.highCents)}.${scope} Final price only changes if volume, weight, access, or materials differ in person. Want to schedule a free in-person quote?`;
}

function buildAddressAsk(coaching: FacebookCoaching): string {
  if (coaching.enabled && coaching.tone === "concise") {
    return "What's the pickup address or ZIP code?";
  }
  if (coaching.enabled && coaching.tone === "professional") {
    return "I can help with that. What is the pickup address or ZIP code?";
  }
  return "I can get this moving. What's the pickup address or at least the ZIP code?";
}

function buildPhotoAsk(coaching: FacebookCoaching): string {
  if (coaching.enabled && coaching.tone === "concise") {
    return "Can you send a couple photos? I can price it tighter once I can see it.";
  }
  if (coaching.enabled && coaching.tone === "professional") {
    return "Could you send a couple photos of what needs to be removed? Once I can see it, I can provide a tighter range and appointment options.";
  }
  return "Can you send a couple photos of what needs to go? Once I can see it, I can give you a tighter range and times.";
}

function latestInboundText(context: Pick<OmniLeadContext, "latestLead" | "instantQuote" | "recentMessages">): string {
  return [
    context.latestLead?.notes,
    context.instantQuote?.notes,
    ...context.recentMessages.filter((msg) => msg.direction === "inbound").map((msg) => msg.body),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .toLowerCase();
}

function detectTextJobTypes(text: string): string[] {
  const types = new Set<string>();
  if (/\b(couch|sofa|dresser|table|chair|desk|bed|mattress|furniture)\b/i.test(text)) types.add("furniture");
  if (/\b(fridge|refrigerator|washer|dryer|stove|oven|dishwasher|appliance)\b/i.test(text)) types.add("appliances");
  if (/\b(construction|renovation|remodel|drywall|lumber|debris|tile|cabinet)\b/i.test(text)) types.add("construction_debris");
  if (/\b(hot tub|playset|swing set)\b/i.test(text)) types.add("hot_tub_playset");
  if (/\b(office|business|commercial|warehouse)\b/i.test(text)) types.add("business_commercial");
  if (types.size === 0 && /\b(junk|trash|stuff|items|garage|basement|cleanout|pickup|haul)\b/i.test(text)) types.add("general_junk");
  return [...types];
}

function detectTextPerceivedSize(text: string): string | null {
  if (/\b(single|one item|1 item|one couch|one sofa|one mattress|one appliance)\b/i.test(text)) return "single_item";
  if (/\b(small|few items|couple items|quarter|1\/4|¼|min pickup|minimum)\b/i.test(text)) return "min_pickup";
  if (/\b(half|1\/2|½|medium|one room|1 room)\b/i.test(text)) return "half_trailer";
  if (/\b(three quarter|3\/4|¾|large|two rooms|2 rooms|several bulky)\b/i.test(text)) return "three_quarter_trailer";
  if (/\b(full|huge|big cleanout|whole garage|full garage|basement|multiple rooms|estate)\b/i.test(text)) return "big_cleanout";
  return null;
}

function estimateJunkQuoteRangeFromText(input: {
  perceivedSize?: string | null;
  confidence?: "low" | "medium" | "high";
}): { lowCents: number; highCents: number; confidence: "low" | "medium" | "high" } | null {
  const confidence = input.confidence ?? "medium";
  switch ((input.perceivedSize ?? "").toLowerCase()) {
    case "single_item":
      return { lowCents: 17500, highCents: 17500, confidence };
    case "min_pickup":
      return { lowCents: 19500, highCents: 31000, confidence };
    case "half_trailer":
      return { lowCents: 32000, highCents: 47000, confidence };
    case "three_quarter_trailer":
      return { lowCents: 48000, highCents: 62000, confidence };
    case "big_cleanout":
      return { lowCents: 63000, highCents: 85000, confidence: "low" };
    default:
      return null;
  }
}

export function getTextQuoteReadiness(context: Pick<OmniLeadContext, "latestLead" | "instantQuote" | "recentMessages" | "derived">): {
  quoteRange: { lowCents: number; highCents: number; confidence: "low" | "medium" | "high" } | null;
  missingQuestion: string | null;
  snapshot: Record<string, unknown>;
} {
  const text = latestInboundText(context);
  const jobTypes = context.instantQuote?.jobTypes?.length ? context.instantQuote.jobTypes : detectTextJobTypes(text);
  const perceivedSize = context.instantQuote?.perceivedSize && context.instantQuote.perceivedSize !== "not_sure"
    ? context.instantQuote.perceivedSize
    : detectTextPerceivedSize(text);
  const zip =
    normalizePostalCode(context.instantQuote?.zip ?? null) ??
    normalizePostalCode(context.derived.knownZip ?? null) ??
    normalizePostalCode((text.match(/\b\d{5}\b/) ?? [])[0] ?? null);

  if (!zip && !context.derived.knownCity) {
    return {
      quoteRange: null,
      missingQuestion: "What ZIP code is the pickup in?",
      snapshot: { jobTypes, perceivedSize, zip: null },
    };
  }
  if (jobTypes.length === 0) {
    return {
      quoteRange: null,
      missingQuestion: "What all needs to go?",
      snapshot: { jobTypes, perceivedSize, zip },
    };
  }
  if (!perceivedSize) {
    return {
      quoteRange: null,
      missingQuestion: "About how much is it: single item, small pickup, half trailer, 3/4 trailer, or full trailer?",
      snapshot: { jobTypes, perceivedSize: null, zip },
    };
  }
  return {
    quoteRange: estimateJunkQuoteRangeFromText({ perceivedSize, confidence: context.recentMessages.some((msg) => (msg.mediaUrls?.length ?? 0) > 0) ? "medium" : "low" }),
    missingQuestion: null,
    snapshot: { jobTypes, perceivedSize, zip },
  };
}

function buildQuoteDetailsAsk(question: string, coaching: FacebookCoaching): string {
  if (coaching.enabled && coaching.tone === "professional") {
    return `I can get you a ballpark. ${question}`;
  }
  return question;
}

async function fetchBookingAssist(input: {
  property: OmniLeadContext["properties"][number];
  durationMinutes?: number;
  autonomousConversationAt?: Date | null;
}): Promise<OfferedSlot[]> {
  const apiBase = process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"];
  const adminKey = process.env["ADMIN_API_KEY"];
  if (!apiBase || !adminKey) return [];
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/api/admin/booking/assist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": adminKey },
    body: JSON.stringify({
      addressLine1: input.property.addressLine1,
      city: input.property.city,
      state: input.property.state,
      postalCode: input.property.postalCode,
      durationMinutes: input.durationMinutes ?? getAutonomousBookingDurationMinutes(),
      windowDays: 7,
      autonomousConversationAt: input.autonomousConversationAt?.toISOString(),
    }),
  });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => null)) as { suggestions?: Array<{ startAt?: string; endAt?: string }> } | null;
  return (data?.suggestions ?? [])
    .filter((slot): slot is { startAt: string; endAt?: string } => typeof slot.startAt === "string")
    .slice(0, 3)
    .map((slot, index) => {
      const dt = DateTime.fromISO(slot.startAt, { zone: "utc" }).setZone(process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York");
      return {
        label: `Option ${index + 1}: ${dt.isValid ? dt.toFormat("ccc, LLL d 'at' h:mm a") : slot.startAt}`,
        startAt: slot.startAt,
        endAt: slot.endAt ?? null,
      };
    });
}

function buildSlotsMessage(slots: OfferedSlot[], coaching: FacebookCoaching): string {
  if (coaching.enabled && coaching.tone === "concise") {
    return `${slots.map((slot) => slot.label.replace(/^Option \d+:\s*/, "")).join(" or ")}. Which works?`;
  }
  if (coaching.enabled && coaching.tone === "professional") {
    return `I have availability for ${slots.map((slot) => slot.label.replace(/^Option \d+:\s*/, "")).join(" or ")}. Which option works best for you?`;
  }
  return `I can do ${slots.map((slot) => slot.label.replace(/^Option \d+:\s*/, "")).join(" or ")}. Which one works best?`;
}

function buildSimulatedSlots(): OfferedSlot[] {
  const zone = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";
  const slots: OfferedSlot[] = [];
  let cursor = DateTime.now().setZone(zone).plus({ days: 1 }).startOf("day");
  const slotHours = [10, 13, 16];

  while (slots.length < 3) {
    if (cursor.weekday !== 7) {
      const hour = slotHours[slots.length % slotHours.length] ?? 10;
      const start = cursor.set({ hour, minute: 0, second: 0, millisecond: 0 });
      slots.push({
        label: `Option ${slots.length + 1}: ${start.toFormat("ccc, LLL d 'at' h:mm a")}`,
        startAt: start.toUTC().toISO() ?? start.toISO() ?? new Date().toISOString(),
        endAt: start.plus({ minutes: getAutonomousBookingDurationMinutes() }).toUTC().toISO(),
      });
    }
    cursor = cursor.plus({ days: 1 });
  }

  return slots;
}

function buildHumanReviewReply(reason: string): string {
  const label = reason.replace(/owner_coaching_review_keyword:/, "").replace(/_/g, " ");
  return `I want to make sure we handle that correctly, so I am going to have someone from our team review this and follow up. Reason: ${label}.`;
}

export function simulateFacebookSalesChatTurn(input: {
  channel?: "dm" | "sms" | null;
  messages: SimulatedSalesChatMessage[];
  policy: SalesAutopilotPolicy;
  context?: Pick<OmniLeadContext, "latestLead" | "instantQuote" | "derived" | "recentMessages"> | null;
  previousQuoteRange?: { lowCents: number; highCents: number; confidence?: "low" | "medium" | "high" } | null;
  previousOfferedSlots?: OfferedSlot[] | null;
}): SimulatedSalesChatResult {
  const channel = input.channel === "sms" ? "sms" : "dm";
  const closer = input.policy.facebookCloser;
  const coaching = input.policy.facebookCoaching;
  const mode = closer.mode;
  const nowIso = new Date().toISOString();
  const normalizedMessages = input.messages
    .map((message) => ({
      ...message,
      body: typeof message.body === "string" ? message.body.trim() : "",
      mediaUrls: Array.isArray(message.mediaUrls) ? message.mediaUrls.filter(Boolean) : [],
    }))
    .filter((message) => message.body.length > 0 || (message.mediaUrls?.length ?? 0) > 0);
  const latestCustomerMessage = [...normalizedMessages].reverse().find((message) => message.role === "customer");
  const latestBody = latestCustomerMessage?.body ?? "";
  const simulatedMessages = normalizedMessages.map((message, index) => ({
    id: `simulated-message-${index + 1}`,
    threadId: "simulated-thread",
    direction: message.role === "customer" ? "inbound" : "outbound",
    channel,
    subject: null,
    body: message.body,
    participantName: message.role === "customer" ? "Simulated Customer" : "Stonegate Assistant",
    mediaUrls: message.mediaUrls ?? [],
    createdAt: message.createdAt ?? nowIso,
    sentAt: message.role === "agent" ? (message.createdAt ?? nowIso) : null,
    receivedAt: message.role === "customer" ? (message.createdAt ?? nowIso) : null,
  }));
  const recentMessages = [
    ...(input.context?.recentMessages ?? []),
    ...simulatedMessages,
  ].slice(-80);
  const context: Pick<OmniLeadContext, "latestLead" | "instantQuote" | "derived" | "recentMessages"> = {
    latestLead: input.context?.latestLead ?? null,
    instantQuote: input.context?.instantQuote ?? null,
    derived: input.context?.derived ?? {
        knownZip: null,
        knownCity: null,
        objections: [],
        channelPreference: channel,
        dmEntrySource: channel === "dm" ? "organic_messenger" : null,
        customerIntent: null,
        pricingContext: null,
        lastPromisedNextStep: null,
        lastHumanSummary: null,
        bookingReadiness: "low",
        quoteConfidence: "low",
        missingFields: [],
        exceptionSignals: [],
      },
    recentMessages,
  };
  const mediaCount = recentMessages.reduce((sum, message) => sum + (message.mediaUrls?.length ?? 0), 0);
  const riskReason = detectFacebookSalesRisk(context);
  const textQuote = getTextQuoteReadiness(context);
  const contextQuoteRange =
    input.context?.instantQuote?.priceLow && input.context.instantQuote.priceHigh
      ? {
          lowCents: Math.round(input.context.instantQuote.priceLow * 100),
          highCents: Math.round(input.context.instantQuote.priceHigh * 100),
          confidence: "medium" as const,
        }
      : null;
  const previousQuoteRange =
    input.previousQuoteRange && Number.isFinite(input.previousQuoteRange.lowCents) && Number.isFinite(input.previousQuoteRange.highCents)
      ? {
          lowCents: Math.round(input.previousQuoteRange.lowCents),
          highCents: Math.round(input.previousQuoteRange.highCents),
          confidence: input.previousQuoteRange.confidence ?? "medium",
        }
      : null;
  const quoteRange = contextQuoteRange ?? textQuote.quoteRange ?? previousQuoteRange;
  const confidence = quoteRange?.confidence ?? "medium";
  const previousOfferedSlots = Array.isArray(input.previousOfferedSlots) ? input.previousOfferedSlots : [];
  const confirmedSlot = detectClearBookingConfirmation(latestBody, previousOfferedSlots);

  let stage: Stage = "new_inquiry";
  let action: ProposedAction = "no_op";
  let reason = "no_action_needed";
  let humanReviewReason: string | null = null;

  if (mode === "off" || closer.emergencyStop) {
    action = "no_op";
    reason = mode === "off" ? "sales_closer_off" : "sales_closer_emergency_stop";
  } else if (riskReason) {
    stage = "needs_human_review";
    action = "human_review";
    humanReviewReason = riskReason;
    reason = riskReason;
  } else if (confirmedSlot && quoteRange) {
    stage = "confirmed_booking";
    action = "book_job";
    reason = "customer_confirmed_offered_slot";
  } else if (confirmedSlot && !quoteRange) {
    stage = "needs_human_review";
    action = "human_review";
    humanReviewReason = "confirmation_without_quote";
    reason = "confirmation_without_quote";
  } else if ((customerAskedForTimes(latestBody) || (previousQuoteRange && customerAcceptedQuoteOrScheduling(latestBody))) && quoteRange) {
    stage = "quote_ready";
    action = "offer_times";
    reason = "customer_asked_for_times_after_quote";
  } else if (quoteRange && customerAskedForQuote(latestBody)) {
    stage = "quote_ready";
    action = "send_quote_range";
    reason = "quote_range_available";
  } else if (!quoteRange) {
    stage = "missing_info";
    action = textQuote.missingQuestion ? "request_quote_details" : "request_photos";
    reason = textQuote.missingQuestion ? "quote_details_required" : "photos_or_more_job_detail_required";
  }

  if (quoteRange && quoteRange.highCents > closer.maxAutoBookTotalCents && action === "book_job") {
    stage = "needs_human_review";
    action = "human_review";
    humanReviewReason = "quote_above_auto_book_limit";
    reason = "quote_above_auto_book_limit";
  }
  if (quoteRange && quoteRange.highCents > closer.requirePhotosAboveCents && mediaCount === 0 && (action === "send_quote_range" || action === "offer_times" || action === "book_job")) {
    stage = "missing_info";
    action = "request_photos";
    humanReviewReason = null;
    reason = "photos_required_above_threshold";
  }
  if (quoteRange && !confidenceMeetsPolicy(quoteRange.confidence, closer.minConfidence) && (action === "book_job" || action === "offer_times")) {
    stage = "needs_human_review";
    action = "human_review";
    humanReviewReason = "quote_confidence_too_low";
    reason = "quote_confidence_too_low";
  }

  const coachingOverride = applyFacebookCoachingGuards({ body: latestBody, action, stage, mediaCount, coaching });
  if (coachingOverride) {
    stage = coachingOverride.stage;
    action = coachingOverride.action;
    reason = coachingOverride.reason ?? reason;
    humanReviewReason = coachingOverride.humanReviewReason;
  }

  let offeredSlots: OfferedSlot[] = [];
  let reply: string | null = null;
  let executedAction: SimulatedSalesChatResult["executedAction"] = "none";

  if (action === "request_address" || action === "request_quote_details" || action === "request_photos") {
    reply = action === "request_address" ? buildAddressAsk(coaching) : action === "request_quote_details" && textQuote.missingQuestion ? buildQuoteDetailsAsk(textQuote.missingQuestion, coaching) : buildPhotoAsk(coaching);
    executedAction = "simulated_message";
  } else if (action === "send_quote_range" && quoteRange) {
    reply = buildQuoteMessage(quoteRange, null, coaching);
    executedAction = "simulated_message";
  } else if (action === "offer_times") {
    offeredSlots = buildSimulatedSlots();
    reply = buildSlotsMessage(offeredSlots, coaching);
    executedAction = "simulated_message";
  } else if (action === "book_job" && confirmedSlot && quoteRange) {
    reply = `Simulation only: this would book ${confirmedSlot.label.replace(/^Option \d+:\s*/, "")} and send a confirmation. No real appointment was created.`;
    executedAction = "simulated_booking";
  } else if (action === "human_review") {
    reply = buildHumanReviewReply(humanReviewReason ?? reason);
    executedAction = "simulated_human_review";
  }

  return {
    reply,
    stage,
    proposedAction: action,
    executedAction,
    reason,
    humanReviewReason,
    confidence,
    quoteRange,
    offeredSlots,
    confirmedSlot,
    mode,
    channel,
    debug: {
      mediaCount,
      textQuote: textQuote.snapshot,
      realContactContext: Boolean(input.context),
      simulationOnly: true,
      realMessageQueued: false,
      realBookingCreated: false,
    },
  };
}

function buildBookingDetails(range: { lowCents: number; highCents: number }) {
  return {
    serviceType: "junk_removal",
    source: { type: "facebook" },
    pricing: { mode: "range", rangeMinCents: range.lowCents, rangeMaxCents: range.highCents },
    loadSize: { kind: "custom", customLoads: Math.max(0.25, Math.round((range.highCents / 85000) * 4) / 4) },
  };
}

async function bookSlot(input: {
  contactId: string;
  propertyId: string;
  slot: OfferedSlot;
  range: { lowCents: number; highCents: number };
  conversationAt: Date;
}): Promise<{ ok: true; appointmentId: string; startAt: string } | { ok: false; error: string }> {
  const apiBase = process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"];
  const adminKey = process.env["ADMIN_API_KEY"];
  if (!apiBase || !adminKey) return { ok: false, error: "api_not_configured" };
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/api/admin/booking/book`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": adminKey, "x-actor-label": "facebook-autopilot" },
    body: JSON.stringify({
      contactId: input.contactId,
      propertyId: input.propertyId,
      appointmentType: "in_person_quote",
      startAt: input.slot.startAt,
      durationMinutes: getAutonomousBookingDurationMinutes(),
      travelBufferMinutes: 30,
      source: "sales_autopilot",
      autonomousConversationAt: input.conversationAt.toISOString(),
      services: ["junk_removal"],
      quotedTotalCents: null,
      bookingDetails: buildBookingDetails(input.range),
      notes: `Autonomous sales booking for free in-person quote. Quoted range ${money(input.range.lowCents)}-${money(input.range.highCents)}.`,
    }),
  });
  const data = (await response.json().catch(() => null)) as { appointmentId?: string; startAt?: string; error?: string } | null;
  if (!response.ok || !data?.appointmentId) return { ok: false, error: data?.error ?? `booking_failed_${response.status}` };
  return { ok: true, appointmentId: data.appointmentId, startAt: data.startAt ?? input.slot.startAt };
}

async function createHumanReviewTask(db: DatabaseClient, contactId: string | null, reason: string): Promise<void> {
  if (!contactId) return;
  const title = `Review Facebook autopilot: ${reason.replace(/_/g, " ")}`.slice(0, 180);
  await db.insert(crmTasks).values({
    contactId,
    title,
    status: "open",
    notes: "Facebook Sales Autopilot blocked this thread for human review.",
    dueAt: new Date(),
    assignedTo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function handleFacebookSalesEvaluate(messageId: string): Promise<{ status: "processed" | "skipped" | "retry"; error?: string | null }> {
  const db = getDb();
  const row = await getEvaluatedMessage(db, messageId);
  if (!row || row.direction !== "inbound" || (row.channel !== "dm" && row.channel !== "sms")) return { status: "skipped" };
  const metadataSource = row.metadata?.["source"];
  const source =
    (typeof metadataSource === "string" ? metadataSource : row.provider ?? "").toLowerCase();
  if (row.channel === "dm" && !source.includes("facebook")) return { status: "skipped" };
  if (!row.contactId) return { status: "skipped" };

  const policy = await getSalesAutopilotPolicy(db);
  const closer = policy.facebookCloser;
  const coaching = policy.facebookCoaching;
  const naturalAutonomyWindow = isAfterHoursAutonomyActive({ at: row.createdAt });
  const context = await loadOmniLeadContext(db, { contactId: row.contactId, includeQuotePrice: true, messageLimit: 60 });
  if (!context) return { status: "skipped" };
  const testAutonomyOverride = isSalesAutonomyTestOverrideActive({ row, context });
  const inAutonomyWindow = naturalAutonomyWindow || testAutonomyOverride;
  const mode: AutonomyMode = closer.mode === "auto" && !inAutonomyWindow ? "assist" : closer.mode;

  const latestInboundAt = latestMeaningfulInboundAt(context, row.channel) ?? row.receivedAt ?? row.createdAt;
  const autonomousConversationAt =
    testAutonomyOverride && !naturalAutonomyWindow ? forcedAfterHoursConversationAt(latestInboundAt) : latestInboundAt;
  const responseWindowMs = closer.messengerResponseWindowHours * 60 * 60 * 1000;
  const outsideMessengerWindow = row.channel === "dm" && Date.now() - latestInboundAt.getTime() > responseWindowMs;
  const leadAutomation = context.automation.find((entry) => entry.channel === row.channel);
  const hasBookedAppointment = Boolean(context.nextAppointment && context.nextAppointment.status !== "canceled");
  const riskReason = detectFacebookSalesRisk(context);
  const latestBody = row.body ?? "";
  const mediaCount = context.recentMessages.reduce((sum, msg) => sum + (msg.mediaUrls?.length ?? 0), 0);
  const snapshot: Record<string, unknown> = {
    contactId: row.contactId,
    threadId: row.threadId,
    leadId: row.leadId,
    body: latestBody.slice(0, 500),
    mediaCount,
    mode,
    inAutonomyWindow,
    naturalAutonomyWindow,
    testAutonomyOverride,
    channel: row.channel,
    ownerCoaching: coaching.enabled
      ? {
          tone: coaching.tone,
          requirePhotosBeforeQuote: coaching.requirePhotosBeforeQuote,
          requireHumanReviewBeforeBooking: coaching.requireHumanReviewBeforeBooking,
          humanReviewKeywords: coaching.humanReviewKeywords,
          blockedAutoReplyKeywords: coaching.blockedAutoReplyKeywords,
          playbook: coaching.playbook.slice(0, 1000),
        }
      : { enabled: false },
  };

  let stage: Stage = "new_inquiry";
  let action: ProposedAction = "no_op";
  let reason = "no_action_needed";
  let humanReviewReason: string | null = null;
  let confidence: "low" | "medium" | "high" = "medium";
  let quoteRange: { lowCents: number; highCents: number; confidence: "low" | "medium" | "high" } | null =
    context.instantQuote?.priceLow && context.instantQuote.priceHigh
      ? { lowCents: Math.round(context.instantQuote.priceLow * 100), highCents: Math.round(context.instantQuote.priceHigh * 100), confidence: "medium" }
      : null;

  if (context.mediaAnalysis && !quoteRange) {
    quoteRange = estimateJunkQuoteRangeFromVolume({
      volumeRange: context.mediaAnalysis.mergedVolumeRange,
      confidence: context.mediaAnalysis.confidence,
    });
  }

  if (!quoteRange) {
    const existingAnalysis = await getMediaJobAnalysis(db, row.contactId);
    if (!existingAnalysis && context.recentMessages.some((msg) => (msg.mediaUrls?.length ?? 0) > 0)) {
      const analysis = await buildMediaJobAnalysisWithVision(context);
      await upsertMediaJobAnalysis(db, { contactId: row.contactId, leadId: row.leadId, analysis });
      quoteRange = estimateJunkQuoteRangeFromVolume({
        volumeRange: analysis.mergedVolumeRange,
        confidence: analysis.confidence,
      });
    }
  }
  if (quoteRange) confidence = quoteRange.confidence;

  const textQuote = getTextQuoteReadiness(context);
  if (!quoteRange && textQuote.quoteRange) {
    quoteRange = textQuote.quoteRange;
    confidence = textQuote.quoteRange.confidence;
  }
  snapshot["textQuote"] = textQuote.snapshot;

  const [existingSession] = await db
    .select()
    .from(facebookSalesAutopilotSessions)
    .where(eq(facebookSalesAutopilotSessions.threadId, row.threadId))
    .limit(1);
  const offeredSlots = Array.isArray(existingSession?.offeredSlotsJson) ? existingSession.offeredSlotsJson : [];
  const confirmedSlot = detectClearBookingConfirmation(latestBody, offeredSlots);
  const rangeFromSession =
    typeof existingSession?.quoteLowCents === "number" && typeof existingSession.quoteHighCents === "number"
      ? { lowCents: existingSession.quoteLowCents, highCents: existingSession.quoteHighCents, confidence: quoteRange?.confidence ?? "medium" }
      : null;
  quoteRange = quoteRange ?? rangeFromSession;

  if (mode === "off" || closer.emergencyStop) {
    action = "no_op";
    reason = mode === "off" ? "sales_closer_off" : "sales_closer_emergency_stop";
  } else if (leadAutomation?.dnc || leadAutomation?.humanTakeover || leadAutomation?.paused) {
    stage = "needs_human_review";
    action = "human_review";
    humanReviewReason = leadAutomation.dnc ? "dnc" : leadAutomation.humanTakeover ? "human_takeover" : "automation_paused";
    reason = humanReviewReason;
  } else if (outsideMessengerWindow) {
    stage = "needs_human_review";
    action = closer.allowDmSmsFallback && (context.contact.phoneE164 || context.contact.phone) ? "handoff_sms" : "human_review";
    humanReviewReason = action === "human_review" ? "messenger_window_expired" : null;
    reason = "messenger_window_expired";
  } else if (hasBookedAppointment) {
    stage = "booked";
    action = "no_op";
    reason = "already_booked";
  } else if (riskReason) {
    stage = "needs_human_review";
    action = "human_review";
    humanReviewReason = riskReason;
    reason = riskReason;
  } else if (confirmedSlot && quoteRange && row.propertyId && row.contactId) {
    stage = "confirmed_booking";
    action = "book_job";
    reason = "customer_confirmed_offered_slot";
  } else if (confirmedSlot && !quoteRange) {
    stage = "needs_human_review";
    action = "human_review";
    humanReviewReason = "confirmation_without_quote";
    reason = "confirmation_without_quote";
  } else if ((customerAskedForTimes(latestBody) || (rangeFromSession && customerAcceptedQuoteOrScheduling(latestBody))) && quoteRange) {
    if (!hasUsableProperty(context)) {
      stage = "missing_info";
      action = "request_address";
      reason = "address_required_before_booking";
    } else {
      stage = "quote_ready";
      action = "offer_times";
      reason = "customer_asked_for_times_after_quote";
    }
  } else if (quoteRange && customerAskedForQuote(latestBody)) {
    stage = "quote_ready";
    action = "send_quote_range";
    reason = "quote_range_available";
  } else if (!quoteRange) {
    stage = "missing_info";
    action = textQuote.missingQuestion ? "request_quote_details" : "request_photos";
    reason = textQuote.missingQuestion ? "quote_details_required" : "photos_or_more_job_detail_required";
  }

  if (quoteRange && quoteRange.highCents > closer.maxAutoBookTotalCents && action === "book_job") {
    stage = "needs_human_review";
    action = "human_review";
    humanReviewReason = "quote_above_auto_book_limit";
    reason = "quote_above_auto_book_limit";
  }
  if (
    quoteRange &&
    quoteRange.highCents > closer.requirePhotosAboveCents &&
    mediaCount === 0 &&
    (action === "send_quote_range" || action === "offer_times" || action === "book_job")
  ) {
    stage = "missing_info";
    action = "request_photos";
    humanReviewReason = null;
    reason = "photos_required_above_threshold";
  }
  if (quoteRange && !confidenceMeetsPolicy(quoteRange.confidence, closer.minConfidence) && (action === "book_job" || action === "offer_times")) {
    stage = "needs_human_review";
    action = "human_review";
    humanReviewReason = "quote_confidence_too_low";
    reason = "quote_confidence_too_low";
  }

  const coachingOverride = applyFacebookCoachingGuards({
    body: latestBody,
    action,
    stage,
    mediaCount,
    coaching,
  });
  if (coachingOverride) {
    stage = coachingOverride.stage;
    action = coachingOverride.action;
    reason = coachingOverride.reason ?? reason;
    humanReviewReason = coachingOverride.humanReviewReason;
  }

  let slotsForSession = offeredSlots;
  if (action === "offer_times" && hasUsableProperty(context)) {
    slotsForSession = await fetchBookingAssist({ property: context.properties[0]!, autonomousConversationAt });
    if (slotsForSession.length === 0) {
      stage = "needs_human_review";
      action = "human_review";
      humanReviewReason = "availability_unavailable";
      reason = "availability_unavailable";
    }
  }

  const session = await ensureSession({
    db,
    row,
    stage,
    mode,
    lastDecision: action,
    reason,
    humanReviewReason,
    quoteLowCents: quoteRange?.lowCents ?? null,
    quoteHighCents: quoteRange?.highCents ?? null,
    offeredSlots: slotsForSession.length ? slotsForSession : null,
    lastMeaningfulInboundAt: latestInboundAt,
  });

  let executedAction: string | null = null;
  let result: Record<string, unknown> | null = null;
  let error: string | null = null;

  try {
    if (
      mode === "assist" &&
      (action === "request_quote_details" || action === "request_photos" || action === "request_address" || action === "send_quote_range" || action === "offer_times")
    ) {
      const body =
        action === "request_address"
          ? buildAddressAsk(coaching)
          : action === "request_quote_details" && textQuote.missingQuestion
            ? buildQuoteDetailsAsk(textQuote.missingQuestion, coaching)
          : action === "request_photos"
            ? buildPhotoAsk(coaching)
            : action === "send_quote_range" && quoteRange
              ? buildQuoteMessage(quoteRange, context.mediaAnalysis?.summary ?? null, coaching)
              : action === "offer_times"
                ? buildSlotsMessage(slotsForSession, coaching)
                : "";
      const messageId = body ? await createOutboundDmDraft({ db, row, body, mode, send: false, channel: row.channel }) : null;
      executedAction = messageId ? "draft_created" : "draft_reused_or_skipped";
      result = { messageId };
    } else if (mode === "auto") {
      if (action === "request_quote_details" || action === "request_photos" || action === "request_address" || action === "send_quote_range" || action === "offer_times") {
        const body =
          action === "request_address"
            ? buildAddressAsk(coaching)
            : action === "request_quote_details" && textQuote.missingQuestion
              ? buildQuoteDetailsAsk(textQuote.missingQuestion, coaching)
            : action === "request_photos"
              ? buildPhotoAsk(coaching)
              : action === "send_quote_range" && quoteRange
                ? buildQuoteMessage(quoteRange, context.mediaAnalysis?.summary ?? null, coaching)
                : action === "offer_times"
                  ? buildSlotsMessage(slotsForSession, coaching)
                  : "";
        const messageId = body ? await createOutboundDmDraft({ db, row, body, mode, send: true, channel: row.channel }) : null;
        executedAction = messageId ? "message_queued" : "message_reused_or_skipped";
        result = { messageId };
      } else if (action === "book_job" && confirmedSlot && quoteRange && row.contactId && row.propertyId) {
        const [newerInbound] = await db
          .select({ id: conversationMessages.id })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.threadId, row.threadId),
              eq(conversationMessages.direction, "inbound"),
              gt(conversationMessages.createdAt, row.createdAt),
            ),
          )
          .limit(1);
        if (newerInbound?.id) {
          executedAction = "stale_action_skipped";
          result = { newerInboundMessageId: newerInbound.id };
          await createHumanReviewTask(db, row.contactId, "newer_inbound_message");
        } else {
          const booked = await bookSlot({ contactId: row.contactId, propertyId: row.propertyId, slot: confirmedSlot, range: quoteRange, conversationAt: autonomousConversationAt });
          if (booked.ok) {
            executedAction = "appointment_booked";
            result = booked;
            await db.update(conversationThreads).set({ state: "booked", stateUpdatedAt: new Date(), updatedAt: new Date() }).where(eq(conversationThreads.id, row.threadId));
            await createOutboundDmDraft({
              db,
              row,
              body: `You're booked for ${confirmedSlot.label.replace(/^Option \d+:\s*/, "")}. We'll confirm the final price in person before loading.`,
              mode,
              send: true,
              channel: row.channel,
            });
          } else {
            executedAction = "booking_failed";
            error = booked.error;
            await createHumanReviewTask(db, row.contactId, booked.error);
          }
        }
      } else if (action === "human_review") {
        await createHumanReviewTask(db, row.contactId, humanReviewReason ?? reason);
        executedAction = "human_review_task_created";
      }
    } else if (mode === "shadow") {
      executedAction = "shadow_logged";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const actionId = await recordAction({
    db,
    sessionId: session?.id ?? null,
    row,
    stage,
    mode,
    proposedAction: action,
    executedAction,
    confidence,
    reason,
    humanReviewReason,
    inputSnapshot: snapshot,
    result,
    error,
  });

  await recordAuditEvent({
    actor: { type: "ai", label: "facebook-sales-autopilot" },
    action: "facebook.sales.autopilot.evaluated",
    entityType: "conversation_thread",
    entityId: row.threadId,
    meta: { actionId, proposedAction: action, executedAction, mode, stage, reason, humanReviewReason, error },
  });

  return { status: error ? "retry" : "processed", error };
}
