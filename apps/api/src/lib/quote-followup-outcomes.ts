import { conversationMessages, conversationThreads, getDb, instantQuotes, leads } from "@/db";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;

type FollowupChannel = "sms" | "dm" | "email";
type TimingBucket = "fast" | "delayed";
type DepthBucket = "first" | "second" | "third_plus";
type ServiceFamily = "junk" | "demo" | "brush" | "unknown";
type SourceFamily = "facebook" | "public_site" | "other" | "unknown";

type QuoteFollowupOutcomeRow = {
  quoteId: string;
  quoteCreatedAt: Date;
  channel: FollowupChannel;
  touchAt: Date;
  hasBookedAppointment: boolean;
  followupDepth: number;
  serviceFamily: ServiceFamily;
  sourceFamily: SourceFamily;
};

type OutcomeBucket = {
  quotes: number;
  bookedQuotes: number;
  bookRate: number;
};

export type QuoteFollowupLearningScope = {
  serviceFamily?: ServiceFamily | null;
  sourceFamily?: SourceFamily | null;
};

type QuoteFollowupOutcomeSlice = {
  quotesWithFollowup: number;
  bookedQuotes: number;
  byChannel: Record<FollowupChannel, OutcomeBucket>;
  byTiming: Record<TimingBucket, OutcomeBucket>;
  byDepth: Record<DepthBucket, OutcomeBucket>;
  learned: {
    preferredChannel: "sms" | "dm" | null;
    preferFast: boolean;
    secondTouchStillWorthwhile: boolean;
    thirdPlusWorthwhile: boolean;
    keepDepthLight: boolean;
  };
};

export type QuoteFollowupOutcomeSummary = QuoteFollowupOutcomeSlice & {
  windowStart: string;
  byServiceFamily: Record<ServiceFamily, QuoteFollowupOutcomeSlice>;
  bySourceFamily: Record<SourceFamily, QuoteFollowupOutcomeSlice>;
};

function toRate(booked: number, total: number): number {
  return total > 0 ? Number((booked / total).toFixed(4)) : 0;
}

function summarizeBucket(rows: Array<{ hasBookedAppointment: boolean }>): OutcomeBucket {
  const quotes = rows.length;
  const bookedQuotes = rows.filter((row) => row.hasBookedAppointment).length;
  return {
    quotes,
    bookedQuotes,
    bookRate: toRate(bookedQuotes, quotes),
  };
}

function dedupeFirstFollowups(rows: QuoteFollowupOutcomeRow[]): QuoteFollowupOutcomeRow[] {
  const byQuoteId = new Map<string, QuoteFollowupOutcomeRow>();
  for (const row of rows) {
    if (!byQuoteId.has(row.quoteId)) {
      byQuoteId.set(row.quoteId, row);
    }
  }
  return [...byQuoteId.values()];
}

function getTimingBucket(row: QuoteFollowupOutcomeRow): TimingBucket {
  const delayMinutes = (row.touchAt.getTime() - row.quoteCreatedAt.getTime()) / 60_000;
  return delayMinutes <= 60 ? "fast" : "delayed";
}

function getDepthBucket(row: QuoteFollowupOutcomeRow): DepthBucket {
  if (row.followupDepth >= 3) return "third_plus";
  if (row.followupDepth === 2) return "second";
  return "first";
}

function getPreferredChannel(
  summary: QuoteFollowupOutcomeSlice,
): "sms" | "dm" | null {
  const sms = summary.byChannel.sms;
  const dm = summary.byChannel.dm;
  if (sms.quotes >= 5 && (dm.quotes < 3 || sms.bookRate >= dm.bookRate + 0.05)) {
    return "sms";
  }
  if (dm.quotes >= 5 && (sms.quotes < 3 || dm.bookRate >= sms.bookRate + 0.05)) {
    return "dm";
  }
  return null;
}

function shouldPreferFast(summary: QuoteFollowupOutcomeSlice): boolean {
  const fast = summary.byTiming.fast;
  const delayed = summary.byTiming.delayed;
  if (fast.quotes < 5) return false;
  if (delayed.quotes < 3) return fast.bookRate > 0;
  return fast.bookRate >= delayed.bookRate + 0.05;
}

function isSecondTouchStillWorthwhile(summary: QuoteFollowupOutcomeSlice): boolean {
  const second = summary.byDepth.second;
  const first = summary.byDepth.first;
  if (second.quotes < 4) return true;
  if (first.quotes < 3) return second.bookRate >= 0.05;
  return second.bookRate >= 0.05 || second.bookRate + 0.03 >= first.bookRate;
}

function isThirdPlusWorthwhile(summary: QuoteFollowupOutcomeSlice): boolean {
  const thirdPlus = summary.byDepth.third_plus;
  const second = summary.byDepth.second;
  if (thirdPlus.quotes < 4) return true;
  if (second.quotes < 3) return thirdPlus.bookRate >= 0.04;
  return thirdPlus.bookRate >= 0.04 && thirdPlus.bookRate + 0.03 >= second.bookRate;
}

function shouldKeepDepthLight(summary: QuoteFollowupOutcomeSlice): boolean {
  const second = summary.byDepth.second;
  const thirdPlus = summary.byDepth.third_plus;
  if (thirdPlus.quotes >= 5 && thirdPlus.bookRate < 0.03) return true;
  if (second.quotes >= 5 && thirdPlus.quotes >= 3 && thirdPlus.bookRate + 0.03 <= second.bookRate) return true;
  if (second.quotes >= 5 && second.bookRate < 0.04 && summary.byDepth.first.bookRate >= second.bookRate + 0.05) return true;
  return false;
}

function buildSlice(rows: QuoteFollowupOutcomeRow[]): QuoteFollowupOutcomeSlice {
  const smsRows = rows.filter((row) => row.channel === "sms");
  const dmRows = rows.filter((row) => row.channel === "dm");
  const emailRows = rows.filter((row) => row.channel === "email");
  const fastRows = rows.filter((row) => getTimingBucket(row) === "fast");
  const delayedRows = rows.filter((row) => getTimingBucket(row) === "delayed");
  const firstRows = rows.filter((row) => getDepthBucket(row) === "first");
  const secondRows = rows.filter((row) => getDepthBucket(row) === "second");
  const thirdPlusRows = rows.filter((row) => getDepthBucket(row) === "third_plus");
  const bookedQuotes = rows.filter((row) => row.hasBookedAppointment).length;

  const slice: QuoteFollowupOutcomeSlice = {
    quotesWithFollowup: rows.length,
    bookedQuotes,
    byChannel: {
      sms: summarizeBucket(smsRows),
      dm: summarizeBucket(dmRows),
      email: summarizeBucket(emailRows),
    },
    byTiming: {
      fast: summarizeBucket(fastRows),
      delayed: summarizeBucket(delayedRows),
    },
    byDepth: {
      first: summarizeBucket(firstRows),
      second: summarizeBucket(secondRows),
      third_plus: summarizeBucket(thirdPlusRows),
    },
    learned: {
      preferredChannel: null,
      preferFast: false,
      secondTouchStillWorthwhile: true,
      thirdPlusWorthwhile: true,
      keepDepthLight: false,
    },
  };

  slice.learned.preferredChannel = getPreferredChannel(slice);
  slice.learned.preferFast = shouldPreferFast(slice);
  slice.learned.secondTouchStillWorthwhile = isSecondTouchStillWorthwhile(slice);
  slice.learned.thirdPlusWorthwhile = isThirdPlusWorthwhile(slice);
  slice.learned.keepDepthLight = shouldKeepDepthLight(slice);
  return slice;
}

function classifyServiceFamily(jobTypes: string[]): ServiceFamily {
  const normalized = jobTypes.map((value) => value.toLowerCase());
  if (normalized.some((value) => value.includes("demo"))) return "demo";
  if (normalized.some((value) => value.includes("brush") || value.includes("land"))) return "brush";
  if (normalized.length > 0) return "junk";
  return "unknown";
}

function classifySourceFamily(source: string | null | undefined): SourceFamily {
  const normalized = typeof source === "string" ? source.trim().toLowerCase() : "";
  if (!normalized) return "unknown";
  if (normalized.includes("facebook")) return "facebook";
  if (
    normalized.includes("public_site") ||
    normalized.includes("website") ||
    normalized === "demo_quote" ||
    normalized === "brush_quote" ||
    normalized === "junk_quote"
  ) {
    return "public_site";
  }
  return "other";
}

function emptySlice(): QuoteFollowupOutcomeSlice {
  return buildSlice([]);
}

function buildSummary(rows: QuoteFollowupOutcomeRow[], windowStart: Date): QuoteFollowupOutcomeSummary {
  const deduped = dedupeFirstFollowups(rows);
  return {
    windowStart: windowStart.toISOString(),
    ...buildSlice(deduped),
    byServiceFamily: {
      junk: buildSlice(deduped.filter((row) => row.serviceFamily === "junk")),
      demo: buildSlice(deduped.filter((row) => row.serviceFamily === "demo")),
      brush: buildSlice(deduped.filter((row) => row.serviceFamily === "brush")),
      unknown: buildSlice(deduped.filter((row) => row.serviceFamily === "unknown")),
    },
    bySourceFamily: {
      facebook: buildSlice(deduped.filter((row) => row.sourceFamily === "facebook")),
      public_site: buildSlice(deduped.filter((row) => row.sourceFamily === "public_site")),
      other: buildSlice(deduped.filter((row) => row.sourceFamily === "other")),
      unknown: buildSlice(deduped.filter((row) => row.sourceFamily === "unknown")),
    },
  };
}

function resolveScopedSummary(
  summary: QuoteFollowupOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): QuoteFollowupOutcomeSlice {
  if (!summary) return emptySlice();
  if (scope?.serviceFamily && summary.byServiceFamily[scope.serviceFamily].quotesWithFollowup >= 4) {
    return summary.byServiceFamily[scope.serviceFamily];
  }
  if (scope?.sourceFamily && summary.bySourceFamily[scope.sourceFamily].quotesWithFollowup >= 4) {
    return summary.bySourceFamily[scope.sourceFamily];
  }
  return summary;
}

export function getQuoteFollowupLearningScope(input: {
  latestLeadSource?: string | null;
  contactSource?: string | null;
  dmEntrySource?: "facebook_ad_lead" | "organic_messenger" | "unknown" | null;
  latestLeadServices?: string[] | null;
  instantQuoteJobTypes?: string[] | null;
}): QuoteFollowupLearningScope {
  const services = [
    ...(Array.isArray(input.latestLeadServices) ? input.latestLeadServices : []),
    ...(Array.isArray(input.instantQuoteJobTypes) ? input.instantQuoteJobTypes : []),
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const sourceFamily =
    input.dmEntrySource === "facebook_ad_lead"
      ? "facebook"
      : classifySourceFamily(input.latestLeadSource ?? input.contactSource ?? null);

  return {
    serviceFamily: classifyServiceFamily(services),
    sourceFamily,
  };
}

export async function loadQuoteFollowupOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<QuoteFollowupOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const touchAtExpr = sql<Date>`coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt})`;

  const rows = await db
    .select({
      quoteId: instantQuotes.id,
      quoteCreatedAt: instantQuotes.createdAt,
      channel: sql<FollowupChannel>`${conversationMessages.channel}`,
      touchAt: touchAtExpr,
      hasBookedAppointment: sql<boolean>`
        exists(
          select 1
          from appointments appt
          where appt.instant_quote_id = ${instantQuotes.id}
            and appt.status <> 'canceled'
        )
      `,
      source: instantQuotes.source,
      leadSource: leads.source,
      jobTypes: instantQuotes.jobTypes,
      leadServices: leads.servicesRequested,
    })
    .from(instantQuotes)
    .innerJoin(leads, eq(leads.instantQuoteId, instantQuotes.id))
    .innerJoin(conversationThreads, eq(conversationThreads.contactId, leads.contactId))
    .innerJoin(conversationMessages, eq(conversationMessages.threadId, conversationThreads.id))
    .where(
      and(
        gte(instantQuotes.createdAt, windowStart),
        eq(conversationMessages.direction, "outbound"),
        inArray(conversationMessages.channel, ["sms", "dm", "email"]),
        sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') <> 'true'`,
        sql`${touchAtExpr} >= ${instantQuotes.createdAt}`,
        sql`${touchAtExpr} <= ${instantQuotes.createdAt} + interval '7 days'`,
      ),
    )
    .orderBy(asc(instantQuotes.id), asc(touchAtExpr));
  const depthByQuoteId = new Map<string, number>();
  const mappedRows = rows.map((row) => {
    const nextDepth = (depthByQuoteId.get(row.quoteId) ?? 0) + 1;
    depthByQuoteId.set(row.quoteId, nextDepth);
    return {
      quoteId: row.quoteId,
      quoteCreatedAt: row.quoteCreatedAt,
      channel: row.channel,
      touchAt: row.touchAt,
      hasBookedAppointment: row.hasBookedAppointment,
      followupDepth: nextDepth,
      serviceFamily: classifyServiceFamily(
        [
          ...(Array.isArray(row.jobTypes) ? row.jobTypes : []),
          ...(Array.isArray(row.leadServices) ? row.leadServices : []),
        ].filter((item): item is string => typeof item === "string" && item.trim().length > 0),
      ),
      sourceFamily: classifySourceFamily(row.leadSource ?? row.source ?? null),
    };
  });

  return buildSummary(mappedRows, windowStart);
}

export function getPreferredQuoteFollowupChannel(
  summary: QuoteFollowupOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): "sms" | "dm" | null {
  return resolveScopedSummary(summary, scope).learned.preferredChannel;
}

export function shouldPreferFastQuoteFollowup(
  summary: QuoteFollowupOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.preferFast;
}

export function isSecondQuoteFollowupStillWorthwhile(
  summary: QuoteFollowupOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.secondTouchStillWorthwhile;
}

export function isThirdPlusQuoteFollowupWorthwhile(
  summary: QuoteFollowupOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.thirdPlusWorthwhile;
}

export function shouldKeepQuoteFollowupDepthLight(
  summary: QuoteFollowupOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.keepDepthLight;
}
