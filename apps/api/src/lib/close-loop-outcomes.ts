import { appointments, conversationMessages, conversationThreads, getDb, outboxEvents } from "@/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type CloseLoopActionType = "appointment_checkin" | "appointment_support" | "post_job_checkin";

type CloseLoopOutcomeRow = {
  actionType: CloseLoopActionType;
  replied: boolean;
  preserved: boolean;
  completed: boolean;
  rescheduled: boolean;
  repeatBooked: boolean;
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

export type CloseLoopOutcomeSummary = {
  windowStart: string;
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

function deriveAppointmentCheckinWorthwhile(summary: CloseLoopOutcomeSummary): boolean {
  const bucket = summary.byAction.appointment_checkin;
  if (bucket.attempts < 4) return false;
  return bucket.replyRate >= 0.18 || bucket.preservedRate >= 0.75 || bucket.completedRate >= 0.55;
}

function deriveAppointmentSupportWorthwhile(summary: CloseLoopOutcomeSummary): boolean {
  const bucket = summary.byAction.appointment_support;
  if (bucket.attempts < 4) return false;
  return bucket.replyRate >= 0.25 || bucket.rescheduleRate >= 0.2 || bucket.preservedRate >= 0.75;
}

function deriveAppointmentSupportNeedsLightTouch(summary: CloseLoopOutcomeSummary): boolean {
  const bucket = summary.byAction.appointment_support;
  if (bucket.attempts < 6) return false;
  return bucket.replyRate < 0.15 && bucket.rescheduleRate < 0.1;
}

function derivePostJobCheckinWorthwhile(summary: CloseLoopOutcomeSummary): boolean {
  const bucket = summary.byAction.post_job_checkin;
  if (bucket.attempts < 4) return false;
  return bucket.replyRate >= 0.12 || bucket.repeatBookRate >= 0.05;
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

  const overall = summarize(rows);
  const byAction = {
    appointment_checkin: summarize(rows.filter((row) => row.actionType === "appointment_checkin")),
    appointment_support: summarize(rows.filter((row) => row.actionType === "appointment_support")),
    post_job_checkin: summarize(rows.filter((row) => row.actionType === "post_job_checkin")),
  };

  const summary: CloseLoopOutcomeSummary = {
    windowStart: windowStart.toISOString(),
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

export function areAppointmentCheckinsWorthwhile(
  summary: CloseLoopOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.appointmentCheckinWorthwhile === true;
}

export function isAppointmentSupportWorthwhile(
  summary: CloseLoopOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.appointmentSupportWorthwhile === true;
}

export function shouldKeepAppointmentSupportLight(
  summary: CloseLoopOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.appointmentSupportNeedsLightTouch === true;
}

export function arePostJobCheckinsWorthwhile(
  summary: CloseLoopOutcomeSummary | null | undefined,
): boolean {
  return summary?.learned.postJobCheckinWorthwhile === true;
}
