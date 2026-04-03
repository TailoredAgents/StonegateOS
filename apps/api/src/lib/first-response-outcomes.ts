import { appointments, conversationMessages, conversationThreads, getDb, leads } from "@/db";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  getQuoteFollowupLearningScope,
  type QuoteFollowupLearningScope,
} from "@/lib/quote-followup-outcomes";

type DbExecutor = ReturnType<typeof getDb>;
type ResponseChannel = "sms" | "dm" | "email";
type TimingBucket = "fast" | "delayed";
type ServiceFamily = "junk" | "demo" | "brush" | "unknown";
type SourceFamily = "facebook" | "public_site" | "other" | "unknown";
type StyleBucket = "short" | "long" | "single_ask" | "multi_ask" | "photo_ask" | "booking_ask";

type FirstResponseOutcomeRow = {
  leadId: string;
  leadCreatedAt: Date;
  channel: ResponseChannel;
  touchAt: Date;
  body: string;
  replied: boolean;
  booked: boolean;
  serviceFamily: ServiceFamily;
  sourceFamily: SourceFamily;
};

type OutcomeBucket = {
  attempts: number;
  replied: number;
  replyRate: number;
  booked: number;
  bookRate: number;
};

type FirstResponseOutcomeSlice = {
  attempts: number;
  replied: number;
  replyRate: number;
  booked: number;
  bookRate: number;
  byChannel: Record<ResponseChannel, OutcomeBucket>;
  byTiming: Record<TimingBucket, OutcomeBucket>;
  byStyle: Record<StyleBucket, OutcomeBucket>;
  learned: {
    preferredChannel: "sms" | "dm" | null;
    preferFast: boolean;
    keepShort: boolean;
    keepSingleAsk: boolean;
    openWithPhotoAsk: boolean;
    avoidHardBookingAsk: boolean;
  };
};

export type FirstResponseOutcomeSummary = FirstResponseOutcomeSlice & {
  windowStart: string;
  byServiceFamily: Record<ServiceFamily, FirstResponseOutcomeSlice>;
  bySourceFamily: Record<SourceFamily, FirstResponseOutcomeSlice>;
};

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarizeBucket(rows: Array<{ replied: boolean; booked: boolean }>): OutcomeBucket {
  const attempts = rows.length;
  const replied = rows.filter((row) => row.replied).length;
  const booked = rows.filter((row) => row.booked).length;
  return {
    attempts,
    replied,
    replyRate: toRate(replied, attempts),
    booked,
    bookRate: toRate(booked, attempts),
  };
}

function dedupeFirstTouches(rows: FirstResponseOutcomeRow[]): FirstResponseOutcomeRow[] {
  const byLeadId = new Map<string, FirstResponseOutcomeRow>();
  for (const row of rows) {
    if (!byLeadId.has(row.leadId)) {
      byLeadId.set(row.leadId, row);
    }
  }
  return [...byLeadId.values()];
}

function getTimingBucket(row: FirstResponseOutcomeRow): TimingBucket {
  const delayMinutes = (row.touchAt.getTime() - row.leadCreatedAt.getTime()) / 60_000;
  return delayMinutes <= 30 ? "fast" : "delayed";
}

function getPreferredChannel(
  summary: FirstResponseOutcomeSlice,
): "sms" | "dm" | null {
  const sms = summary.byChannel.sms;
  const dm = summary.byChannel.dm;
  if (
    sms.attempts >= 5 &&
    (dm.attempts < 3 ||
      sms.replyRate >= dm.replyRate + 0.05 ||
      (sms.replyRate >= dm.replyRate && sms.bookRate >= dm.bookRate + 0.03))
  ) {
    return "sms";
  }
  if (
    dm.attempts >= 5 &&
    (sms.attempts < 3 ||
      dm.replyRate >= sms.replyRate + 0.05 ||
      (dm.replyRate >= sms.replyRate && dm.bookRate >= sms.bookRate + 0.03))
  ) {
    return "dm";
  }
  return null;
}

function shouldPreferFast(summary: FirstResponseOutcomeSlice): boolean {
  const fast = summary.byTiming.fast;
  const delayed = summary.byTiming.delayed;
  if (fast.attempts < 5) return false;
  if (delayed.attempts < 3) return fast.replyRate > 0;
  return fast.replyRate >= delayed.replyRate + 0.05;
}

function isShortOpening(body: string): boolean {
  return body.trim().length > 0 && body.trim().length <= 220;
}

function countQuestionMarks(body: string): number {
  const matches = body.match(/\?/g);
  return matches ? matches.length : 0;
}

function isSingleAskOpening(body: string): boolean {
  const questionCount = countQuestionMarks(body);
  if (questionCount === 1) return true;
  if (questionCount >= 2) return false;
  const normalized = body.toLowerCase();
  const askHits = [
    "can you",
    "could you",
    "send over",
    "send a",
    "text me",
    "let me know",
    "what zip",
    "what day",
  ].filter((phrase) => normalized.includes(phrase)).length;
  return askHits === 1;
}

function isPhotoAskOpening(body: string): boolean {
  const normalized = body.toLowerCase();
  return /\b(photo|photos|picture|pictures|pic|pics|video|walkthrough)\b/.test(normalized);
}

function isBookingAskOpening(body: string): boolean {
  const normalized = body.toLowerCase();
  return /\b(book|schedule|get (you )?on the schedule|lock (it )?in|set up (a |the )?(time|appointment))\b/.test(
    normalized,
  );
}

function shouldKeepShort(summary: FirstResponseOutcomeSlice): boolean {
  const short = summary.byStyle.short;
  const long = summary.byStyle.long;
  if (short.attempts < 5) return false;
  if (long.attempts < 3) return short.replyRate > 0;
  return short.replyRate >= long.replyRate + 0.05;
}

function shouldKeepSingleAsk(summary: FirstResponseOutcomeSlice): boolean {
  const singleAsk = summary.byStyle.single_ask;
  const multiAsk = summary.byStyle.multi_ask;
  if (singleAsk.attempts < 5) return false;
  if (multiAsk.attempts < 3) return singleAsk.replyRate > 0;
  return singleAsk.replyRate >= multiAsk.replyRate + 0.05;
}

function shouldOpenWithPhotoAsk(summary: FirstResponseOutcomeSlice): boolean {
  const photoAsk = summary.byStyle.photo_ask;
  const noPhotoAskAttempts = Math.max(0, summary.attempts - photoAsk.attempts);
  const noPhotoAskReplied = Math.max(0, summary.replied - photoAsk.replied);
  const noPhotoAskBooked = Math.max(0, summary.booked - photoAsk.booked);
  const noPhotoAskReplyRate = toRate(noPhotoAskReplied, noPhotoAskAttempts);
  const noPhotoAskBookRate = toRate(noPhotoAskBooked, noPhotoAskAttempts);
  if (photoAsk.attempts < 5) return false;
  if (noPhotoAskAttempts < 3) return photoAsk.replyRate > 0;
  return (
    photoAsk.replyRate >= noPhotoAskReplyRate + 0.05 ||
    (photoAsk.replyRate >= noPhotoAskReplyRate && photoAsk.bookRate >= noPhotoAskBookRate + 0.03)
  );
}

function shouldAvoidHardBookingAsk(summary: FirstResponseOutcomeSlice): boolean {
  const bookingAsk = summary.byStyle.booking_ask;
  const noBookingAskAttempts = Math.max(0, summary.attempts - bookingAsk.attempts);
  const noBookingAskReplied = Math.max(0, summary.replied - bookingAsk.replied);
  const noBookingAskBooked = Math.max(0, summary.booked - bookingAsk.booked);
  const noBookingAskReplyRate = toRate(noBookingAskReplied, noBookingAskAttempts);
  const noBookingAskBookRate = toRate(noBookingAskBooked, noBookingAskAttempts);
  if (bookingAsk.attempts < 5) return false;
  if (noBookingAskAttempts < 3) return bookingAsk.replyRate < 0.15;
  return (
    bookingAsk.replyRate + 0.05 <= noBookingAskReplyRate ||
    bookingAsk.bookRate + 0.03 <= noBookingAskBookRate
  );
}

function buildSlice(rows: FirstResponseOutcomeRow[]): FirstResponseOutcomeSlice {
  const replied = rows.filter((row) => row.replied).length;
  const booked = rows.filter((row) => row.booked).length;
  const slice: FirstResponseOutcomeSlice = {
    attempts: rows.length,
    replied,
    replyRate: toRate(replied, rows.length),
    booked,
    bookRate: toRate(booked, rows.length),
    byChannel: {
      sms: summarizeBucket(rows.filter((row) => row.channel === "sms")),
      dm: summarizeBucket(rows.filter((row) => row.channel === "dm")),
      email: summarizeBucket(rows.filter((row) => row.channel === "email")),
    },
    byTiming: {
      fast: summarizeBucket(rows.filter((row) => getTimingBucket(row) === "fast")),
      delayed: summarizeBucket(rows.filter((row) => getTimingBucket(row) === "delayed")),
    },
    byStyle: {
      short: summarizeBucket(rows.filter((row) => isShortOpening(row.body))),
      long: summarizeBucket(rows.filter((row) => !isShortOpening(row.body))),
      single_ask: summarizeBucket(rows.filter((row) => isSingleAskOpening(row.body))),
      multi_ask: summarizeBucket(rows.filter((row) => !isSingleAskOpening(row.body))),
      photo_ask: summarizeBucket(rows.filter((row) => isPhotoAskOpening(row.body))),
      booking_ask: summarizeBucket(rows.filter((row) => isBookingAskOpening(row.body))),
    },
    learned: {
      preferredChannel: null,
      preferFast: false,
      keepShort: false,
      keepSingleAsk: false,
      openWithPhotoAsk: false,
      avoidHardBookingAsk: false,
    },
  };
  slice.learned.preferredChannel = getPreferredChannel(slice);
  slice.learned.preferFast = shouldPreferFast(slice);
  slice.learned.keepShort = shouldKeepShort(slice);
  slice.learned.keepSingleAsk = shouldKeepSingleAsk(slice);
  slice.learned.openWithPhotoAsk = shouldOpenWithPhotoAsk(slice);
  slice.learned.avoidHardBookingAsk = shouldAvoidHardBookingAsk(slice);
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

function emptySlice(): FirstResponseOutcomeSlice {
  return buildSlice([]);
}

function resolveScopedSummary(
  summary: FirstResponseOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): FirstResponseOutcomeSlice {
  if (!summary) return emptySlice();
  if (scope?.serviceFamily && summary.byServiceFamily[scope.serviceFamily].attempts >= 4) {
    return summary.byServiceFamily[scope.serviceFamily];
  }
  if (scope?.sourceFamily && summary.bySourceFamily[scope.sourceFamily].attempts >= 4) {
    return summary.bySourceFamily[scope.sourceFamily];
  }
  return summary;
}

export async function loadFirstResponseOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<FirstResponseOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const touchAtExpr = sql<Date>`coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt})`;

  const rows = await db
    .select({
      leadId: leads.id,
      leadCreatedAt: leads.createdAt,
      channel: sql<ResponseChannel>`${conversationMessages.channel}`,
      touchAt: touchAtExpr,
      body: sql<string>`coalesce(${conversationMessages.body}, '')`,
      replied: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          where inbound.thread_id = ${conversationMessages.threadId}
            and inbound.direction = 'inbound'
            and coalesce(inbound.received_at, inbound.created_at) > ${touchAtExpr}
            and coalesce(inbound.received_at, inbound.created_at) <= ${touchAtExpr} + interval '24 hours'
        )
      `,
      booked: sql<boolean>`
        exists(
          select 1
          from ${appointments} appt
          where appt.contact_id = ${leads.contactId}
            and appt.status <> 'canceled'
            and appt.created_at >= ${touchAtExpr}
            and appt.created_at <= ${touchAtExpr} + interval '14 days'
        )
      `,
      leadSource: leads.source,
      leadServices: leads.servicesRequested,
    })
    .from(leads)
    .innerJoin(conversationThreads, eq(conversationThreads.contactId, leads.contactId))
    .innerJoin(conversationMessages, eq(conversationMessages.threadId, conversationThreads.id))
    .where(
      and(
        gte(leads.createdAt, windowStart),
        eq(conversationMessages.direction, "outbound"),
        inArray(conversationMessages.channel, ["sms", "dm", "email"]),
        sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') <> 'true'`,
        sql`${touchAtExpr} >= ${leads.createdAt}`,
        sql`${touchAtExpr} <= ${leads.createdAt} + interval '24 hours'`,
      ),
    )
    .orderBy(asc(leads.id), asc(touchAtExpr));

  const deduped = dedupeFirstTouches(
    rows.map((row) => ({
      leadId: row.leadId,
      leadCreatedAt: row.leadCreatedAt,
      channel: row.channel,
      touchAt: row.touchAt,
      body: row.body,
      replied: row.replied,
      booked: row.booked,
      serviceFamily: classifyServiceFamily(
        (Array.isArray(row.leadServices) ? row.leadServices : []).filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        ),
      ),
      sourceFamily: classifySourceFamily(row.leadSource ?? null),
    })),
  );

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

export function getPreferredFirstResponseChannel(
  summary: FirstResponseOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): "sms" | "dm" | null {
  return resolveScopedSummary(summary, scope).learned.preferredChannel;
}

export function shouldPreferFastFirstResponse(
  summary: FirstResponseOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.preferFast;
}

export function shouldKeepFirstResponseShort(
  summary: FirstResponseOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.keepShort;
}

export function shouldKeepFirstResponseSingleAsk(
  summary: FirstResponseOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.keepSingleAsk;
}

export function shouldOpenFirstResponseWithPhotoAsk(
  summary: FirstResponseOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.openWithPhotoAsk;
}

export function shouldAvoidHardBookingAskInFirstResponse(
  summary: FirstResponseOutcomeSummary | null | undefined,
  scope?: QuoteFollowupLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.avoidHardBookingAsk;
}

export function getFirstResponseLearningScope(input: {
  latestLeadSource?: string | null;
  contactSource?: string | null;
  dmEntrySource?: "facebook_ad_lead" | "organic_messenger" | "unknown" | null;
  latestLeadServices?: string[] | null;
}): QuoteFollowupLearningScope {
  return getQuoteFollowupLearningScope({
    latestLeadSource: input.latestLeadSource,
    contactSource: input.contactSource,
    dmEntrySource: input.dmEntrySource,
    latestLeadServices: input.latestLeadServices,
    instantQuoteJobTypes: [],
  });
}
