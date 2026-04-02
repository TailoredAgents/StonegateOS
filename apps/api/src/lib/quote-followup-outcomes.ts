import { conversationMessages, conversationThreads, getDb, instantQuotes, leads } from "@/db";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;

type FollowupChannel = "sms" | "dm" | "email";
type TimingBucket = "fast" | "delayed";

type QuoteFollowupOutcomeRow = {
  quoteId: string;
  quoteCreatedAt: Date;
  channel: FollowupChannel;
  touchAt: Date;
  hasBookedAppointment: boolean;
};

type OutcomeBucket = {
  quotes: number;
  bookedQuotes: number;
  bookRate: number;
};

export type QuoteFollowupOutcomeSummary = {
  windowStart: string;
  quotesWithFollowup: number;
  bookedQuotes: number;
  byChannel: Record<FollowupChannel, OutcomeBucket>;
  byTiming: Record<TimingBucket, OutcomeBucket>;
  learned: {
    preferredChannel: "sms" | "dm" | null;
    preferFast: boolean;
  };
};

function toRate(booked: number, total: number): number {
  return total > 0 ? Number((booked / total).toFixed(4)) : 0;
}

function emptyBucket(): OutcomeBucket {
  return { quotes: 0, bookedQuotes: 0, bookRate: 0 };
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

function getPreferredChannel(
  summary: QuoteFollowupOutcomeSummary,
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

function shouldPreferFast(summary: QuoteFollowupOutcomeSummary): boolean {
  const fast = summary.byTiming.fast;
  const delayed = summary.byTiming.delayed;
  if (fast.quotes < 5) return false;
  if (delayed.quotes < 3) return fast.bookRate > 0;
  return fast.bookRate >= delayed.bookRate + 0.05;
}

function buildSummary(rows: QuoteFollowupOutcomeRow[], windowStart: Date): QuoteFollowupOutcomeSummary {
  const deduped = dedupeFirstFollowups(rows);
  const smsRows = deduped.filter((row) => row.channel === "sms");
  const dmRows = deduped.filter((row) => row.channel === "dm");
  const emailRows = deduped.filter((row) => row.channel === "email");
  const fastRows = deduped.filter((row) => getTimingBucket(row) === "fast");
  const delayedRows = deduped.filter((row) => getTimingBucket(row) === "delayed");
  const bookedQuotes = deduped.filter((row) => row.hasBookedAppointment).length;

  const summary: QuoteFollowupOutcomeSummary = {
    windowStart: windowStart.toISOString(),
    quotesWithFollowup: deduped.length,
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
    learned: {
      preferredChannel: null,
      preferFast: false,
    },
  };

  summary.learned.preferredChannel = getPreferredChannel(summary);
  summary.learned.preferFast = shouldPreferFast(summary);
  return summary;
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

  return buildSummary(rows, windowStart);
}

export function getPreferredQuoteFollowupChannel(
  summary: QuoteFollowupOutcomeSummary | null | undefined,
): "sms" | "dm" | null {
  return summary?.learned.preferredChannel ?? null;
}

export function shouldPreferFastQuoteFollowup(
  summary: QuoteFollowupOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.preferFast === true;
}
