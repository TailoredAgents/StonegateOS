import { appointments, conversationMessages, conversationThreads, getDb } from "@/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type ObjectionChannel = "sms" | "dm" | "email";
type ObjectionType = "price" | "comparison_shopping" | "decision_maker" | "timing";

type OutcomeBucket = {
  attempts: number;
  reopened: number;
  reopenRate: number;
  booked: number;
  bookRate: number;
};

type ObjectionOutcomeSlice = {
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

export type ObjectionSaveLearningScope = {
  objectionType?: ObjectionType | null;
};

export type ObjectionSaveOutcomeSummary = ObjectionOutcomeSlice & {
  windowStart: string;
  byType: Record<ObjectionType, ObjectionOutcomeSlice>;
};

type ObjectionOutcomeRow = {
  channel: ObjectionChannel;
  objectionType: ObjectionType;
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
  summary: ObjectionOutcomeSlice,
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

function shouldKeepSofter(summary: ObjectionOutcomeSlice): boolean {
  if (summary.attempts < 6) return false;
  return summary.reopenRate < 0.25;
}

function buildSlice(rows: ObjectionOutcomeRow[]): ObjectionOutcomeSlice {
  const overall = summarize(rows);
  const slice: ObjectionOutcomeSlice = {
    attempts: overall.attempts,
    reopened: overall.reopened,
    reopenRate: overall.reopenRate,
    booked: overall.booked,
    bookRate: overall.bookRate,
    byChannel: {
      sms: summarize(rows.filter((row) => row.channel === "sms")),
      dm: summarize(rows.filter((row) => row.channel === "dm")),
      email: summarize(rows.filter((row) => row.channel === "email")),
    },
    learned: {
      preferredChannel: null,
      keepSofter: false,
    },
  };
  slice.learned.preferredChannel = getPreferredChannel(slice);
  slice.learned.keepSofter = shouldKeepSofter(slice);
  return slice;
}

function emptySlice(): ObjectionOutcomeSlice {
  return buildSlice([]);
}

function resolveScopedSummary(
  summary: ObjectionSaveOutcomeSummary | null | undefined,
  scope?: ObjectionSaveLearningScope | null,
): ObjectionOutcomeSlice {
  if (!summary) return emptySlice();
  if (scope?.objectionType && summary.byType[scope.objectionType].attempts >= 4) {
    return summary.byType[scope.objectionType];
  }
  return summary;
}

export function getObjectionSaveLearningScope(input: {
  objections?: string[] | null;
}): ObjectionSaveLearningScope {
  const objections = new Set(
    (Array.isArray(input.objections) ? input.objections : []).filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    ),
  );
  if (objections.has("comparison_shopping")) return { objectionType: "comparison_shopping" };
  if (objections.has("decision_maker")) return { objectionType: "decision_maker" };
  if (objections.has("timing")) return { objectionType: "timing" };
  if (objections.has("price")) return { objectionType: "price" };
  return { objectionType: null };
}

function classifyObjectionType(input: {
  comparisonShopping: boolean;
  decisionMaker: boolean;
  timing: boolean;
}): ObjectionType {
  if (input.comparisonShopping) return "comparison_shopping";
  if (input.decisionMaker) return "decision_maker";
  if (input.timing) return "timing";
  return "price";
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
      comparisonShopping: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          where inbound.thread_id = ${conversationMessages.threadId}
            and inbound.direction = 'inbound'
            and coalesce(inbound.received_at, inbound.created_at) <= ${sentAtExpr}
            and coalesce(inbound.received_at, inbound.created_at) >= ${sentAtExpr} - interval '7 days'
            and lower(coalesce(inbound.body, '')) ~ '(shopping around|other companies|another company|another quote|other quote|comparing quotes|someone else)'
        )
      `,
      decisionMaker: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          where inbound.thread_id = ${conversationMessages.threadId}
            and inbound.direction = 'inbound'
            and coalesce(inbound.received_at, inbound.created_at) <= ${sentAtExpr}
            and coalesce(inbound.received_at, inbound.created_at) >= ${sentAtExpr} - interval '7 days'
            and lower(coalesce(inbound.body, '')) ~ '(need to talk to|need to check with|check with|ask my husband|ask my wife|ask my partner|talk to my partner|talk to the homeowner|check with the owner|landlord|owner)'
        )
      `,
      timing: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          where inbound.thread_id = ${conversationMessages.threadId}
            and inbound.direction = 'inbound'
            and coalesce(inbound.received_at, inbound.created_at) <= ${sentAtExpr}
            and coalesce(inbound.received_at, inbound.created_at) >= ${sentAtExpr} - interval '7 days'
            and lower(coalesce(inbound.body, '')) ~ '(not ready|later|next week|next month|not sure yet|still deciding|thinking about it|let me think|need to think|maybe later|hold off for now)'
        )
      `,
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

  const normalizedRows: ObjectionOutcomeRow[] = rows.map((row) => ({
    channel: row.channel,
    objectionType: classifyObjectionType({
      comparisonShopping: row.comparisonShopping,
      decisionMaker: row.decisionMaker,
      timing: row.timing,
    }),
    reopened: row.reopened,
    booked: row.booked,
  }));

  const summary: ObjectionSaveOutcomeSummary = {
    windowStart: windowStart.toISOString(),
    ...buildSlice(normalizedRows),
    byType: {
      price: buildSlice(normalizedRows.filter((row) => row.objectionType === "price")),
      comparison_shopping: buildSlice(
        normalizedRows.filter((row) => row.objectionType === "comparison_shopping"),
      ),
      decision_maker: buildSlice(normalizedRows.filter((row) => row.objectionType === "decision_maker")),
      timing: buildSlice(normalizedRows.filter((row) => row.objectionType === "timing")),
    },
  };

  return summary;
}

export function getPreferredObjectionSaveChannel(
  summary: ObjectionSaveOutcomeSummary | null | undefined,
  scope?: ObjectionSaveLearningScope | null,
): "sms" | "dm" | null {
  return resolveScopedSummary(summary, scope).learned.preferredChannel;
}

export function shouldUseSofterObjectionSave(
  summary: ObjectionSaveOutcomeSummary | null | undefined,
  scope?: ObjectionSaveLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.keepSofter;
}
