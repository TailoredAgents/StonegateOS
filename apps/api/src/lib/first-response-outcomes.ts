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

type FirstResponseOutcomeRow = {
  leadId: string;
  leadCreatedAt: Date;
  channel: ResponseChannel;
  touchAt: Date;
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
  learned: {
    preferredChannel: "sms" | "dm" | null;
    preferFast: boolean;
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
    learned: {
      preferredChannel: null,
      preferFast: false,
    },
  };
  slice.learned.preferredChannel = getPreferredChannel(slice);
  slice.learned.preferFast = shouldPreferFast(slice);
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
