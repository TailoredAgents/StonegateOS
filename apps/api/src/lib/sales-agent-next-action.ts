import { eq } from "drizzle-orm";
import { getDb, salesAgentNextActions } from "@/db";
import type { OmniLeadContext } from "@/lib/omni-lead-context";
import type { SalesAgentMemoryRecord } from "@/lib/sales-agent-memory";
import { getDmFollowupStrategy } from "@/lib/dm-autopilot";
import type { SalesAutopilotPolicy } from "@/lib/policy";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor =
  Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
    ? Tx
    : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

export type SalesAgentNextActionRecord = {
  actionType: string;
  channel: string | null;
  status: string;
  priority: "low" | "normal" | "high" | "urgent";
  confidence: "low" | "medium" | "high";
  summary: string | null;
  reason: string | null;
  facts: string[];
  dueAt: string | null;
  source: string;
};

function parseIso(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pickLatestDate(values: Array<string | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    const parsed = parseIso(value);
    if (!parsed) continue;
    if (!latest || parsed.getTime() > latest.getTime()) {
      latest = parsed;
    }
  }
  return latest;
}

function dedupe(items: Array<string | null | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

function chooseChannel(context: OmniLeadContext): string | null {
  if (context.derived.channelPreference) return context.derived.channelPreference;
  if (context.contact.phoneE164 || context.contact.phone) return "sms";
  const recentInbound = context.channelSummary.find((row) => row.lastInboundAt);
  if (recentInbound?.channel) return recentInbound.channel;
  if (context.contact.email) return "email";
  return context.channelSummary[0]?.channel ?? null;
}

function hasRecentInboundWithoutReply(context: OmniLeadContext, now: Date): boolean {
  const latestInbound = pickLatestDate(context.channelSummary.map((row) => row.lastInboundAt));
  if (!latestInbound) return false;
  const latestOutbound = pickLatestDate(context.channelSummary.map((row) => row.lastOutboundAt));
  if (latestOutbound && latestOutbound.getTime() >= latestInbound.getTime()) return false;
  return now.getTime() - latestInbound.getTime() <= 4 * 60 * 60 * 1000;
}

function hasRecentOutbound(context: OmniLeadContext, now: Date, minutes: number): boolean {
  const latestOutbound = pickLatestDate(context.channelSummary.map((row) => row.lastOutboundAt));
  if (!latestOutbound) return false;
  return now.getTime() - latestOutbound.getTime() <= minutes * 60 * 1000;
}

function getDmEntryProfile(context: OmniLeadContext): {
  source: "facebook_ad_lead" | "organic_messenger" | "unknown";
  quoteDelayMinutes: number;
  missingInfoDelayMinutes: number;
  objectionDelayMinutes: number;
  handoffMultiplier: number;
} {
  const source = context.derived.dmEntrySource ?? "unknown";
  if (source === "organic_messenger") {
    return {
      source,
      quoteDelayMinutes: 360,
      missingInfoDelayMinutes: 180,
      objectionDelayMinutes: 720,
      handoffMultiplier: 1.75,
    };
  }
  return {
    source,
    quoteDelayMinutes: 180,
    missingInfoDelayMinutes: 90,
    objectionDelayMinutes: 360,
    handoffMultiplier: 1,
  };
}

function isRecentMissedInboundCall(context: OmniLeadContext, now: Date): boolean {
  const latestCall = context.latestCall;
  if (!latestCall) return false;
  const createdAt = parseIso(latestCall.createdAt);
  if (!createdAt) return false;
  const callStatus = typeof latestCall.callStatus === "string" ? latestCall.callStatus.toLowerCase() : "";
  return (
    latestCall.direction === "inbound" &&
    now.getTime() - createdAt.getTime() <= 2 * 60 * 60 * 1000 &&
    callStatus.length > 0 &&
    callStatus !== "completed"
  );
}

export function buildSalesAgentNextAction(input: {
  context: OmniLeadContext;
  memory: SalesAgentMemoryRecord;
  autopilotPolicy?: Pick<
    SalesAutopilotPolicy,
    | "dmSmsFallbackAfterMinutes"
    | "dmMinSilenceBeforeSmsMinutes"
    | "dmMissingInfoFollowupDelayMinutes"
    | "dmQuoteFollowupDelayMinutes"
    | "dmObjectionFollowupDelayMinutes"
  >;
  now?: Date;
}): SalesAgentNextActionRecord {
  const { context, memory } = input;
  const now = input.now ?? new Date();
  const autopilotPolicy = input.autopilotPolicy ?? {
    dmSmsFallbackAfterMinutes: 120,
    dmMinSilenceBeforeSmsMinutes: 45,
    dmMissingInfoFollowupDelayMinutes: 90,
    dmQuoteFollowupDelayMinutes: 180,
    dmObjectionFollowupDelayMinutes: 360,
  };
  const preferredChannel = chooseChannel(context);
  const pendingHumanTakeover = context.automation.some((row) => row.humanTakeover);
  const pendingDnc = context.automation.some((row) => row.dnc);
  const paused = context.automation.some((row) => row.paused);
  const nextAutomationFollowup = pickLatestDate(context.automation.map((row) => row.nextFollowupAt));
  const nextTaskDue = pickLatestDate(context.openTasks.map((row) => row.dueAt));
  const latestLeadCreatedAt = parseIso(context.latestLead?.createdAt ?? null);
  const hasFormalQuote = Boolean(context.formalQuote?.id);
  const hasInstantQuote = Boolean(context.instantQuote?.id);
  const dmEntryProfile = getDmEntryProfile(context);
  const hasUpcomingAppointment =
    Boolean(context.nextAppointment?.id) &&
    context.nextAppointment?.status !== "cancelled" &&
    context.nextAppointment?.status !== "completed";

  const latestChannelTouchAt = (channel: string | null | undefined): Date | null => {
    if (!channel) return null;
    return pickLatestDate(
      context.channelSummary
        .filter((row) => row.channel === channel)
        .map((row) => row.lastMessageAt),
    );
  };

  const resolveDeferredDueAt = (input: {
    channel: string | null | undefined;
    delayMinutes: number;
    baselines?: Array<Date | null | undefined>;
  }): string => {
    const channelTouchAt = latestChannelTouchAt(input.channel);
    const delayedAt = new Date((channelTouchAt ?? now).getTime() + input.delayMinutes * 60 * 1000);
    const floor = delayedAt.getTime();
    const candidateMs = [floor, ...((input.baselines ?? []).map((value) => value?.getTime() ?? Number.NaN))]
      .filter((value) => Number.isFinite(value));
    return new Date(Math.max(...candidateMs)).toISOString();
  };

  if (pendingDnc) {
    return {
      actionType: "do_not_contact",
      channel: null,
      status: "blocked",
      priority: "low",
      confidence: "high",
      summary: "Do not contact this lead until a human changes their status.",
      reason: "Automation state is marked DNC.",
      facts: ["DNC is enabled on at least one automation channel."],
      dueAt: null,
      source: "rules_v1",
    };
  }

  if (pendingHumanTakeover || paused) {
    return {
      actionType: "human_follow_up",
      channel: preferredChannel,
      status: "blocked",
      priority: "high",
      confidence: "high",
      summary: "A human should handle the next touch before automation resumes.",
      reason: pendingHumanTakeover ? "Human takeover is active." : "Automation is currently paused.",
      facts: dedupe([
        pendingHumanTakeover ? "Human takeover is active." : null,
        paused ? "Automation is paused." : null,
        memory.lastHumanSummary,
      ]),
      dueAt: nextAutomationFollowup?.toISOString() ?? null,
      source: "rules_v1",
    };
  }

  if (hasUpcomingAppointment) {
    return {
      actionType: "wait_for_appointment",
      channel: preferredChannel,
      status: "scheduled",
      priority: "normal",
      confidence: "high",
      summary: "No proactive chase needed right now. Keep the lead warm and be ready for the appointment.",
      reason: `A ${context.nextAppointment?.type ?? "scheduled"} appointment is already on the books.`,
      facts: dedupe([
        context.nextAppointment?.startAt ? `Appointment at ${context.nextAppointment.startAt}` : null,
        memory.lastPromisedNextStep,
      ]),
      dueAt: context.nextAppointment?.startAt ?? null,
      source: "rules_v1",
    };
  }

  if (hasRecentInboundWithoutReply(context, now)) {
    return {
      actionType: "reply_now",
      channel: preferredChannel,
      status: "open",
      priority: "urgent",
      confidence: "high",
      summary: "Reply now while the lead is still active.",
      reason: "There is a recent inbound message that has not been answered yet.",
      facts: dedupe([
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
        memory.lastPromisedNextStep,
        memory.pricingContext,
      ]),
      dueAt: now.toISOString(),
      source: "rules_v1",
    };
  }

  if (
    isRecentMissedInboundCall(context, now) &&
    (context.contact.phoneE164 || context.contact.phone) &&
    !hasRecentOutbound(context, now, 20)
  ) {
    return {
      actionType: "missed_call_recovery",
      channel: "sms",
      status: "open",
      priority: "high",
      confidence: "high",
      summary: "Send a quick missed-call recovery text and move the lead back into conversation.",
      reason: "There was a recent inbound call that did not complete, and no recent outbound recovery touch exists yet.",
      facts: dedupe([
        context.latestCall?.callStatus ? `Latest call status: ${context.latestCall.callStatus}` : null,
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
        context.derived.knownZip ? `ZIP: ${context.derived.knownZip}` : null,
      ]),
      dueAt: now.toISOString(),
      source: "rules_v1",
    };
  }

  if (
    latestLeadCreatedAt &&
    now.getTime() - latestLeadCreatedAt.getTime() <= 30 * 60 * 1000 &&
    !hasRecentOutbound(context, now, 20)
  ) {
    return {
      actionType: "call_now",
      channel: context.contact.phoneE164 || context.contact.phone ? "sms" : preferredChannel,
      status: "open",
      priority: "urgent",
      confidence: "high",
      summary: "Fast follow-up window is open. Call this lead now.",
      reason: "The lead is fresh and there has not been a recent outbound touch.",
      facts: dedupe([
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
        context.derived.knownZip ? `ZIP: ${context.derived.knownZip}` : null,
        memory.pricingContext,
      ]),
      dueAt: now.toISOString(),
      source: "rules_v1",
    };
  }

  const dmFollowupStrategy = getDmFollowupStrategy({
    context,
    now,
    autopilotPolicy: {
      ...autopilotPolicy,
      dmSmsFallbackAfterMinutes: Math.round(autopilotPolicy.dmSmsFallbackAfterMinutes * dmEntryProfile.handoffMultiplier),
      dmMinSilenceBeforeSmsMinutes: Math.round(
        autopilotPolicy.dmMinSilenceBeforeSmsMinutes * dmEntryProfile.handoffMultiplier,
      ),
    },
  });
  if (dmFollowupStrategy.recommendation === "handoff_sms") {
    return {
      actionType: "dm_sms_handoff",
      channel: "sms",
      status: "open",
      priority: "high",
      confidence: "medium",
      summary: "Move this lead from Messenger to text and keep the conversation going there.",
      reason: dmFollowupStrategy.summary,
      facts: dedupe([
        ...dmFollowupStrategy.facts,
        context.derived.dmEntrySource ? `Messenger entry source: ${context.derived.dmEntrySource.replace(/_/g, " ")}` : null,
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
      ]),
      dueAt: now.toISOString(),
      source: "rules_v1",
    };
  }

  if ((hasInstantQuote || hasFormalQuote) && context.derived.objections.includes("price")) {
    return {
      actionType: "handle_price_objection",
      channel: preferredChannel,
      status: "open",
      priority: "high",
      confidence: "medium",
      summary: "Follow up with a short price-objection save attempt.",
      reason: "The contact has quote context and has shown price resistance.",
      facts: dedupe([
        memory.pricingContext,
        "Known objection: price",
        context.derived.dmEntrySource ? `Messenger entry source: ${context.derived.dmEntrySource.replace(/_/g, " ")}` : null,
        memory.lastPromisedNextStep,
      ]),
      dueAt:
        preferredChannel === "dm"
          ? resolveDeferredDueAt({
              channel: "dm",
              delayMinutes: dmEntryProfile.objectionDelayMinutes,
              baselines: [nextTaskDue],
            })
          : nextTaskDue?.toISOString() ?? now.toISOString(),
      source: "rules_v1",
    };
  }

  if (memory.missingFields.length > 0 && !hasRecentOutbound(context, now, 120)) {
    return {
      actionType: "collect_missing_info",
      channel: preferredChannel,
      status: "open",
      priority: "high",
      confidence: "medium",
      summary: "Ask for the single missing detail that unlocks the next step.",
      reason: "The lead is still missing key information for a confident quote or booking.",
      facts: dedupe([
        `Missing: ${memory.missingFields.join(", ")}`,
        context.derived.dmEntrySource ? `Messenger entry source: ${context.derived.dmEntrySource.replace(/_/g, " ")}` : null,
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
      ]),
      dueAt:
        preferredChannel === "dm"
          ? resolveDeferredDueAt({
              channel: "dm",
              delayMinutes: dmEntryProfile.missingInfoDelayMinutes,
              baselines: [nextAutomationFollowup],
            })
          : nextAutomationFollowup?.toISOString() ?? now.toISOString(),
      source: "rules_v1",
    };
  }

  if ((hasInstantQuote || hasFormalQuote) && context.derived.bookingReadiness !== "low") {
    return {
      actionType: "follow_up_quote",
      channel: preferredChannel,
      status: "open",
      priority: context.derived.bookingReadiness === "high" ? "high" : "normal",
      confidence: "medium",
      summary: "Follow up on the quote and try to move the lead toward booking.",
      reason: "A quote exists, but no appointment is scheduled yet.",
      facts: dedupe([
        memory.pricingContext,
        memory.lastPromisedNextStep,
        context.derived.dmEntrySource ? `Messenger entry source: ${context.derived.dmEntrySource.replace(/_/g, " ")}` : null,
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
      ]),
      dueAt:
        preferredChannel === "dm"
          ? resolveDeferredDueAt({
              channel: "dm",
              delayMinutes: dmEntryProfile.quoteDelayMinutes,
              baselines: [nextTaskDue, nextAutomationFollowup],
            })
          : nextTaskDue?.toISOString() ?? nextAutomationFollowup?.toISOString() ?? now.toISOString(),
      source: "rules_v1",
    };
  }

  return {
    actionType: "monitor_and_wait",
    channel: preferredChannel,
    status: "open",
    priority: "low",
    confidence: "low",
    summary: "No urgent action is needed right now. Monitor for the next customer signal.",
    reason: "There is no stronger live trigger than the current queue, schedule, or automation state.",
    facts: dedupe([
      memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
      memory.lastPromisedNextStep,
    ]),
    dueAt: nextAutomationFollowup?.toISOString() ?? nextTaskDue?.toISOString() ?? null,
    source: "rules_v1",
  };
}

export async function upsertSalesAgentNextAction(
  db: DbExecutor,
  input: { contactId: string; leadId?: string | null; action: SalesAgentNextActionRecord; now?: Date },
) {
  const now = input.now ?? new Date();
  const dueAt = parseIso(input.action.dueAt);
  const values = {
    contactId: input.contactId,
    leadId: input.leadId ?? null,
    actionType: input.action.actionType,
    channel: input.action.channel,
    status: input.action.status,
    priority: input.action.priority,
    confidence: input.action.confidence,
    summary: input.action.summary,
    reason: input.action.reason,
    facts: input.action.facts,
    dueAt,
    source: input.action.source,
    createdAt: now,
    updatedAt: now,
  };

  const [row] = await db
    .insert(salesAgentNextActions)
    .values(values)
    .onConflictDoUpdate({
      target: salesAgentNextActions.contactId,
      set: {
        leadId: values.leadId,
        actionType: values.actionType,
        channel: values.channel,
        status: values.status,
        priority: values.priority,
        confidence: values.confidence,
        summary: values.summary,
        reason: values.reason,
        facts: values.facts,
        dueAt: values.dueAt,
        source: values.source,
        updatedAt: now,
      },
    })
    .returning();

  return row ?? null;
}

export async function getSalesAgentNextAction(db: DbExecutor, contactId: string) {
  const [row] = await db
    .select()
    .from(salesAgentNextActions)
    .where(eq(salesAgentNextActions.contactId, contactId))
    .limit(1);
  return row ?? null;
}
