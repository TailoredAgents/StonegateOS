import { appointments, conversationMessages, conversationThreads, getDb } from "@/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;

export type ChannelHandoffOutcomeSummary = {
  windowStart: string;
  attempts: number;
  reopened: number;
  reopenRate: number;
  transitionedToSms: number;
  smsTransitionRate: number;
  stayedInDm: number;
  stayDmRate: number;
  booked: number;
  bookRate: number;
  learned: {
    worthHandoff: boolean;
    keepLighter: boolean;
    smsTransitionHealthy: boolean;
  };
};

type ChannelHandoffOutcomeRow = {
  reopened: boolean;
  transitionedToSms: boolean;
  stayedInDm: boolean;
  booked: boolean;
};

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarize(rows: ChannelHandoffOutcomeRow[]): Omit<ChannelHandoffOutcomeSummary, "windowStart"> {
  const attempts = rows.length;
  const reopened = rows.filter((row) => row.reopened).length;
  const transitionedToSms = rows.filter((row) => row.transitionedToSms).length;
  const stayedInDm = rows.filter((row) => row.stayedInDm).length;
  const booked = rows.filter((row) => row.booked).length;

  const reopenRate = toRate(reopened, attempts);
  const smsTransitionRate = toRate(transitionedToSms, attempts);
  const stayDmRate = toRate(stayedInDm, attempts);
  const bookRate = toRate(booked, attempts);

  return {
    attempts,
    reopened,
    reopenRate,
    transitionedToSms,
    smsTransitionRate,
    stayedInDm,
    stayDmRate,
    booked,
    bookRate,
    learned: {
      worthHandoff: attempts < 6 || smsTransitionRate >= 0.15 || bookRate >= 0.05,
      keepLighter: attempts >= 6 && smsTransitionRate < 0.12 && reopenRate < 0.2,
      smsTransitionHealthy: attempts >= 5 && smsTransitionRate >= 0.15 && smsTransitionRate >= stayDmRate,
    },
  };
}

export async function loadChannelHandoffOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<ChannelHandoffOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const sentAtExpr = sql<Date>`coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt})`;
  const inboundAtExpr = sql<Date>`coalesce(inbound.received_at, inbound.created_at)`;
  const meaningfulReplyExpr = sql<boolean>`
    coalesce(array_length(inbound.media_urls, 1), 0) > 0
    or length(trim(coalesce(inbound.body, ''))) >= 4
  `;

  const rows = await db
    .select({
      reopened: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          inner join ${conversationThreads} inbound_thread on inbound.thread_id = inbound_thread.id
          where inbound_thread.contact_id = ${conversationThreads.contactId}
            and inbound.direction = 'inbound'
            and ${inboundAtExpr} > ${sentAtExpr}
            and ${inboundAtExpr} <= ${sentAtExpr} + interval '72 hours'
            and ${meaningfulReplyExpr}
        )
      `,
      transitionedToSms: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          inner join ${conversationThreads} inbound_thread on inbound.thread_id = inbound_thread.id
          where inbound_thread.contact_id = ${conversationThreads.contactId}
            and inbound.channel = 'sms'
            and inbound.direction = 'inbound'
            and ${inboundAtExpr} > ${sentAtExpr}
            and ${inboundAtExpr} <= ${sentAtExpr} + interval '72 hours'
            and ${meaningfulReplyExpr}
        )
      `,
      stayedInDm: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          inner join ${conversationThreads} inbound_thread on inbound.thread_id = inbound_thread.id
          where inbound_thread.contact_id = ${conversationThreads.contactId}
            and inbound.channel = 'dm'
            and inbound.direction = 'inbound'
            and ${inboundAtExpr} > ${sentAtExpr}
            and ${inboundAtExpr} <= ${sentAtExpr} + interval '72 hours'
            and ${meaningfulReplyExpr}
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
        eq(conversationMessages.channel, "sms"),
        sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') <> 'true'`,
        sql`coalesce(${conversationMessages.metadata} ->> 'aiPlannerActionType', '') = 'dm_sms_handoff'`,
      ),
    )
    .orderBy(desc(sentAtExpr))
    .limit(1000);

  return {
    windowStart: windowStart.toISOString(),
    ...summarize(rows),
  };
}

export function isDmSmsHandoffWorthwhile(
  summary: ChannelHandoffOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.worthHandoff !== false;
}

export function shouldKeepDmSmsHandoffLight(
  summary: ChannelHandoffOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.keepLighter === true;
}

export function isDmSmsTransitionHealthy(
  summary: ChannelHandoffOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.smsTransitionHealthy === true;
}
