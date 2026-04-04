import { appointments, auditLogs, conversationMessages, conversationThreads, getDb } from "@/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type CloseChannel = "sms" | "dm" | "email";

type OutcomeBucket = {
  attempts: number;
  booked: number;
  bookRate: number;
  lost: number;
  lostRate: number;
};

export type QuoteCloseOutcomeSummary = {
  windowStart: string;
  attempts: number;
  booked: number;
  bookRate: number;
  lost: number;
  lostRate: number;
  byChannel: Record<CloseChannel, OutcomeBucket>;
  learned: {
    preferredChannel: "sms" | "dm" | null;
    keepSofter: boolean;
  };
};

type QuoteCloseOutcomeRow = {
  channel: CloseChannel;
  booked: boolean;
  lost: boolean;
};

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarize(rows: QuoteCloseOutcomeRow[]): OutcomeBucket {
  const attempts = rows.length;
  const booked = rows.filter((row) => row.booked).length;
  const lost = rows.filter((row) => row.lost).length;
  return {
    attempts,
    booked,
    bookRate: toRate(booked, attempts),
    lost,
    lostRate: toRate(lost, attempts),
  };
}

function getPreferredChannel(
  summary: QuoteCloseOutcomeSummary,
): "sms" | "dm" | null {
  const sms = summary.byChannel.sms;
  const dm = summary.byChannel.dm;
  if (sms.attempts >= 4 && (dm.attempts < 3 || sms.bookRate >= dm.bookRate + 0.05)) {
    return "sms";
  }
  if (dm.attempts >= 4 && (sms.attempts < 3 || dm.bookRate >= sms.bookRate + 0.05)) {
    return "dm";
  }
  return null;
}

function shouldKeepSofter(summary: QuoteCloseOutcomeSummary): boolean {
  if (summary.attempts < 6) return false;
  return summary.bookRate < 0.1 || summary.lostRate >= summary.bookRate;
}

export async function loadQuoteCloseOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<QuoteCloseOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const sentAtExpr = sql<Date>`coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt})`;

  const rows = await db
    .select({
      channel: sql<CloseChannel>`${conversationMessages.channel}`,
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
      lost: sql<boolean>`
        exists(
          select 1
          from ${auditLogs} audit
          where audit.entity_type = 'contact'
            and audit.entity_id = ${conversationThreads.contactId}::text
            and audit.action = 'sales.disposition.set'
            and coalesce(audit.meta ->> 'markLost', 'false') = 'true'
            and audit.created_at >= ${sentAtExpr}
            and audit.created_at <= ${sentAtExpr} + interval '14 days'
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
        sql`coalesce(${conversationMessages.metadata} ->> 'aiPlannerActionType', '') = 'follow_up_quote'`,
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

  const summary: QuoteCloseOutcomeSummary = {
    windowStart: windowStart.toISOString(),
    attempts: overall.attempts,
    booked: overall.booked,
    bookRate: overall.bookRate,
    lost: overall.lost,
    lostRate: overall.lostRate,
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

export function getPreferredQuoteCloseChannel(
  summary: QuoteCloseOutcomeSummary | null | undefined,
): "sms" | "dm" | null {
  return summary?.learned.preferredChannel ?? null;
}

export function shouldUseSofterQuoteClose(
  summary: QuoteCloseOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.keepSofter === true;
}
