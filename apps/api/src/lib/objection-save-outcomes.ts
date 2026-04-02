import { appointments, conversationMessages, conversationThreads, getDb } from "@/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type ObjectionChannel = "sms" | "dm" | "email";

type OutcomeBucket = {
  attempts: number;
  reopened: number;
  reopenRate: number;
  booked: number;
  bookRate: number;
};

export type ObjectionSaveOutcomeSummary = {
  windowStart: string;
  attempts: number;
  reopened: number;
  reopenRate: number;
  booked: number;
  bookRate: number;
  byChannel: Record<ObjectionChannel, OutcomeBucket>;
  learned: {
    preferredChannel: "sms" | "dm" | null;
    keepSofter: boolean;
  };
};

type ObjectionOutcomeRow = {
  channel: ObjectionChannel;
  reopened: boolean;
  booked: boolean;
};

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarize(rows: ObjectionOutcomeRow[]): OutcomeBucket {
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

function getPreferredChannel(
  summary: ObjectionSaveOutcomeSummary,
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

function shouldKeepSofter(summary: ObjectionSaveOutcomeSummary): boolean {
  if (summary.attempts < 6) return false;
  return summary.reopenRate < 0.25;
}

export async function loadObjectionSaveOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<ObjectionSaveOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const sentAtExpr = sql<Date>`coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt})`;

  const rows = await db
    .select({
      channel: sql<ObjectionChannel>`${conversationMessages.channel}`,
      reopened: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          where inbound.thread_id = ${conversationMessages.threadId}
            and inbound.direction = 'inbound'
            and coalesce(inbound.received_at, inbound.created_at) > ${sentAtExpr}
            and coalesce(inbound.received_at, inbound.created_at) <= ${sentAtExpr} + interval '48 hours'
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
        sql`coalesce(${conversationMessages.metadata} ->> 'aiPlannerActionType', '') = 'handle_price_objection'`,
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

  const summary: ObjectionSaveOutcomeSummary = {
    windowStart: windowStart.toISOString(),
    attempts: overall.attempts,
    reopened: overall.reopened,
    reopenRate: overall.reopenRate,
    booked: overall.booked,
    bookRate: overall.bookRate,
    byChannel,
    learned: {
      preferredChannel: null,
      keepSofter: false,
    },
  };

  summary.learned.preferredChannel = getPreferredChannel(summary);
  summary.learned.keepSofter = shouldKeepSofter(summary);
  return summary;
}

export function getPreferredObjectionSaveChannel(
  summary: ObjectionSaveOutcomeSummary | null | undefined,
): "sms" | "dm" | null {
  return summary?.learned.preferredChannel ?? null;
}

export function shouldUseSofterObjectionSave(
  summary: ObjectionSaveOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.keepSofter === true;
}
