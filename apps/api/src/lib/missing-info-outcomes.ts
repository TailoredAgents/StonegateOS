import { appointments, conversationMessages, conversationThreads, getDb } from "@/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type MissingInfoChannel = "sms" | "dm" | "email";

type OutcomeBucket = {
  attempts: number;
  resolved: number;
  resolutionRate: number;
  resolvedWithMedia: number;
  mediaResolutionRate: number;
  resolvedWithText: number;
  textResolutionRate: number;
  booked: number;
  bookRate: number;
};

export type MissingInfoOutcomeSummary = {
  windowStart: string;
  attempts: number;
  resolved: number;
  resolutionRate: number;
  resolvedWithMedia: number;
  mediaResolutionRate: number;
  resolvedWithText: number;
  textResolutionRate: number;
  booked: number;
  bookRate: number;
  byChannel: Record<MissingInfoChannel, OutcomeBucket>;
  learned: {
    preferredChannel: "sms" | "dm" | null;
    keepSingleAsk: boolean;
    leanIntoRequests: boolean;
  };
};

type MissingInfoOutcomeRow = {
  channel: MissingInfoChannel;
  resolved: boolean;
  resolvedWithMedia: boolean;
  booked: boolean;
};

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarize(rows: MissingInfoOutcomeRow[]): OutcomeBucket {
  const attempts = rows.length;
  const resolved = rows.filter((row) => row.resolved).length;
  const resolvedWithMedia = rows.filter((row) => row.resolvedWithMedia).length;
  const resolvedWithText = Math.max(0, resolved - resolvedWithMedia);
  const booked = rows.filter((row) => row.booked).length;
  return {
    attempts,
    resolved,
    resolutionRate: toRate(resolved, attempts),
    resolvedWithMedia,
    mediaResolutionRate: toRate(resolvedWithMedia, attempts),
    resolvedWithText,
    textResolutionRate: toRate(resolvedWithText, attempts),
    booked,
    bookRate: toRate(booked, attempts),
  };
}

function getPreferredChannel(
  summary: MissingInfoOutcomeSummary,
): "sms" | "dm" | null {
  const sms = summary.byChannel.sms;
  const dm = summary.byChannel.dm;
  if (sms.attempts >= 4 && (dm.attempts < 3 || sms.resolutionRate >= dm.resolutionRate + 0.05)) {
    return "sms";
  }
  if (dm.attempts >= 4 && (sms.attempts < 3 || dm.resolutionRate >= sms.resolutionRate + 0.05)) {
    return "dm";
  }
  return null;
}

function shouldKeepSingleAsk(summary: MissingInfoOutcomeSummary): boolean {
  if (summary.attempts < 6) return false;
  return summary.resolutionRate < 0.35;
}

function shouldLeanIntoRequests(summary: MissingInfoOutcomeSummary): boolean {
  if (summary.attempts < 6) return false;
  return summary.resolutionRate >= 0.3 || summary.bookRate >= 0.12;
}

export async function loadMissingInfoOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<MissingInfoOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const sentAtExpr = sql<Date>`coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt})`;
  const inboundAtExpr = sql<Date>`coalesce(inbound.received_at, inbound.created_at)`;
  const meaningfulReplyExpr = sql<boolean>`
    coalesce(array_length(inbound.media_urls, 1), 0) > 0
    or length(trim(coalesce(inbound.body, ''))) >= 4
  `;

  const rows = await db
    .select({
      channel: sql<MissingInfoChannel>`${conversationMessages.channel}`,
      resolved: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          where inbound.thread_id = ${conversationMessages.threadId}
            and inbound.direction = 'inbound'
            and ${inboundAtExpr} > ${sentAtExpr}
            and ${inboundAtExpr} <= ${sentAtExpr} + interval '48 hours'
            and ${meaningfulReplyExpr}
        )
      `,
      resolvedWithMedia: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          where inbound.thread_id = ${conversationMessages.threadId}
            and inbound.direction = 'inbound'
            and ${inboundAtExpr} > ${sentAtExpr}
            and ${inboundAtExpr} <= ${sentAtExpr} + interval '48 hours'
            and coalesce(array_length(inbound.media_urls, 1), 0) > 0
        )
      `,
      booked: sql<boolean>`
        exists(
          select 1
          from ${appointments} appt
          where appt.contact_id = ${conversationThreads.contactId}
            and appt.status <> 'canceled'
            and appt.created_at >= ${sentAtExpr}
            and appt.created_at <= ${sentAtExpr} + interval '14 days'
        )
      `,
    })
    .from(conversationMessages)
    .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .where(
      and(
        gte(conversationMessages.createdAt, windowStart),
        eq(conversationMessages.direction, "outbound"),
        inArray(conversationMessages.channel, ["sms", "dm", "email"]),
        sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') <> 'true'`,
        sql`coalesce(${conversationMessages.metadata} ->> 'aiPlannerActionType', '') = 'collect_missing_info'`,
      ),
    )
    .orderBy(desc(sentAtExpr))
    .limit(1000);

  const overall = summarize(rows);
  const byChannel = {
    sms: summarize(rows.filter((row) => row.channel === "sms")),
    dm: summarize(rows.filter((row) => row.channel === "dm")),
    email: summarize(rows.filter((row) => row.channel === "email")),
  };

  const summary: MissingInfoOutcomeSummary = {
    windowStart: windowStart.toISOString(),
    attempts: overall.attempts,
    resolved: overall.resolved,
    resolutionRate: overall.resolutionRate,
    resolvedWithMedia: overall.resolvedWithMedia,
    mediaResolutionRate: overall.mediaResolutionRate,
    resolvedWithText: overall.resolvedWithText,
    textResolutionRate: overall.textResolutionRate,
    booked: overall.booked,
    bookRate: overall.bookRate,
    byChannel,
    learned: {
      preferredChannel: null,
      keepSingleAsk: false,
      leanIntoRequests: false,
    },
  };

  summary.learned.preferredChannel = getPreferredChannel(summary);
  summary.learned.keepSingleAsk = shouldKeepSingleAsk(summary);
  summary.learned.leanIntoRequests = shouldLeanIntoRequests(summary);
  return summary;
}

export function getPreferredMissingInfoChannel(
  summary: MissingInfoOutcomeSummary | null | undefined,
): "sms" | "dm" | null {
  return summary?.learned.preferredChannel ?? null;
}

export function shouldKeepSingleMissingInfoAsk(
  summary: MissingInfoOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.keepSingleAsk === true;
}

export function shouldLeanIntoMissingInfoRequests(
  summary: MissingInfoOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.leanIntoRequests === true;
}
