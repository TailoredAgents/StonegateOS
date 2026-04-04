import { appointments, conversationMessages, conversationThreads, getDb, leads, outboxEvents } from "@/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type CloseLoopActionType = "appointment_checkin" | "appointment_support" | "post_job_checkin";
type ServiceFamily = "junk" | "demo" | "brush" | "unknown";
type SourceFamily = "facebook" | "public_site" | "other" | "unknown";

export type CloseLoopLearningScope = {
  serviceFamily?: ServiceFamily | null;
  sourceFamily?: SourceFamily | null;
};

type CloseLoopOutcomeRow = {
  actionType: CloseLoopActionType;
  replied: boolean;
  preserved: boolean;
  completed: boolean;
  rescheduled: boolean;
  repeatBooked: boolean;
  serviceFamily: ServiceFamily;
  sourceFamily: SourceFamily;
};

type CloseLoopOutcomeBucket = {
  attempts: number;
  replied: number;
  replyRate: number;
  preserved: number;
  preservedRate: number;
  completed: number;
  completedRate: number;
  rescheduled: number;
  rescheduleRate: number;
  repeatBooked: number;
  repeatBookRate: number;
};

type CloseLoopOutcomeSlice = {
  attempts: number;
  replied: number;
  replyRate: number;
  preserved: number;
  preservedRate: number;
  completed: number;
  completedRate: number;
  rescheduled: number;
  rescheduleRate: number;
  repeatBooked: number;
  repeatBookRate: number;
  byAction: Record<CloseLoopActionType, CloseLoopOutcomeBucket>;
  learned: {
    appointmentCheckinWorthwhile: boolean;
    appointmentSupportWorthwhile: boolean;
    appointmentSupportNeedsLightTouch: boolean;
    postJobCheckinWorthwhile: boolean;
  };
};

export type CloseLoopOutcomeSummary = CloseLoopOutcomeSlice & {
  windowStart: string;
  byServiceFamily: Record<ServiceFamily, CloseLoopOutcomeSlice>;
  bySourceFamily: Record<SourceFamily, CloseLoopOutcomeSlice>;
};

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarize(rows: CloseLoopOutcomeRow[]): CloseLoopOutcomeBucket {
  const attempts = rows.length;
  const replied = rows.filter((row) => row.replied).length;
  const preserved = rows.filter((row) => row.preserved).length;
  const completed = rows.filter((row) => row.completed).length;
  const rescheduled = rows.filter((row) => row.rescheduled).length;
  const repeatBooked = rows.filter((row) => row.repeatBooked).length;
  return {
    attempts,
    replied,
    replyRate: toRate(replied, attempts),
    preserved,
    preservedRate: toRate(preserved, attempts),
    completed,
    completedRate: toRate(completed, attempts),
    rescheduled,
    rescheduleRate: toRate(rescheduled, attempts),
    repeatBooked,
    repeatBookRate: toRate(repeatBooked, attempts),
  };
}

function deriveAppointmentCheckinWorthwhile(summary: CloseLoopOutcomeSlice): boolean {
  const bucket = summary.byAction.appointment_checkin;
  if (bucket.attempts < 4) return false;
  return bucket.replyRate >= 0.18 || bucket.preservedRate >= 0.75 || bucket.completedRate >= 0.55;
}

function deriveAppointmentSupportWorthwhile(summary: CloseLoopOutcomeSlice): boolean {
  const bucket = summary.byAction.appointment_support;
  if (bucket.attempts < 4) return false;
  return bucket.replyRate >= 0.25 || bucket.rescheduleRate >= 0.2 || bucket.preservedRate >= 0.75;
}

function deriveAppointmentSupportNeedsLightTouch(summary: CloseLoopOutcomeSlice): boolean {
  const bucket = summary.byAction.appointment_support;
  if (bucket.attempts < 6) return false;
  return bucket.replyRate < 0.15 && bucket.rescheduleRate < 0.1;
}

function derivePostJobCheckinWorthwhile(summary: CloseLoopOutcomeSlice): boolean {
  const bucket = summary.byAction.post_job_checkin;
  if (bucket.attempts < 4) return false;
  return bucket.replyRate >= 0.12 || bucket.repeatBookRate >= 0.05;
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

function buildSlice(rows: CloseLoopOutcomeRow[]): CloseLoopOutcomeSlice {
  const overall = summarize(rows);
  const byAction = {
    appointment_checkin: summarize(rows.filter((row) => row.actionType === "appointment_checkin")),
    appointment_support: summarize(rows.filter((row) => row.actionType === "appointment_support")),
    post_job_checkin: summarize(rows.filter((row) => row.actionType === "post_job_checkin")),
  };

  const summary: CloseLoopOutcomeSlice = {
    attempts: overall.attempts,
    replied: overall.replied,
    replyRate: overall.replyRate,
    preserved: overall.preserved,
    preservedRate: overall.preservedRate,
    completed: overall.completed,
    completedRate: overall.completedRate,
    rescheduled: overall.rescheduled,
    rescheduleRate: overall.rescheduleRate,
    repeatBooked: overall.repeatBooked,
    repeatBookRate: overall.repeatBookRate,
    byAction,
    learned: {
      appointmentCheckinWorthwhile: false,
      appointmentSupportWorthwhile: false,
      appointmentSupportNeedsLightTouch: false,
      postJobCheckinWorthwhile: false,
    },
  };

  summary.learned.appointmentCheckinWorthwhile = deriveAppointmentCheckinWorthwhile(summary);
  summary.learned.appointmentSupportWorthwhile = deriveAppointmentSupportWorthwhile(summary);
  summary.learned.appointmentSupportNeedsLightTouch = deriveAppointmentSupportNeedsLightTouch(summary);
  summary.learned.postJobCheckinWorthwhile = derivePostJobCheckinWorthwhile(summary);
  return summary;
}

function buildSummary(rows: CloseLoopOutcomeRow[], windowStart: Date): CloseLoopOutcomeSummary {
  return {
    windowStart: windowStart.toISOString(),
    ...buildSlice(rows),
    byServiceFamily: {
      junk: buildSlice(rows.filter((row) => row.serviceFamily === "junk")),
      demo: buildSlice(rows.filter((row) => row.serviceFamily === "demo")),
      brush: buildSlice(rows.filter((row) => row.serviceFamily === "brush")),
      unknown: buildSlice(rows.filter((row) => row.serviceFamily === "unknown")),
    },
    bySourceFamily: {
      facebook: buildSlice(rows.filter((row) => row.sourceFamily === "facebook")),
      public_site: buildSlice(rows.filter((row) => row.sourceFamily === "public_site")),
      other: buildSlice(rows.filter((row) => row.sourceFamily === "other")),
      unknown: buildSlice(rows.filter((row) => row.sourceFamily === "unknown")),
    },
  };
}

function emptySlice(): CloseLoopOutcomeSlice {
  return buildSlice([]);
}

function resolveScopedSummary(
  summary: CloseLoopOutcomeSummary | null | undefined,
  scope?: CloseLoopLearningScope | null,
): CloseLoopOutcomeSlice {
  if (!summary) return emptySlice();
  if (scope?.serviceFamily && summary.byServiceFamily[scope.serviceFamily].attempts >= 4) {
    return summary.byServiceFamily[scope.serviceFamily];
  }
  if (scope?.sourceFamily && summary.bySourceFamily[scope.sourceFamily].attempts >= 4) {
    return summary.bySourceFamily[scope.sourceFamily];
  }
  return summary;
}

export function getCloseLoopLearningScope(input: {
  latestLeadSource?: string | null;
  contactSource?: string | null;
  dmEntrySource?: "facebook_ad_lead" | "organic_messenger" | "unknown" | null;
  latestLeadServices?: string[] | null;
  instantQuoteJobTypes?: string[] | null;
}): CloseLoopLearningScope {
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

export async function loadCloseLoopOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<CloseLoopOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const sentAtExpr = sql<Date>`coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt})`;

  const rows = await db
    .select({
      actionType: sql<CloseLoopActionType>`coalesce(${conversationMessages.metadata} ->> 'aiPlannerActionType', '')`,
      replied: sql<boolean>`
        exists(
          select 1
          from ${conversationMessages} inbound
          inner join ${conversationThreads} inbound_thread on inbound.thread_id = inbound_thread.id
          where inbound_thread.contact_id = ${conversationThreads.contactId}
            and inbound.direction = 'inbound'
            and coalesce(inbound.received_at, inbound.created_at) >= ${sentAtExpr}
            and coalesce(inbound.received_at, inbound.created_at) <= ${sentAtExpr} + interval '72 hours'
        )
      `,
      preserved: sql<boolean>`
        exists(
          select 1
          from ${appointments} appt
          where appt.contact_id = ${conversationThreads.contactId}
            and coalesce(appt.start_at, appt.created_at) >= ${sentAtExpr} - interval '24 hours'
            and coalesce(appt.start_at, appt.created_at) <= ${sentAtExpr} + interval '14 days'
            and appt.status <> 'canceled'
            and appt.status <> 'no_show'
        )
      `,
      completed: sql<boolean>`
        exists(
          select 1
          from ${appointments} appt
          where appt.contact_id = ${conversationThreads.contactId}
            and coalesce(appt.completed_at, appt.start_at, appt.created_at) >= ${sentAtExpr}
            and coalesce(appt.completed_at, appt.start_at, appt.created_at) <= ${sentAtExpr} + interval '30 days'
            and appt.status = 'completed'
        )
      `,
      rescheduled: sql<boolean>`
        exists(
          select 1
          from ${outboxEvents} evt
          inner join ${appointments} appt on appt.id::text = evt.payload ->> 'appointmentId'
          where evt.type = 'estimate.rescheduled'
            and appt.contact_id = ${conversationThreads.contactId}
            and evt.created_at >= ${sentAtExpr}
            and evt.created_at <= ${sentAtExpr} + interval '14 days'
        )
      `,
      repeatBooked: sql<boolean>`
        exists(
          select 1
          from ${appointments} appt
          where appt.contact_id = ${conversationThreads.contactId}
            and appt.created_at >= ${sentAtExpr}
            and appt.created_at <= ${sentAtExpr} + interval '30 days'
            and appt.status <> 'canceled'
            and coalesce(appt.completed_at, appt.start_at, appt.created_at) > ${sentAtExpr}
        )
      `,
      leadSource: sql<string | null>`(
        select lead.source
        from ${leads} lead
        where lead.contact_id = ${conversationThreads.contactId}
          and lead.created_at <= ${sentAtExpr}
        order by lead.created_at desc
        limit 1
      )`,
      leadServices: sql<string[] | null>`(
        select lead.services_requested
        from ${leads} lead
        where lead.contact_id = ${conversationThreads.contactId}
          and lead.created_at <= ${sentAtExpr}
        order by lead.created_at desc
        limit 1
      )`,
    })
    .from(conversationMessages)
    .innerJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .where(
      and(
        gte(conversationMessages.createdAt, windowStart),
        eq(conversationMessages.direction, "outbound"),
        sql`coalesce(${conversationMessages.metadata} ->> 'draft', 'false') <> 'true'`,
        sql`coalesce(${conversationMessages.metadata} ->> 'aiPlannerActionType', '') in ('appointment_checkin', 'appointment_support', 'post_job_checkin')`,
      ),
    )
    .orderBy(desc(sentAtExpr))
    .limit(1000);

  const mappedRows: CloseLoopOutcomeRow[] = rows.map((row) => ({
    actionType: row.actionType,
    replied: row.replied,
    preserved: row.preserved,
    completed: row.completed,
    rescheduled: row.rescheduled,
    repeatBooked: row.repeatBooked,
    serviceFamily: classifyServiceFamily(
      (Array.isArray(row.leadServices) ? row.leadServices : []).filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      ),
    ),
    sourceFamily: classifySourceFamily(row.leadSource),
  }));

  return buildSummary(mappedRows, windowStart);
}

export function areAppointmentCheckinsWorthwhile(
  summary: CloseLoopOutcomeSummary | null | undefined,
  scope?: CloseLoopLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.appointmentCheckinWorthwhile;
}

export function isAppointmentSupportWorthwhile(
  summary: CloseLoopOutcomeSummary | null | undefined,
  scope?: CloseLoopLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.appointmentSupportWorthwhile;
}

export function shouldKeepAppointmentSupportLight(
  summary: CloseLoopOutcomeSummary | null | undefined,
  scope?: CloseLoopLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.appointmentSupportNeedsLightTouch;
}

export function arePostJobCheckinsWorthwhile(
  summary: CloseLoopOutcomeSummary | null | undefined,
  scope?: CloseLoopLearningScope | null,
): boolean {
  return resolveScopedSummary(summary, scope).learned.postJobCheckinWorthwhile;
}
