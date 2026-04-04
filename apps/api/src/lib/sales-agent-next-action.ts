import { eq } from "drizzle-orm";
import { getDb, salesAgentNextActions } from "@/db";
import type { AppointmentPreservationOutcomeSummary } from "@/lib/appointment-preservation-outcomes";
import type { AppointmentReminderOutcomeSummary } from "@/lib/appointment-reminder-outcomes";
import {
  isDmSmsHandoffWorthwhile,
  isDmSmsTransitionHealthy,
  shouldKeepDmSmsHandoffLight,
  type ChannelHandoffOutcomeSummary,
} from "@/lib/channel-handoff-outcomes";
import {
  getFirstResponseLearningScope,
  getPreferredFirstResponseChannel,
  shouldAvoidHardBookingAskInFirstResponse,
  shouldKeepFirstResponseShort,
  shouldKeepFirstResponseSingleAsk,
  shouldOpenFirstResponseWithPhotoAsk,
  shouldPreferFastFirstResponse,
  type FirstResponseOutcomeSummary,
} from "@/lib/first-response-outcomes";
import {
  getPreferredMissingInfoChannel,
  shouldKeepSingleMissingInfoAsk,
  shouldLeanIntoMissingInfoRequests,
  type MissingInfoOutcomeSummary,
} from "@/lib/missing-info-outcomes";
import type { OmniLeadContext } from "@/lib/omni-lead-context";
import {
  getObjectionSaveLearningScope,
  getPreferredObjectionSaveChannel,
  shouldUseSofterObjectionSave,
  type ObjectionSaveOutcomeSummary,
} from "@/lib/objection-save-outcomes";
import type { MediaQuoteOutcomeSummary } from "@/lib/media-quote-outcomes";
import {
  getPreferredReactivationChannel,
  isReactivationWorthwhile,
  shouldUseSofterReactivation,
  type ReactivationOutcomeSummary,
} from "@/lib/reactivation-outcomes";
import {
  doesQuoteAccuracyTrendAboveRange,
  shouldKeepQuoteEstimateProvisional,
  shouldTightenLowConfidenceQuoteEstimates,
  type QuoteAccuracyOutcomeSummary,
} from "@/lib/quote-accuracy-outcomes";
import {
  doesQuoteUrgencyDecayFast,
  getLearnedQuoteHotWindow,
  isSameDayQuoteWindowStillStrong,
  type QuoteHotWindowOutcomeSummary,
} from "@/lib/quote-hot-window-outcomes";
import {
  getPreferredQuoteCloseChannel,
  shouldUseSofterQuoteClose,
  type QuoteCloseOutcomeSummary,
} from "@/lib/quote-close-outcomes";
import {
  getQuoteFollowupLearningScope,
  getPreferredQuoteFollowupChannel,
  isSecondQuoteFollowupStillWorthwhile,
  isThirdPlusQuoteFollowupWorthwhile,
  shouldAvoidHardQuoteBookingAsk,
  shouldKeepQuoteFollowupDepthLight,
  shouldKeepQuoteFollowupShort,
  shouldKeepQuoteFollowupSingleAsk,
  shouldOpenQuoteFollowupWithPhotoAsk,
  shouldPreferFastQuoteFollowup,
  type QuoteFollowupOutcomeSummary,
} from "@/lib/quote-followup-outcomes";
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

function formatFactLabel(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) return "Unknown";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractPreferredMissingAngle(memory: SalesAgentMemoryRecord): string | null {
  return (
    memory.missingFields.find((field) => typeof field === "string" && /photo angle|missing view|video angle/i.test(field)) ??
    null
  );
}

function chooseChannel(context: OmniLeadContext): string | null {
  if (context.derived.channelPreference) return context.derived.channelPreference;
  if (context.contact.phoneE164 || context.contact.phone) return "sms";
  const recentInbound = context.channelSummary.find((row) => row.lastInboundAt);
  if (recentInbound?.channel) return recentInbound.channel;
  if (context.contact.email) return "email";
  return context.channelSummary[0]?.channel ?? null;
}

function hasChannelAvailable(context: OmniLeadContext, channel: string | null | undefined): boolean {
  if (!channel) return false;
  if (channel === "sms") return Boolean(context.contact.phoneE164 || context.contact.phone);
  if (channel === "email") return Boolean(context.contact.email);
  return context.channelSummary.some((row) => row.channel === channel);
}

function chooseQuoteFollowupChannel(
  context: OmniLeadContext,
  fallbackChannel: string | null,
  summary: QuoteFollowupOutcomeSummary | null | undefined,
  scope?: Parameters<typeof getPreferredQuoteFollowupChannel>[1],
): string | null {
  const learned = getPreferredQuoteFollowupChannel(summary, scope);
  if (learned === "sms" && hasChannelAvailable(context, "sms")) return "sms";
  if (learned === "dm" && hasChannelAvailable(context, "dm")) return "dm";
  return fallbackChannel;
}

function chooseMissingInfoChannel(
  context: OmniLeadContext,
  fallbackChannel: string | null,
  summary: MissingInfoOutcomeSummary | null | undefined,
): string | null {
  const learned = getPreferredMissingInfoChannel(summary);
  if (learned === "sms" && hasChannelAvailable(context, "sms")) return "sms";
  if (learned === "dm" && hasChannelAvailable(context, "dm")) return "dm";
  return fallbackChannel;
}

function chooseReactivationChannel(
  context: OmniLeadContext,
  fallbackChannel: string | null,
  summary: ReactivationOutcomeSummary | null | undefined,
): string | null {
  const learned = getPreferredReactivationChannel(summary);
  if (learned === "sms" && hasChannelAvailable(context, "sms")) return "sms";
  if (learned === "dm" && hasChannelAvailable(context, "dm")) return "dm";
  return fallbackChannel;
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

function getLatestQuoteCreatedAt(context: OmniLeadContext): Date | null {
  return pickLatestDate([context.instantQuote?.createdAt ?? null, context.formalQuote?.createdAt ?? null]);
}

function buildAppointmentCheckinDueAt(appointmentStart: Date, now: Date): string {
  const target = new Date(appointmentStart.getTime() - 6 * 60 * 60 * 1000);
  return (target.getTime() <= now.getTime() ? now : target).toISOString();
}

function classifyAppointmentSupportIntent(
  context: OmniLeadContext,
): "reschedule" | "logistics" | "confirmation" | null {
  const latestInbound = [...context.recentMessages]
    .reverse()
    .find((message) => message.direction === "inbound");
  if (!latestInbound?.body) return null;
  const text = latestInbound.body.toLowerCase();

  if (
    /\b(reschedule|move it|move this|push it|push this|push back|another time|different time|later today|later this|tomorrow instead|need to change|need to move|need to push|can't make it|cannot make it|won't make it|running late|late today)\b/.test(
      text,
    )
  ) {
    return "reschedule";
  }

  if (
    /\b(what time|what's the time|still coming|still on|still good|confirm|confirmed|see you then|gate code|parking|address|eta|on the way|on your way)\b/.test(
      text,
    )
  ) {
    return "logistics";
  }

  if (/\b(okay|sounds good|works for me|perfect|got it|see you|thank you)\b/.test(text)) {
    return "confirmation";
  }

  return null;
}

function buildExceptionRouting(context: OmniLeadContext): {
  summary: string;
  reason: string;
  facts: string[];
} | null {
  const signals = Array.isArray(context.derived.exceptionSignals) ? context.derived.exceptionSignals : [];
  if (signals.length === 0) return null;

  if (signals.includes("hazardous_scope")) {
    return {
      summary: "Human review needed before replying because the scope may be hazardous or unsupported.",
      reason: "Hazardous or unsupported scope signals were found in the recent lead context.",
      facts: dedupe([
        "Possible hazardous or unsupported material is mentioned in the lead context.",
        context.mediaAnalysis?.riskFlags.length ? `Media risk flags: ${context.mediaAnalysis.riskFlags.join(", ")}.` : null,
        context.pipeline.notes,
      ]),
    };
  }

  if (signals.includes("high_risk_demo_scope")) {
    return {
      summary: "Human review needed before replying because this demolition scope looks high risk.",
      reason: "The lead appears to involve a larger or structural demolition job that should not be auto-handled.",
      facts: dedupe([
        "High-risk demolition wording was found in the recent lead context.",
        context.latestLead?.notes,
        context.instantQuote?.notes,
      ]),
    };
  }

  if (signals.includes("out_of_area")) {
    return {
      summary: "Human review needed before replying because this lead looks outside the current service area.",
      reason: "The known ZIP does not match the current service-area policy, so the next touch should be reviewed by a human.",
      facts: dedupe([
        context.derived.knownZip ? `Known ZIP: ${context.derived.knownZip}.` : null,
        context.contact.source ? `Lead source: ${formatFactLabel(context.contact.source)}.` : null,
        context.latestLead?.notes,
        context.pipeline.notes,
      ]),
    };
  }

  if (signals.includes("unsupported_service_scope")) {
    return {
      summary: "Human review needed before replying because the requested work may fall outside the current supported services.",
      reason: "Recent lead context suggests service requests that do not fit the normal junk, brush, or supported demo flow.",
      facts: dedupe([
        context.latestLead?.servicesRequested?.length
          ? `Requested services: ${context.latestLead.servicesRequested.join(", ")}.`
          : null,
        context.instantQuote?.jobTypes.length ? `Quote job types: ${context.instantQuote.jobTypes.join(", ")}.` : null,
        context.latestLead?.notes,
        context.instantQuote?.notes,
      ]),
    };
  }

  if (signals.includes("schedule_urgency_contradiction")) {
    return {
      summary: "Human review needed before replying because the requested timing conflicts with the current schedule assumptions.",
      reason: "The lead is asking for a faster turnaround than the current quote or appointment context supports cleanly.",
      facts: dedupe([
        context.instantQuote?.timeframe
          ? `Requested timeframe on the quote: ${context.instantQuote.timeframe.replace(/_/g, " ")}.`
          : null,
        context.nextAppointment?.startAt
          ? `Current scheduled appointment: ${new Date(context.nextAppointment.startAt).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            })}.`
          : "No appointment is currently scheduled.",
        context.latestLead?.notes,
        context.pipeline.notes,
      ]),
    };
  }

  if (signals.includes("operational_scope_contradiction")) {
    return {
      summary: "Human review needed before replying because the access or scope complexity looks heavier than the current quote assumptions.",
      reason: "The lead context suggests multiple areas, difficult access, or heavy-item handling that should be reviewed before the next pricing or scheduling touch.",
      facts: dedupe([
        context.instantQuote?.perceivedSize
          ? `Customer-selected size: ${context.instantQuote.perceivedSize.replace(/_/g, " ")}.`
          : null,
        context.mediaAnalysis?.visibleVolumeRange
          ? `Visible media estimate: ${context.mediaAnalysis.visibleVolumeRange.replace(/_/g, " ")}.`
          : null,
        context.mediaAnalysis?.riskFlags.length
          ? `Media risk flags: ${context.mediaAnalysis.riskFlags.join(", ")}.`
          : null,
        context.latestLead?.notes,
        context.instantQuote?.notes,
      ]),
    };
  }

  if (signals.includes("scope_pricing_contradiction")) {
    return {
      summary: "Human review needed before replying because the photos, stated scope, and quote signals disagree too much.",
      reason: "The current media estimate and stated scope conflict strongly enough that the next pricing touch should be reviewed by a human.",
      facts: dedupe([
        context.mediaAnalysis?.visibleVolumeRange
          ? `Visible media estimate: ${context.mediaAnalysis.visibleVolumeRange.replace(/_/g, " ")}.`
          : null,
        context.mediaAnalysis?.mergedVolumeRange
          ? `Merged estimate after stated scope: ${context.mediaAnalysis.mergedVolumeRange.replace(/_/g, " ")}.`
          : null,
        context.mediaAnalysis?.riskFlags.length
          ? `Media risk flags: ${context.mediaAnalysis.riskFlags.join(", ")}.`
          : null,
        context.instantQuote?.perceivedSize
          ? `Customer-selected size: ${context.instantQuote.perceivedSize.replace(/_/g, " ")}.`
          : null,
      ]),
    };
  }

  if (signals.includes("frustrated_or_dispute")) {
    return {
      summary: "Human review needed before the next touch because the lead appears frustrated or in dispute.",
      reason: "Recent language suggests frustration, complaint risk, or a dispute.",
      facts: dedupe([
        "Frustration or dispute wording was found in recent inbound context.",
        context.derived.lastHumanSummary,
        context.pipeline.notes,
      ]),
    };
  }

  return null;
}

export function buildSalesAgentNextAction(input: {
  context: OmniLeadContext;
  memory: SalesAgentMemoryRecord;
  appointmentPreservationOutcomeSummary?: AppointmentPreservationOutcomeSummary | null;
  appointmentReminderOutcomeSummary?: AppointmentReminderOutcomeSummary | null;
  channelHandoffOutcomeSummary?: ChannelHandoffOutcomeSummary | null;
  firstResponseOutcomeSummary?: FirstResponseOutcomeSummary | null;
  missingInfoOutcomeSummary?: MissingInfoOutcomeSummary | null;
  objectionSaveOutcomeSummary?: ObjectionSaveOutcomeSummary | null;
  mediaOutcomeSummary?: MediaQuoteOutcomeSummary | null;
  quoteAccuracyOutcomeSummary?: QuoteAccuracyOutcomeSummary | null;
  quoteHotWindowOutcomeSummary?: QuoteHotWindowOutcomeSummary | null;
  quoteCloseOutcomeSummary?: QuoteCloseOutcomeSummary | null;
  reactivationOutcomeSummary?: ReactivationOutcomeSummary | null;
  quoteFollowupOutcomeSummary?: QuoteFollowupOutcomeSummary | null;
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
  const weakMediaTighteningOutperforms = Boolean(
    input.mediaOutcomeSummary &&
      input.mediaOutcomeSummary.mediaInformed.tightenedAfterMoreMedia.quotes >= 3 &&
      input.mediaOutcomeSummary.mediaInformed.tightenedAfterMoreMedia.bookRate >=
        input.mediaOutcomeSummary.mediaInformed.unresolvedWeakMedia.bookRate + 0.05,
  );
  const autopilotPolicy = input.autopilotPolicy ?? {
    dmSmsFallbackAfterMinutes: 120,
    dmMinSilenceBeforeSmsMinutes: 45,
    dmMissingInfoFollowupDelayMinutes: 90,
    dmQuoteFollowupDelayMinutes: 180,
    dmObjectionFollowupDelayMinutes: 360,
  };
  const preferredChannel = chooseChannel(context);
  const firstResponseLearningScope = getFirstResponseLearningScope({
    latestLeadSource: context.latestLead?.source ?? null,
    contactSource: context.contact.source ?? null,
    dmEntrySource: context.derived.dmEntrySource ?? null,
    latestLeadServices: context.latestLead?.servicesRequested ?? [],
  });
  const quoteFollowupLearningScope = getQuoteFollowupLearningScope({
    latestLeadSource: context.latestLead?.source ?? null,
    contactSource: context.contact.source ?? null,
    dmEntrySource: context.derived.dmEntrySource ?? null,
    latestLeadServices: context.latestLead?.servicesRequested ?? [],
    instantQuoteJobTypes: context.instantQuote?.jobTypes ?? [],
  });
  const preferredFirstResponseChannel = (() => {
    const learned = getPreferredFirstResponseChannel(
      input.firstResponseOutcomeSummary,
      firstResponseLearningScope,
    );
    if (learned === "sms" && hasChannelAvailable(context, "sms")) return "sms";
    if (learned === "dm" && hasChannelAvailable(context, "dm")) return "dm";
    return preferredChannel;
  })();
  const quoteFollowupChannel = chooseQuoteFollowupChannel(
    context,
    preferredChannel,
    input.quoteFollowupOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const objectionSaveLearningScope = getObjectionSaveLearningScope({
    objections: context.derived.objections,
  });
  const objectionSaveChannel = (() => {
    const learned = getPreferredObjectionSaveChannel(
      input.objectionSaveOutcomeSummary,
      objectionSaveLearningScope,
    );
    if (learned === "sms" && hasChannelAvailable(context, "sms")) return "sms";
    if (learned === "dm" && hasChannelAvailable(context, "dm")) return "dm";
    return quoteFollowupChannel;
  })();
  const quoteCloseChannel = (() => {
    const learned = getPreferredQuoteCloseChannel(input.quoteCloseOutcomeSummary);
    if (learned === "sms" && hasChannelAvailable(context, "sms")) return "sms";
    if (learned === "dm" && hasChannelAvailable(context, "dm")) return "dm";
    return quoteFollowupChannel;
  })();
  const preferFastQuoteFollowup = shouldPreferFastQuoteFollowup(
    input.quoteFollowupOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const secondQuoteFollowupStillWorthwhile = isSecondQuoteFollowupStillWorthwhile(
    input.quoteFollowupOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const thirdPlusQuoteFollowupWorthwhile = isThirdPlusQuoteFollowupWorthwhile(
    input.quoteFollowupOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const keepQuoteFollowupDepthLight = shouldKeepQuoteFollowupDepthLight(
    input.quoteFollowupOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const keepQuoteFollowupShort = shouldKeepQuoteFollowupShort(
    input.quoteFollowupOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const keepQuoteFollowupSingleAsk = shouldKeepQuoteFollowupSingleAsk(
    input.quoteFollowupOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const openQuoteFollowupWithPhotoAsk = shouldOpenQuoteFollowupWithPhotoAsk(
    input.quoteFollowupOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const avoidHardQuoteBookingAsk = shouldAvoidHardQuoteBookingAsk(
    input.quoteFollowupOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const keepSofterQuoteClose = shouldUseSofterQuoteClose(input.quoteCloseOutcomeSummary);
  const keepQuoteEstimateProvisional = shouldKeepQuoteEstimateProvisional(
    input.quoteAccuracyOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const learnedQuoteHotWindow = getLearnedQuoteHotWindow(
    input.quoteHotWindowOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const quoteUrgencyDecaysFast = doesQuoteUrgencyDecayFast(
    input.quoteHotWindowOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const sameDayQuoteWindowStillStrong = isSameDayQuoteWindowStillStrong(
    input.quoteHotWindowOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const keepSofterReactivation = shouldUseSofterReactivation(input.reactivationOutcomeSummary);
  const quoteAccuracyTrendsAboveRange = doesQuoteAccuracyTrendAboveRange(
    input.quoteAccuracyOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const reactivationWorthwhile = isReactivationWorthwhile(input.reactivationOutcomeSummary);
  const keepSingleMissingInfoAsk = shouldKeepSingleMissingInfoAsk(input.missingInfoOutcomeSummary);
  const leanIntoMissingInfoRequests = shouldLeanIntoMissingInfoRequests(input.missingInfoOutcomeSummary);
  const keepSofterObjectionSave = shouldUseSofterObjectionSave(
    input.objectionSaveOutcomeSummary,
    objectionSaveLearningScope,
  );
  const preferFastFirstResponse = shouldPreferFastFirstResponse(
    input.firstResponseOutcomeSummary,
    firstResponseLearningScope,
  );
  const keepFirstResponseShort = shouldKeepFirstResponseShort(
    input.firstResponseOutcomeSummary,
    firstResponseLearningScope,
  );
  const keepFirstResponseSingleAsk = shouldKeepFirstResponseSingleAsk(
    input.firstResponseOutcomeSummary,
    firstResponseLearningScope,
  );
  const openFirstResponseWithPhotoAsk = shouldOpenFirstResponseWithPhotoAsk(
    input.firstResponseOutcomeSummary,
    firstResponseLearningScope,
  );
  const avoidHardBookingAskInFirstResponse = shouldAvoidHardBookingAskInFirstResponse(
    input.firstResponseOutcomeSummary,
    firstResponseLearningScope,
  );
  const tightenLowConfidenceQuoteEstimates = shouldTightenLowConfidenceQuoteEstimates(
    input.quoteAccuracyOutcomeSummary,
    quoteFollowupLearningScope,
  );
  const dmSmsHandoffWorthwhile = isDmSmsHandoffWorthwhile(input.channelHandoffOutcomeSummary);
  const keepDmSmsHandoffLight = shouldKeepDmSmsHandoffLight(input.channelHandoffOutcomeSummary);
  const dmSmsTransitionHealthy = isDmSmsTransitionHealthy(input.channelHandoffOutcomeSummary);
  const latestQuoteCreatedAt = getLatestQuoteCreatedAt(context);
  const latestInboundAt = pickLatestDate(context.channelSummary.map((row) => row.lastInboundAt));
  const lowConfidenceQuoteAccuracyRisk = Boolean(
    memory.quoteConfidence !== "high" && tightenLowConfidenceQuoteEstimates,
  );
  const accelerateQuoteFollowup = Boolean(
    preferFastQuoteFollowup &&
      latestQuoteCreatedAt &&
      now.getTime() - latestQuoteCreatedAt.getTime() <= 6 * 60 * 60 * 1000 &&
      !lowConfidenceQuoteAccuracyRisk,
  );
  const pendingHumanTakeover = context.automation.some((row) => row.humanTakeover);
  const pendingDnc = context.automation.some((row) => row.dnc);
  const paused = context.automation.some((row) => row.paused);
  const currentFollowupDepth = context.automation.reduce(
    (max, row) => (typeof row.followupStep === "number" ? Math.max(max, row.followupStep) : max),
    0,
  );
  const nextAutomationFollowup = pickLatestDate(context.automation.map((row) => row.nextFollowupAt));
  const nextTaskDue = pickLatestDate(context.openTasks.map((row) => row.dueAt));
  const latestLeadCreatedAt = parseIso(context.latestLead?.createdAt ?? null);
  const hasFormalQuote = Boolean(context.formalQuote?.id);
  const hasInstantQuote = Boolean(context.instantQuote?.id);
  const missingInfoChannel = chooseMissingInfoChannel(
    context,
    (hasInstantQuote || hasFormalQuote ? quoteFollowupChannel : preferredChannel) ?? preferredChannel,
    input.missingInfoOutcomeSummary,
  );
  const dormantQuoteLead = Boolean(
    (hasInstantQuote || hasFormalQuote) &&
      latestInboundAt &&
      now.getTime() - latestInboundAt.getTime() >= 24 * 60 * 60 * 1000 &&
      !hasRecentOutbound(context, now, 12 * 60)
  );
  const reactivationChannel = chooseReactivationChannel(
    context,
    quoteFollowupChannel,
    input.reactivationOutcomeSummary,
  );
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

  const exceptionRouting = buildExceptionRouting(context);
  if (exceptionRouting) {
    return {
      actionType: "human_follow_up",
      channel: preferredChannel,
      status: "blocked",
      priority: "urgent",
      confidence: "high",
      summary: exceptionRouting.summary,
      reason: exceptionRouting.reason,
      facts: exceptionRouting.facts,
      dueAt: now.toISOString(),
      source: "rules_v1",
    };
  }

  if (hasUpcomingAppointment) {
    const preservationLearning = input.appointmentPreservationOutcomeSummary;
    const reminderLearning = input.appointmentReminderOutcomeSummary;
    const appointmentStart = parseIso(context.nextAppointment?.startAt ?? null);
    const minutesUntilAppointment =
      appointmentStart ? Math.round((appointmentStart.getTime() - now.getTime()) / (60 * 1000)) : null;
    const appointmentSupportIntent = classifyAppointmentSupportIntent(context);
    const appointmentTypeKey =
      context.nextAppointment?.type === "estimate" ||
      context.nextAppointment?.type === "in_person_quote" ||
      context.nextAppointment?.type === "job"
        ? context.nextAppointment.type
        : "other";
    const appointmentTypeRisk =
      preservationLearning?.byAppointmentType?.[appointmentTypeKey] ?? null;
    const preferredReminderWindow =
      reminderLearning?.learned.preferredWindow === "24h"
        ? "24 hour"
        : reminderLearning?.learned.preferredWindow === "2h"
          ? "2 hour"
          : null;
    const strongestTouchKind =
      preservationLearning?.learned.strongestTouchKind === "requested"
        ? "initial confirmations"
        : preservationLearning?.learned.strongestTouchKind === "rescheduled"
          ? "reschedule confirmations"
          : preservationLearning?.learned.strongestTouchKind === "reminder"
            ? "pre-job reminders"
            : null;
    const appointmentCheckinChannel = hasChannelAvailable(context, "sms") ? "sms" : preferredChannel;
    const appointmentLooksShaky =
      Boolean(preservationLearning?.learned.needsHumanBackup) ||
      Boolean(reminderLearning && !reminderLearning.learned.confirmationLoopHealthy) ||
      Boolean(
        appointmentTypeRisk &&
          appointmentTypeRisk.attempts >= 4 &&
          appointmentTypeRisk.canceledRate + appointmentTypeRisk.noShowRate >= 0.18,
      );
    const appointmentCheckinEligible =
      Boolean(appointmentStart) &&
      minutesUntilAppointment !== null &&
      minutesUntilAppointment >= 90 &&
      minutesUntilAppointment <= 18 * 60 &&
      Boolean(appointmentCheckinChannel) &&
      hasChannelAvailable(context, appointmentCheckinChannel) &&
      appointmentLooksShaky &&
      !hasRecentOutbound(context, now, 10 * 60);

    const appointmentSupportChannel = preferredChannel;
    const appointmentSupportEligible =
      appointmentSupportIntent !== null &&
      hasRecentInboundWithoutReply(context, now) &&
      Boolean(appointmentStart) &&
      minutesUntilAppointment !== null &&
      minutesUntilAppointment >= -60 &&
      minutesUntilAppointment <= 48 * 60 &&
      Boolean(appointmentSupportChannel) &&
      hasChannelAvailable(context, appointmentSupportChannel);

    if (appointmentStart && appointmentSupportEligible) {
      const supportSummary =
        appointmentSupportIntent === "reschedule"
          ? "Reply now and try to save the booked appointment before it fully slips."
          : appointmentSupportIntent === "logistics"
            ? "Reply now and clear up the appointment logistics so the booking stays healthy."
            : "Reply now and keep the booked appointment warm with a short reassuring confirmation.";
      const supportReason =
        appointmentSupportIntent === "reschedule"
          ? "The customer is signaling a timing issue on an upcoming appointment."
          : appointmentSupportIntent === "logistics"
            ? "The customer asked a timing or logistics question about the upcoming appointment."
            : "The customer sent a light confirmation-style message about the upcoming appointment that should get a short human reply.";
      return {
        actionType: "appointment_support",
        channel: appointmentSupportChannel,
        status: "open",
        priority: minutesUntilAppointment !== null && minutesUntilAppointment <= 6 * 60 ? "high" : "normal",
        confidence: appointmentSupportIntent === "reschedule" ? "high" : "medium",
        summary: supportSummary,
        reason: supportReason,
        facts: dedupe([
          `Appointment at ${appointmentStart.toISOString()}`,
          context.nextAppointment?.type ? `Appointment type: ${formatFactLabel(context.nextAppointment.type)}.` : null,
          appointmentSupportIntent === "reschedule"
            ? "Recent inbound message suggests the customer may need to move the appointment."
            : appointmentSupportIntent === "logistics"
              ? "Recent inbound message asks about appointment timing or logistics."
              : "Recent inbound message looks like a light appointment confirmation or reassurance touch.",
          reminderLearning?.learned.rescheduleSavesWorking
            ? "Recent reschedule requests are turning back into kept appointments often enough that it is worth trying to save the booking first."
            : null,
          memory.lastPromisedNextStep,
        ]),
        dueAt: now.toISOString(),
        source: "rules_v1",
      };
    }

    if (appointmentStart && appointmentCheckinEligible) {
      return {
        actionType: "appointment_checkin",
        channel: appointmentCheckinChannel,
        status: "open",
        priority: minutesUntilAppointment !== null && minutesUntilAppointment <= 4 * 60 ? "high" : "normal",
        confidence: "medium",
        summary: "Send a light pre-appointment check-in to protect this booking before the appointment.",
        reason: "The appointment is coming up and recent reminder results suggest this one would benefit from an extra reassurance touch.",
        facts: dedupe([
          `Appointment at ${appointmentStart.toISOString()}`,
          context.nextAppointment?.type ? `Appointment type: ${formatFactLabel(context.nextAppointment.type)}.` : null,
          preferredReminderWindow
            ? `Recent acknowledgement performance is strongest around the ${preferredReminderWindow} reminder.`
            : null,
          strongestTouchKind ? `Booked jobs are being preserved best after ${strongestTouchKind}.` : null,
          appointmentTypeRisk && appointmentTypeRisk.attempts >= 4
            ? `${formatFactLabel(appointmentTypeKey)} appointments are currently canceling or no-showing ${Math.round(
                (appointmentTypeRisk.canceledRate + appointmentTypeRisk.noShowRate) * 100,
              )}% of the time after confirmation touches.`
            : null,
          preservationLearning?.learned.needsHumanBackup
            ? "Recent booked jobs are still slipping into cancellations or no-shows often enough that this appointment should get an extra light check-in."
            : null,
          reminderLearning && !reminderLearning.learned.confirmationLoopHealthy
            ? "Recent reminder acknowledgements are still soft overall, so an extra check-in may keep this appointment healthier."
            : null,
          memory.lastPromisedNextStep,
        ]),
        dueAt: buildAppointmentCheckinDueAt(appointmentStart, now),
        source: "rules_v1",
      };
    }

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
        preferredReminderWindow ? `Recent appointment acknowledgements are stronger after the ${preferredReminderWindow} reminder.` : null,
        strongestTouchKind ? `Recent booked jobs are being preserved best after ${strongestTouchKind}.` : null,
        reminderLearning?.learned.rescheduleSavesWorking
          ? "Recent reschedule requests are turning back into kept appointments often enough that keeping the reschedule path easy is paying off."
          : null,
        appointmentTypeRisk && appointmentTypeRisk.attempts >= 4
          ? `${formatFactLabel(appointmentTypeKey)} appointments are currently canceling or no-showing ${Math.round(
              (appointmentTypeRisk.canceledRate + appointmentTypeRisk.noShowRate) * 100,
            )}% of the time after confirmation touches.`
          : null,
        preservationLearning?.learned.needsHumanBackup
          ? "Recent booked jobs are still slipping into cancellations or no-shows often enough that shakier appointments may need a human backup touch."
          : null,
        reminderLearning && !reminderLearning.learned.confirmationLoopHealthy
          ? "Recent reminder acknowledgements are still soft overall, so shaky appointments may still need human confirmation."
          : null,
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
    const firstResponseChannel = preferredFirstResponseChannel ?? preferredChannel;
    const firstResponseIsMessagingChannel =
      firstResponseChannel === "dm" || firstResponseChannel === "email";
    return {
      actionType: firstResponseIsMessagingChannel ? "reply_now" : "call_now",
      channel:
        firstResponseChannel === "sms" && (context.contact.phoneE164 || context.contact.phone)
          ? "sms"
          : firstResponseChannel,
      status: "open",
      priority: "urgent",
      confidence: "high",
      summary: firstResponseIsMessagingChannel
        ? "Fast first-response window is open. Message this lead now."
        : "Fast first-response window is open. Reach out to this lead now.",
      reason: "The lead is fresh and there has not been a recent outbound touch.",
      facts: dedupe([
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
        context.derived.knownZip ? `ZIP: ${context.derived.knownZip}` : null,
        memory.pricingContext,
        firstResponseChannel && firstResponseChannel !== preferredChannel
          ? `Recent first responses are converting better on ${firstResponseChannel.toUpperCase()}.`
          : null,
        preferFastFirstResponse
          ? "Recent first responses are performing better when they go out within 30 minutes."
          : null,
        keepFirstResponseShort
          ? "Recent first responses are converting better when the opener stays short."
          : null,
        keepFirstResponseSingleAsk
          ? "Recent first responses are converting better when there is one clear ask."
          : null,
        openFirstResponseWithPhotoAsk
          ? "Recent first responses are converting better when the opener quickly asks for photos or a walkthrough."
          : null,
        avoidHardBookingAskInFirstResponse
          ? "Recent first responses are underperforming when they push too hard for booking right away."
          : null,
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
      priority: dmSmsHandoffWorthwhile ? "high" : "normal",
      confidence: keepDmSmsHandoffLight ? "low" : "medium",
      summary: keepDmSmsHandoffLight
        ? "Move this lead from Messenger to text with a light handoff, not a hard push."
        : "Move this lead from Messenger to text and keep the conversation going there.",
      reason: dmFollowupStrategy.summary,
      facts: dedupe([
        ...dmFollowupStrategy.facts,
        context.derived.dmEntrySource ? `Messenger entry source: ${context.derived.dmEntrySource.replace(/_/g, " ")}` : null,
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
        dmSmsTransitionHealthy
          ? "Recent Messenger to text handoffs are carrying over into SMS replies often enough to keep using when DM goes quiet."
          : null,
        keepDmSmsHandoffLight
          ? "Recent Messenger to text handoffs are often not carrying over into SMS replies, so keep the handoff light and only use it on more qualified quiet leads."
          : null,
        !dmSmsHandoffWorthwhile
          ? "Recent Messenger to text handoffs are not reopening strongly enough to justify a hard handoff push."
          : null,
      ]),
      dueAt: now.toISOString(),
      source: "rules_v1",
    };
  }

  if ((hasInstantQuote || hasFormalQuote) && context.derived.objections.includes("price")) {
    return {
      actionType: "handle_price_objection",
      channel: objectionSaveChannel,
      status: "open",
      priority: "high",
      confidence: "medium",
      summary: "Follow up with a short price-objection save attempt.",
      reason: "The contact has quote context and has shown price resistance.",
      facts: dedupe([
        memory.pricingContext,
        "Known objection: price",
        objectionSaveLearningScope.objectionType
          ? `Objection type: ${objectionSaveLearningScope.objectionType.replace(/_/g, " ")}`
          : null,
        objectionSaveChannel && objectionSaveChannel !== quoteFollowupChannel
          ? `Recent ${objectionSaveLearningScope.objectionType ? objectionSaveLearningScope.objectionType.replace(/_/g, " ") : "objection"} saves are reopening better on ${objectionSaveChannel.toUpperCase()}.`
          : null,
        keepSofterObjectionSave
          ? `Recent ${objectionSaveLearningScope.objectionType ? objectionSaveLearningScope.objectionType.replace(/_/g, " ") : "objection"} saves are reopening weakly, so a short low-pressure reopen is safer than a hard push.`
          : null,
        quoteFollowupChannel && quoteFollowupChannel !== preferredChannel
          ? `Recent quote follow-ups are booking better on ${quoteFollowupChannel.toUpperCase()}.`
          : null,
        preferFastQuoteFollowup ? "Recent quote follow-ups are booking better when the first follow-up goes out within 60 minutes." : null,
        context.derived.dmEntrySource ? `Messenger entry source: ${context.derived.dmEntrySource.replace(/_/g, " ")}` : null,
        memory.lastPromisedNextStep,
      ]),
      dueAt:
        objectionSaveChannel === "dm"
          ? resolveDeferredDueAt({
              channel: "dm",
              delayMinutes: dmEntryProfile.objectionDelayMinutes,
              baselines: [nextTaskDue],
            })
          : accelerateQuoteFollowup
            ? now.toISOString()
            : nextTaskDue?.toISOString() ?? now.toISOString(),
      source: "rules_v1",
    };
  }

  const preferredMissingAngle = extractPreferredMissingAngle(memory);
  const needsMediaRefinement =
    Boolean(preferredMissingAngle) || ((hasInstantQuote || hasFormalQuote) && memory.quoteConfidence === "low");
  const hasCriticalMissingInfo = memory.missingFields.some((field) =>
    /photo angle|missing view|video angle|zip|postal|address|phone|email/i.test(field),
  );
  const shouldKeepMomentumDespiteMissingInfo = Boolean(
    memory.missingFields.length > 0 &&
      !hasCriticalMissingInfo &&
      context.derived.bookingReadiness !== "low" &&
      !leanIntoMissingInfoRequests,
  );

  if (
    (hasInstantQuote || hasFormalQuote) &&
    needsMediaRefinement &&
    (
      context.derived.bookingReadiness !== "high" ||
      lowConfidenceQuoteAccuracyRisk ||
      (weakMediaTighteningOutperforms && Boolean(preferredMissingAngle))
    ) &&
    !hasRecentOutbound(context, now, 60)
  ) {
    return {
      actionType: "collect_missing_info",
      channel: missingInfoChannel,
      status: "open",
      priority: "high",
      confidence: "high",
      summary: "Tighten the estimate with one better media angle before pushing the quote harder.",
      reason:
        preferredMissingAngle
          ? `The current estimate is still missing a key view (${preferredMissingAngle}), so the next best move is to tighten the scope first.`
          : "The current quote exists, but media confidence is still low enough that one better angle is safer than a normal quote follow-up.",
      facts: dedupe([
        memory.pricingContext,
        memory.quoteConfidence ? `Quote confidence: ${memory.quoteConfidence}` : null,
        preferredMissingAngle ? `Best next angle: ${preferredMissingAngle}` : null,
        weakMediaTighteningOutperforms ? "Recent outcomes show tightened weak quotes are booking better than unresolved weak quotes." : null,
        lowConfidenceQuoteAccuracyRisk
          ? "Recent lower-confidence instant estimates are landing outside the original range often enough that tightening the estimate first is safer."
          : null,
        quoteAccuracyTrendsAboveRange
          ? "Recent completed jobs are finishing above the original instant range often enough that shaky estimates should stay provisional until tightened."
          : null,
        missingInfoChannel && missingInfoChannel !== preferredChannel
          ? `Recent missing-detail requests are resolving better on ${missingInfoChannel.toUpperCase()}.`
          : null,
        keepSingleMissingInfoAsk
          ? "Recent missing-detail requests are stalling, so keep the ask to one specific detail or angle."
          : null,
        preferFastQuoteFollowup ? "Recent quote follow-ups are booking better when the first follow-up goes out within 60 minutes." : null,
        context.derived.dmEntrySource ? `Messenger entry source: ${context.derived.dmEntrySource.replace(/_/g, " ")}` : null,
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
      ]),
      dueAt:
        missingInfoChannel === "dm"
          ? resolveDeferredDueAt({
              channel: "dm",
              delayMinutes: dmEntryProfile.missingInfoDelayMinutes,
              baselines: [nextAutomationFollowup],
            })
          : accelerateQuoteFollowup
            ? now.toISOString()
            : nextAutomationFollowup?.toISOString() ?? now.toISOString(),
      source: "rules_v1",
    };
  }

  if (
    memory.missingFields.length > 0 &&
    !hasRecentOutbound(context, now, 120) &&
    (hasCriticalMissingInfo || context.derived.bookingReadiness === "low" || leanIntoMissingInfoRequests || (!hasInstantQuote && !hasFormalQuote))
  ) {
    return {
      actionType: "collect_missing_info",
      channel: missingInfoChannel,
      status: "open",
      priority: "high",
      confidence: "medium",
      summary: "Ask for the single missing detail that unlocks the next step.",
      reason: "The lead is still missing key information for a confident quote or booking.",
      facts: dedupe([
        `Missing: ${memory.missingFields.join(", ")}`,
        missingInfoChannel && missingInfoChannel !== preferredChannel
          ? `Recent missing-detail requests are resolving better on ${missingInfoChannel.toUpperCase()}.`
          : null,
        keepSingleMissingInfoAsk
          ? "Recent missing-detail requests are stalling, so keep the ask to one specific detail or angle."
          : null,
        context.derived.dmEntrySource ? `Messenger entry source: ${context.derived.dmEntrySource.replace(/_/g, " ")}` : null,
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
      ]),
      dueAt:
        missingInfoChannel === "dm"
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
    const effectiveQuoteFollowupChannel = dormantQuoteLead ? reactivationChannel : quoteCloseChannel;
    const quoteAgeHours =
      latestQuoteCreatedAt ? (now.getTime() - latestQuoteCreatedAt.getTime()) / 3_600_000 : null;
    const quoteStillHot = sameDayQuoteWindowStillStrong && quoteAgeHours !== null && quoteAgeHours <= 24;
    return {
      actionType: "follow_up_quote",
      channel: effectiveQuoteFollowupChannel,
      status: "open",
      priority:
        dormantQuoteLead && !reactivationWorthwhile
          ? "low"
          : currentFollowupDepth >= 3 && !thirdPlusQuoteFollowupWorthwhile
            ? "low"
            : currentFollowupDepth >= 2 && !secondQuoteFollowupStillWorthwhile
              ? "normal"
              : quoteStillHot && !lowConfidenceQuoteAccuracyRisk
                ? "high"
          : context.derived.bookingReadiness === "high" && !lowConfidenceQuoteAccuracyRisk
            ? "high"
            : "normal",
      confidence: "medium",
      summary:
        currentFollowupDepth >= 3 && keepQuoteFollowupDepthLight
          ? "Use a light late-stage quote nudge, not a hard repeated push."
          : dormantQuoteLead
            ? "Reopen this quiet quote lead with a short follow-up."
            : "Follow up on the quote and try to move the lead toward booking.",
      reason: dormantQuoteLead
        ? "A quote exists, but the lead has gone quiet and needs a light reopen."
        : "A quote exists, but no appointment is scheduled yet.",
      facts: dedupe([
        memory.pricingContext,
        memory.lastPromisedNextStep,
        effectiveQuoteFollowupChannel && effectiveQuoteFollowupChannel !== preferredChannel
          ? dormantQuoteLead
            ? `Recent dormant lead reactivations are reopening better on ${effectiveQuoteFollowupChannel.toUpperCase()}.`
            : `Recent agent quote follow-ups are converting better on ${effectiveQuoteFollowupChannel.toUpperCase()}.`
          : null,
        !dormantQuoteLead && keepSofterQuoteClose
          ? "Recent agent quote follow-ups are ending in losses more often than bookings, so a softer reopen is safer than a hard booking push."
          : null,
        keepQuoteEstimateProvisional
          ? quoteAccuracyTrendsAboveRange
            ? "Recent completed jobs are finishing above the original instant range often enough that this quote should stay framed as a working estimate until tightened."
            : "Recent completed jobs are landing outside the original instant range often enough that this quote should stay framed as a working estimate, not a locked-in price."
          : null,
        learnedQuoteHotWindow
          ? `Recent ${learnedQuoteHotWindow === "slow_burn" ? "quote bookings are arriving later than same day" : `quote bookings are hottest in the ${learnedQuoteHotWindow.replace(/_/g, " ")}`} .`.replace(" .", ".")
          : null,
        quoteUrgencyDecaysFast
          ? "Recent quote booking rates are dropping off quickly after the early hot window."
          : null,
        quoteStillHot
          ? "This quote is still inside the segment's strong same-day booking window."
          : null,
        currentFollowupDepth >= 2 && !secondQuoteFollowupStillWorthwhile
          ? "Recent second-touch quote follow-ups are not outperforming enough to justify repeated pushes."
          : null,
        currentFollowupDepth >= 3 && !thirdPlusQuoteFollowupWorthwhile
          ? "Recent third-touch quote follow-ups are closing weakly enough that this should stay low pressure."
          : null,
        keepQuoteFollowupDepthLight
          ? "Recent later-stage quote follow-ups are performing better when they stay light instead of stacking repeated pushes."
          : null,
        keepQuoteFollowupShort
          ? "Recent quote follow-ups are booking better when they stay short."
          : null,
        keepQuoteFollowupSingleAsk
          ? "Recent quote follow-ups are booking better with one clear ask."
          : null,
        openQuoteFollowupWithPhotoAsk
          ? "Recent quote follow-ups are booking better when they lead with one quick photo or walkthrough ask."
          : null,
        avoidHardQuoteBookingAsk
          ? "Recent quote follow-ups are underperforming when they push too hard for booking."
          : null,
        dormantQuoteLead && keepSofterReactivation
          ? "Recent dormant lead reactivations are reopening weakly overall, so a softer reopen is safer than a hard booking push."
          : null,
        dormantQuoteLead && !reactivationWorthwhile
          ? "Recent dormant lead reactivations are not converting strongly, so this should stay light and low pressure."
          : null,
        shouldKeepMomentumDespiteMissingInfo
          ? "Recent missing-detail requests are resolving weakly, so keeping momentum is safer than blocking on another detail first."
          : null,
        preferFastQuoteFollowup ? "Recent quote follow-ups are booking better when the first follow-up goes out within 60 minutes." : null,
        context.derived.dmEntrySource ? `Messenger entry source: ${context.derived.dmEntrySource.replace(/_/g, " ")}` : null,
        memory.customerIntent ? `Intent: ${memory.customerIntent}` : null,
      ]),
      dueAt:
        effectiveQuoteFollowupChannel === "dm"
          ? resolveDeferredDueAt({
              channel: "dm",
              delayMinutes: dmEntryProfile.quoteDelayMinutes,
              baselines: [nextTaskDue, nextAutomationFollowup],
            })
          : accelerateQuoteFollowup
            ? now.toISOString()
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
