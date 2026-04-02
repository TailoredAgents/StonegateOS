import { appointments, conversationMessages, conversationThreads, getDb } from "@/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type ReactivationChannel = "sms" | "dm" | "email";
type DormancyBucket = "day_1_3" | "day_3_plus";

type OutcomeBucket = {
  attempts: number;
  reopened: number;
  reopenRate: number;
  booked: number;
  bookRate: number;
};

export type ReactivationOutcomeSummary = {
  windowStart: string;
  attempts: number;
  reopened: number;
  reopenRate: number;
  booked: number;
  bookRate: number;
  byChannel: Record<ReactivationChannel, OutcomeBucket>;
  byDormancy: Record<DormancyBucket, OutcomeBucket>;
  learned: {
    preferredChannel: "sms" | "dm" | null;
    keepSofter: boolean;
    worthReactivating: boolean;
  };
};

type ReactivationOutcomeRow = {
  channel: ReactivationChannel;
  reopened: boolean;
  booked: boolean;
  dormancyHours: number;
};

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarize(rows: ReactivationOutcomeRow[]): OutcomeBucket {
  const attempts = rows.length;
  const reopened = rows.filter((row) => row.reopened).length;
  const booked = rows.filter((row) => row.booked).length;
  return {
    attempts,
    reopened,
    reopenRate: toRate(reopened, attempts),
    booked,
    bookRate: toRate(booked, attempts),
  };
}

function getDormancyBucket(row: ReactivationOutcomeRow): DormancyBucket {
  return row.dormancyHours >= 72 ? "day_3_plus" : "day_1_3";
}

function getPreferredChannel(
  summary: ReactivationOutcomeSummary,
): "sms" | "dm" | null {
  const sms = summary.byChannel.sms;
  const dm = summary.byChannel.dm;
  if (sms.attempts >= 4 && (dm.attempts < 3 || sms.reopenRate >= dm.reopenRate + 0.05)) {
    return "sms";
  }
  if (dm.attempts >= 4 && (sms.attempts < 3 || dm.reopenRate >= sms.reopenRate + 0.05)) {
    return "dm";
  }
  return null;
}

function shouldKeepSofter(summary: ReactivationOutcomeSummary): boolean {
  if (summary.attempts < 6) return false;
  return summary.reopenRate < 0.2;
}

function isWorthReactivating(summary: ReactivationOutcomeSummary): boolean {
  if (summary.attempts < 6) return true;
  return summary.reopenRate >= 0.18 || summary.bookRate >= 0.06;
}

export async function loadReactivationOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<ReactivationOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const sentAtExpr = sql<Date>`coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt})`;
  const priorInboundAtExpr = sql<Date | null>`(
    select max(coalesce(inbound.received_at, inbound.created_at))
    from ${conversationMessages} inbound
    where inbound.thread_id = ${conversationMessages.threadId}
      and inbound.direction = 'inbound'
      and coalesce(inbound.received_at, inbound.created_at) < ${sentAtExpr}
  )`;
  const inboundAtExpr = sql<Date>`coalesce(inbound.received_at, inbound.created_at)`;
  const meaningfulReplyExpr = sql<boolean>`
    coalesce(array_length(inbound.media_urls, 1), 0) > 0
    or length(trim(coalesce(inbound.body, ''))) >= 4
  `;

  const rows = await db
    .select({
      channel: sql<ReactivationChannel>`${conversationMessages.channel}`,
      dormancyHours: sql<number>`extract(epoch from (${sentAtExpr} - ${priorInboundAtExpr})) / 3600.0`,
      reopened: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          where inbound.thread_id = ${conversationMessages.threadId}
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
        inArray(conversationMessages.channel, ["sms", "dm", "email"]),
        sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') <> 'true'`,
        sql`(
          coalesce(${conversationMessages.metadata} ->> 'aiPlannerActionType', '') = 'follow_up_quote'
          or coalesce(${conversationMessages.metadata} ->> 'followup', 'false') = 'true'
        )`,
        sql`${priorInboundAtExpr} is not null`,
        sql`${sentAtExpr} >= ${priorInboundAtExpr} + interval '24 hours'`,
        sql`not exists(
          select 1
          from ${appointments} appt_before
          where appt_before.contact_id = ${conversationThreads.contactId}
            and appt_before.status <> 'canceled'
            and appt_before.created_at < ${sentAtExpr}
        )`,
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
  const byDormancy = {
    day_1_3: summarize(rows.filter((row) => getDormancyBucket(row) === "day_1_3")),
    day_3_plus: summarize(rows.filter((row) => getDormancyBucket(row) === "day_3_plus")),
  };

  const summary: ReactivationOutcomeSummary = {
    windowStart: windowStart.toISOString(),
    attempts: overall.attempts,
    reopened: overall.reopened,
    reopenRate: overall.reopenRate,
    booked: overall.booked,
    bookRate: overall.bookRate,
    byChannel,
    byDormancy,
    learned: {
      preferredChannel: null,
      keepSofter: false,
      worthReactivating: true,
    },
  };

  summary.learned.preferredChannel = getPreferredChannel(summary);
  summary.learned.keepSofter = shouldKeepSofter(summary);
  summary.learned.worthReactivating = isWorthReactivating(summary);
  return summary;
}

export function getPreferredReactivationChannel(
  summary: ReactivationOutcomeSummary | null | undefined,
): "sms" | "dm" | null {
  return summary?.learned.preferredChannel ?? null;
}

export function shouldUseSofterReactivation(
  summary: ReactivationOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.keepSofter === true;
}

export function isReactivationWorthwhile(
  summary: ReactivationOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.worthReactivating !== false;
}
