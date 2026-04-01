import { and, eq, inArray } from "drizzle-orm";
import { conversationMessages, getDb } from "@/db";
import type { OmniLeadContext } from "@/lib/omni-lead-context";
import type { SalesAutopilotPolicy } from "@/lib/policy";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor =
  Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
    ? Tx
    : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

export function isMessengerLeadCardBody(body: string): boolean {
  const text = body.toLowerCase();
  const markers = ["phone number:", "email:", "zip code:", "first name:", "when do you want it gone?:"];
  const hitCount = markers.reduce((count, marker) => (text.includes(marker) ? count + 1 : count), 0);
  return hitCount >= 3;
}

function isMeaningfulInboundDmBody(body: string | null | undefined): boolean {
  const trimmed = typeof body === "string" ? body.trim() : "";
  return trimmed.length > 0 && !isMessengerLeadCardBody(trimmed);
}

function parseIso(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function latestMessageTimestamp(message: OmniLeadContext["recentMessages"][number] | null): Date | null {
  if (!message) return null;
  return parseIso(message.receivedAt) ?? parseIso(message.sentAt) ?? parseIso(message.createdAt);
}

function latestRecentMessage(
  context: OmniLeadContext,
  predicate: (message: OmniLeadContext["recentMessages"][number]) => boolean,
): OmniLeadContext["recentMessages"][number] | null {
  for (let index = context.recentMessages.length - 1; index >= 0; index -= 1) {
    const message = context.recentMessages[index];
    if (message && predicate(message)) return message;
  }
  return null;
}

function hasQualifiedDmToSmsIntent(context: OmniLeadContext): boolean {
  const intent = context.derived.customerIntent ?? "";
  if (
    intent === "quote_intent" ||
    intent === "booking_intent" ||
    intent === "booked_or_scheduling" ||
    intent === "junk_removal_quote" ||
    intent === "demolition_quote" ||
    intent === "brush_quote"
  ) {
    return true;
  }
  if (context.derived.bookingReadiness === "high" || context.derived.bookingReadiness === "medium") return true;
  return Boolean(context.derived.pricingContext);
}

export type DmFollowupStrategy = {
  recommendation: "stay_dm" | "handoff_sms";
  reasonCode:
    | "not_messenger_led"
    | "no_phone"
    | "waiting_for_reply"
    | "no_meaningful_dm_context"
    | "dm_still_active"
    | "not_qualified_for_sms_handoff"
    | "recent_sms_touch"
    | "handoff_ready";
  summary: string;
  facts: string[];
  meaningfulInboundCount: number;
  latestMeaningfulInboundDmAt: Date | null;
  latestOutboundDmAt: Date | null;
  latestOutboundSmsAt: Date | null;
};

export function getDmFollowupStrategy(input: {
  context: OmniLeadContext;
  now: Date;
  autopilotPolicy: Pick<SalesAutopilotPolicy, "dmSmsFallbackAfterMinutes" | "dmMinSilenceBeforeSmsMinutes">;
}): DmFollowupStrategy {
  const { context, now, autopilotPolicy } = input;
  const latestMeaningfulInboundDm = latestRecentMessage(
    context,
    (message) =>
      message.channel === "dm" &&
      message.direction === "inbound" &&
      typeof message.body === "string" &&
      isMeaningfulInboundDmBody(message.body),
  );
  const latestOutboundDm = latestRecentMessage(
    context,
    (message) => message.channel === "dm" && message.direction === "outbound" && typeof message.sentAt === "string",
  );
  const latestOutboundSms = latestRecentMessage(
    context,
    (message) => message.channel === "sms" && message.direction === "outbound" && typeof message.sentAt === "string",
  );

  const latestMeaningfulInboundDmAt = latestMessageTimestamp(latestMeaningfulInboundDm);
  const latestOutboundDmAt = latestMessageTimestamp(latestOutboundDm);
  const latestOutboundSmsAt = latestMessageTimestamp(latestOutboundSms);
  const meaningfulInboundCount = context.recentMessages.filter(
    (message) => message.channel === "dm" && message.direction === "inbound" && isMeaningfulInboundDmBody(message.body),
  ).length;
  const silenceMs = autopilotPolicy.dmMinSilenceBeforeSmsMinutes * 60 * 1000;
  const fallbackMs = autopilotPolicy.dmSmsFallbackAfterMinutes * 60 * 1000;
  const hasPhone = Boolean(context.contact.phoneE164 || context.contact.phone);
  const messengerLed =
    context.derived.channelPreference === "dm" ||
    context.channelSummary.some((row) => row.channel === "dm" && typeof row.lastMessageAt === "string");

  const buildResult = (
    recommendation: DmFollowupStrategy["recommendation"],
    reasonCode: DmFollowupStrategy["reasonCode"],
    summary: string,
    extraFacts: Array<string | null | undefined> = [],
  ): DmFollowupStrategy => ({
    recommendation,
    reasonCode,
    summary,
    facts: extraFacts.filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0),
    meaningfulInboundCount,
    latestMeaningfulInboundDmAt,
    latestOutboundDmAt,
    latestOutboundSmsAt,
  });

  if (!messengerLed) {
    return buildResult("stay_dm", "not_messenger_led", "This lead is not currently Messenger-led.");
  }

  if (!hasPhone) {
    return buildResult(
      "stay_dm",
      "no_phone",
      "Stay in Messenger until the lead shares a phone number.",
      ["No contact phone is currently on file."],
    );
  }

  if (!latestMeaningfulInboundDmAt || !latestOutboundDmAt) {
    return buildResult(
      "stay_dm",
      "no_meaningful_dm_context",
      "Stay in Messenger until there is a real DM exchange to pick up from.",
      [
        meaningfulInboundCount > 0 ? `${meaningfulInboundCount} meaningful inbound DM message(s) found.` : null,
        latestMeaningfulInboundDmAt ? `Last meaningful Messenger inbound: ${latestMeaningfulInboundDmAt.toISOString()}` : null,
        latestOutboundDmAt ? `Last Messenger reply from us: ${latestOutboundDmAt.toISOString()}` : null,
      ],
    );
  }

  if (latestOutboundDmAt.getTime() < latestMeaningfulInboundDmAt.getTime()) {
    return buildResult(
      "stay_dm",
      "waiting_for_reply",
      "Stay in Messenger because the latest meaningful DM still needs an answer there.",
      [`Last meaningful Messenger inbound: ${latestMeaningfulInboundDmAt.toISOString()}`],
    );
  }

  if (now.getTime() - latestMeaningfulInboundDmAt.getTime() < silenceMs) {
    return buildResult(
      "stay_dm",
      "dm_still_active",
      "Stay in Messenger because the conversation is still active there.",
      [`Last meaningful Messenger inbound: ${latestMeaningfulInboundDmAt.toISOString()}`],
    );
  }

  const hasQualifiedIntent = hasQualifiedDmToSmsIntent(context);
  if (!hasQualifiedIntent) {
    return buildResult(
      "stay_dm",
      "not_qualified_for_sms_handoff",
      "Stay in Messenger until the lead shows clearer quote or booking intent.",
      [
        context.derived.customerIntent ? `Current intent: ${context.derived.customerIntent}` : null,
        context.derived.bookingReadiness ? `Booking readiness: ${context.derived.bookingReadiness}` : null,
      ],
    );
  }

  if (latestOutboundSmsAt && now.getTime() - latestOutboundSmsAt.getTime() < silenceMs) {
    return buildResult(
      "stay_dm",
      "recent_sms_touch",
      "Stay put because there was already a recent SMS touch for this lead.",
      [`Last SMS touch: ${latestOutboundSmsAt.toISOString()}`],
    );
  }

  if (now.getTime() - latestOutboundDmAt.getTime() < fallbackMs) {
    return buildResult(
      "stay_dm",
      "dm_still_active",
      "Stay in Messenger a bit longer before falling back to SMS.",
      [`Last Messenger reply from us: ${latestOutboundDmAt.toISOString()}`],
    );
  }

  return buildResult(
    "handoff_sms",
    "handoff_ready",
    "Messenger has cooled off and this lead is qualified enough to continue by text.",
    [
      `Last meaningful Messenger inbound: ${latestMeaningfulInboundDmAt.toISOString()}`,
      `Last Messenger reply from us: ${latestOutboundDmAt.toISOString()}`,
      latestOutboundSmsAt ? `Last SMS touch: ${latestOutboundSmsAt.toISOString()}` : "No recent SMS follow-up exists.",
      context.derived.customerIntent ? `Intent: ${context.derived.customerIntent}` : null,
      `Booking readiness: ${context.derived.bookingReadiness}`,
    ],
  );
}

export async function getDmLiveAutopilotStates(
  db: DbExecutor,
  threadIds: string[],
): Promise<Map<string, { ready: boolean; meaningfulInboundCount: number }>> {
  const uniqueThreadIds = [...new Set(threadIds.filter((value) => typeof value === "string" && value.trim().length > 0))];
  const result = new Map<string, { ready: boolean; meaningfulInboundCount: number }>();
  if (uniqueThreadIds.length === 0) return result;

  const rows = await db
    .select({
      threadId: conversationMessages.threadId,
      body: conversationMessages.body,
    })
    .from(conversationMessages)
    .where(
      and(
        inArray(conversationMessages.threadId, uniqueThreadIds),
        eq(conversationMessages.channel, "dm"),
        eq(conversationMessages.direction, "inbound"),
      ),
    );

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isMeaningfulInboundDmBody(row.body)) continue;
    counts.set(row.threadId, (counts.get(row.threadId) ?? 0) + 1);
  }

  for (const threadId of uniqueThreadIds) {
    const meaningfulInboundCount = counts.get(threadId) ?? 0;
    result.set(threadId, {
      ready: meaningfulInboundCount >= 2,
      meaningfulInboundCount,
    });
  }

  return result;
}

export async function getDmLiveAutopilotState(
  db: DbExecutor,
  threadId: string,
): Promise<{ ready: boolean; meaningfulInboundCount: number }> {
  const states = await getDmLiveAutopilotStates(db, [threadId]);
  return states.get(threadId) ?? { ready: false, meaningfulInboundCount: 0 };
}
