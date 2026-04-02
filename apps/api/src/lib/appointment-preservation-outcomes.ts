import { appointments, conversationMessages, getDb } from "@/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type TouchKind = "requested" | "rescheduled" | "reminder" | "other";

type OutcomeBucket = {
  attempts: number;
  preserved: number;
  preservedRate: number;
  completed: number;
  completedRate: number;
  canceled: number;
  canceledRate: number;
  noShows: number;
  noShowRate: number;
};

type PreservationOutcomeRow = {
  touchKind: TouchKind;
  preserved: boolean;
  completed: boolean;
  canceled: boolean;
  noShow: boolean;
};

export type AppointmentPreservationOutcomeSummary = {
  windowStart: string;
  attempts: number;
  preserved: number;
  preservedRate: number;
  completed: number;
  completedRate: number;
  canceled: number;
  canceledRate: number;
  noShows: number;
  noShowRate: number;
  byKind: Record<TouchKind, OutcomeBucket>;
  learned: {
    strongestTouchKind: TouchKind | null;
    needsHumanBackup: boolean;
  };
};

function toRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarize(rows: PreservationOutcomeRow[]): OutcomeBucket {
  const attempts = rows.length;
  const preserved = rows.filter((row) => row.preserved).length;
  const completed = rows.filter((row) => row.completed).length;
  const canceled = rows.filter((row) => row.canceled).length;
  const noShows = rows.filter((row) => row.noShow).length;
  return {
    attempts,
    preserved,
    preservedRate: toRate(preserved, attempts),
    completed,
    completedRate: toRate(completed, attempts),
    canceled,
    canceledRate: toRate(canceled, attempts),
    noShows,
    noShowRate: toRate(noShows, attempts),
  };
}

function classifyTouchKind(kind: string | null | undefined): TouchKind {
  const normalized = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  if (normalized === "estimate.requested") return "requested";
  if (normalized === "estimate.rescheduled") return "rescheduled";
  if (normalized === "estimate.reminder") return "reminder";
  return "other";
}

function strongestTouchKind(summary: AppointmentPreservationOutcomeSummary): TouchKind | null {
  const candidates: TouchKind[] = ["requested", "rescheduled", "reminder"];
  let best: TouchKind | null = null;
  let bestRate = 0;
  for (const kind of candidates) {
    const bucket = summary.byKind[kind];
    if (bucket.attempts < 4) continue;
    if (!best || bucket.preservedRate >= bestRate + 0.05) {
      best = kind;
      bestRate = bucket.preservedRate;
    }
  }
  return best;
}

function needsHumanBackup(summary: AppointmentPreservationOutcomeSummary): boolean {
  if (summary.attempts < 8) return false;
  return summary.canceledRate + summary.noShowRate >= 0.2 || summary.completedRate < 0.45;
}

export async function loadAppointmentPreservationOutcomeSummary(
  db: DbExecutor,
  input?: { windowStart?: Date },
): Promise<AppointmentPreservationOutcomeSummary> {
  const windowStart = input?.windowStart ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const appointmentIdExpr = sql<string>`coalesce(${conversationMessages.metadata} ->> 'appointmentId', '')`;

  const rows = await db
    .select({
      touchKind: sql<string>`coalesce(${conversationMessages.metadata} ->> 'kind', '')`,
      preserved: sql<boolean>`
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
      canceled: sql<boolean>`
        exists(
          select 1
          from ${appointments} appt
          where appt.id::text = ${appointmentIdExpr}
            and appt.status = 'canceled'
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
      ),
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1000);

  const normalizedRows = rows.map((row) => ({
    touchKind: classifyTouchKind(row.touchKind),
    preserved: row.preserved,
    completed: row.completed,
    canceled: row.canceled,
    noShow: row.noShow,
  }));

  const overall = summarize(normalizedRows);
  const byKind = {
    requested: summarize(normalizedRows.filter((row) => row.touchKind === "requested")),
    rescheduled: summarize(normalizedRows.filter((row) => row.touchKind === "rescheduled")),
    reminder: summarize(normalizedRows.filter((row) => row.touchKind === "reminder")),
    other: summarize(normalizedRows.filter((row) => row.touchKind === "other")),
  };

  const summary: AppointmentPreservationOutcomeSummary = {
    windowStart: windowStart.toISOString(),
    attempts: overall.attempts,
    preserved: overall.preserved,
    preservedRate: overall.preservedRate,
    completed: overall.completed,
    completedRate: overall.completedRate,
    canceled: overall.canceled,
    canceledRate: overall.canceledRate,
    noShows: overall.noShows,
    noShowRate: overall.noShowRate,
    byKind,
    learned: {
      strongestTouchKind: null,
      needsHumanBackup: false,
    },
  };

  summary.learned.strongestTouchKind = strongestTouchKind(summary);
  summary.learned.needsHumanBackup = needsHumanBackup(summary);
  return summary;
}
