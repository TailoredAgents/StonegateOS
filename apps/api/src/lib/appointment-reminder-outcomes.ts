import { appointments, auditLogs, conversationMessages, getDb, outboxEvents } from "@/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type ReminderWindow = "24h" | "2h" | "other";

type OutcomeBucket = {
  attempts: number;
  acknowledged: number;
  acknowledgedRate: number;
  confirmedReplies: number;
  confirmRate: number;
  rescheduleRequests: number;
  rescheduleRequestRate: number;
  rescheduled: number;
  rescheduleSaveRate: number;
  activeAppointments: number;
  activeRate: number;
  completed: number;
  completedRate: number;
  noShows: number;
  noShowRate: number;
};

type ReminderOutcomeRow = {
  reminderWindow: ReminderWindow;
  acknowledged: boolean;
  confirmedReply: boolean;
  rescheduleRequested: boolean;
  rescheduled: boolean;
  activeAppointment: boolean;
  completed: boolean;
  noShow: boolean;
};

export type AppointmentReminderOutcomeSummary = {
  windowStart: string;
  attempts: number;
  acknowledged: number;
  acknowledgedRate: number;
  confirmedReplies: number;
  confirmRate: number;
  rescheduleRequests: number;
  rescheduleRequestRate: number;
  rescheduled: number;
  rescheduleSaveRate: number;
  activeAppointments: number;
  activeRate: number;
  completed: number;
  completedRate: number;
  noShows: number;
  noShowRate: number;
  byWindow: Record<ReminderWindow, OutcomeBucket>;
  learned: {
    preferredWindow: ReminderWindow | null;
    confirmationLoopHealthy: boolean;
    rescheduleSavesWorking: boolean;
  };
};

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarize(rows: ReminderOutcomeRow[]): OutcomeBucket {
  const attempts = rows.length;
  const acknowledged = rows.filter((row) => row.acknowledged).length;
  const confirmedReplies = rows.filter((row) => row.confirmedReply).length;
  const rescheduleRequests = rows.filter((row) => row.rescheduleRequested).length;
  const rescheduled = rows.filter((row) => row.rescheduled).length;
  const activeAppointments = rows.filter((row) => row.activeAppointment).length;
  const completed = rows.filter((row) => row.completed).length;
  const noShows = rows.filter((row) => row.noShow).length;

  return {
    attempts,
    acknowledged,
    acknowledgedRate: toRate(acknowledged, attempts),
    confirmedReplies,
    confirmRate: toRate(confirmedReplies, attempts),
    rescheduleRequests,
    rescheduleRequestRate: toRate(rescheduleRequests, attempts),
    rescheduled,
    rescheduleSaveRate: toRate(rescheduled, Math.max(rescheduleRequests, 1)),
    activeAppointments,
    activeRate: toRate(activeAppointments, attempts),
    completed,
    completedRate: toRate(completed, attempts),
    noShows,
    noShowRate: toRate(noShows, attempts),
  };
}

function classifyReminderWindow(value: number | null | undefined): ReminderWindow {
  if (value === 24 * 60) return "24h";
  if (value === 2 * 60) return "2h";
  return "other";
}

function getPreferredWindow(
  summary: AppointmentReminderOutcomeSummary,
): ReminderWindow | null {
  const dayBefore = summary.byWindow["24h"];
  const sameDay = summary.byWindow["2h"];
  if (dayBefore.attempts >= 4 && (sameDay.attempts < 3 || dayBefore.acknowledgedRate >= sameDay.acknowledgedRate + 0.05)) {
    return "24h";
  }
  if (sameDay.attempts >= 4 && (dayBefore.attempts < 3 || sameDay.acknowledgedRate >= dayBefore.acknowledgedRate + 0.05)) {
    return "2h";
  }
  return null;
}

function isConfirmationLoopHealthy(summary: AppointmentReminderOutcomeSummary): boolean {
  if (summary.attempts < 6) return false;
  return summary.acknowledgedRate >= 0.35 && summary.noShowRate <= 0.15;
}

function areRescheduleSavesWorking(summary: AppointmentReminderOutcomeSummary): boolean {
  if (summary.rescheduleRequests < 3) return false;
  return summary.rescheduleSaveRate >= 0.4;
}

export async function loadAppointmentReminderOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<AppointmentReminderOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const sentAtExpr = sql<Date>`coalesce(${conversationMessages.sentAt}, ${conversationMessages.createdAt})`;
  const appointmentIdExpr = sql<string>`coalesce(${conversationMessages.metadata} ->> 'appointmentId', '')`;
  const reminderMinutesExpr = sql<number | null>`nullif(${conversationMessages.metadata} ->> 'reminderMinutes', '')::int`;

  const rows = await db
    .select({
      reminderMinutes: reminderMinutesExpr,
      acknowledged: sql<boolean>`
        exists(
          select 1
          from ${auditLogs} audit
          where audit.entity_type = 'appointment'
            and audit.entity_id = ${appointmentIdExpr}
            and audit.action in ('appointment.confirmed', 'appointment.reschedule_requested')
            and audit.created_at >= ${sentAtExpr}
            and audit.created_at <= ${sentAtExpr} + interval '48 hours'
        )
      `,
      confirmedReply: sql<boolean>`
        exists(
          select 1
          from ${auditLogs} audit
          where audit.entity_type = 'appointment'
            and audit.entity_id = ${appointmentIdExpr}
            and audit.action = 'appointment.confirmed'
            and audit.created_at >= ${sentAtExpr}
            and audit.created_at <= ${sentAtExpr} + interval '48 hours'
        )
      `,
      rescheduleRequested: sql<boolean>`
        exists(
          select 1
          from ${auditLogs} audit
          where audit.entity_type = 'appointment'
            and audit.entity_id = ${appointmentIdExpr}
            and audit.action = 'appointment.reschedule_requested'
            and audit.created_at >= ${sentAtExpr}
            and audit.created_at <= ${sentAtExpr} + interval '48 hours'
        )
      `,
      rescheduled: sql<boolean>`
        exists(
          select 1
          from ${outboxEvents} evt
          where evt.type = 'estimate.rescheduled'
            and evt.payload ->> 'appointmentId' = ${appointmentIdExpr}
            and evt.created_at >= ${sentAtExpr}
            and evt.created_at <= ${sentAtExpr} + interval '14 days'
        )
      `,
      activeAppointment: sql<boolean>`
        exists(
          select 1
          from ${appointments} appt
          where appt.id::text = ${appointmentIdExpr}
            and appt.status <> 'canceled'
            and appt.status <> 'no_show'
        )
      `,
      completed: sql<boolean>`
        exists(
          select 1
          from ${appointments} appt
          where appt.id::text = ${appointmentIdExpr}
            and appt.status = 'completed'
        )
      `,
      noShow: sql<boolean>`
        exists(
          select 1
          from ${appointments} appt
          where appt.id::text = ${appointmentIdExpr}
            and appt.status = 'no_show'
        )
      `,
    })
    .from(conversationMessages)
    .where(
      and(
        gte(conversationMessages.createdAt, windowStart),
        eq(conversationMessages.direction, "outbound"),
        sql`coalesce(${conversationMessages.metadata} ->> 'confirmationLoop', 'false') = 'true'`,
        sql`coalesce(${conversationMessages.metadata} ->> 'kind', '') = 'estimate.reminder'`,
      ),
    )
    .orderBy(desc(sentAtExpr))
    .limit(1000);

  const normalizedRows = rows.map((row) => ({
    reminderWindow: classifyReminderWindow(row.reminderMinutes),
    acknowledged: row.acknowledged,
    confirmedReply: row.confirmedReply,
    rescheduleRequested: row.rescheduleRequested,
    rescheduled: row.rescheduled,
    activeAppointment: row.activeAppointment,
    completed: row.completed,
    noShow: row.noShow,
  }));

  const overall = summarize(normalizedRows);
  const byWindow = {
    "24h": summarize(normalizedRows.filter((row) => row.reminderWindow === "24h")),
    "2h": summarize(normalizedRows.filter((row) => row.reminderWindow === "2h")),
    other: summarize(normalizedRows.filter((row) => row.reminderWindow === "other")),
  };

  const summary: AppointmentReminderOutcomeSummary = {
    windowStart: windowStart.toISOString(),
    attempts: overall.attempts,
    acknowledged: overall.acknowledged,
    acknowledgedRate: overall.acknowledgedRate,
    confirmedReplies: overall.confirmedReplies,
    confirmRate: overall.confirmRate,
    rescheduleRequests: overall.rescheduleRequests,
    rescheduleRequestRate: overall.rescheduleRequestRate,
    rescheduled: overall.rescheduled,
    rescheduleSaveRate: overall.rescheduleSaveRate,
    activeAppointments: overall.activeAppointments,
    activeRate: overall.activeRate,
    completed: overall.completed,
    completedRate: overall.completedRate,
    noShows: overall.noShows,
    noShowRate: overall.noShowRate,
    byWindow,
    learned: {
      preferredWindow: null,
      confirmationLoopHealthy: false,
      rescheduleSavesWorking: false,
    },
  };

  summary.learned.preferredWindow = getPreferredWindow(summary);
  summary.learned.confirmationLoopHealthy = isConfirmationLoopHealthy(summary);
  summary.learned.rescheduleSavesWorking = areRescheduleSavesWorking(summary);
  return summary;
}
