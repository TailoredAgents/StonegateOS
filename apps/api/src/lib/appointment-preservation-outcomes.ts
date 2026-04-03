import { appointments, conversationMessages, getDb, leads } from "@/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

type DbExecutor = ReturnType<typeof getDb>;
type TouchKind = "requested" | "rescheduled" | "reminder" | "other";
type AppointmentType = "estimate" | "in_person_quote" | "job" | "other";
type ServiceFamily = "junk" | "demo" | "brush" | "unknown";
type SourceFamily = "facebook" | "public_site" | "other" | "unknown";

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
  appointmentType: AppointmentType;
  serviceFamily: ServiceFamily;
  sourceFamily: SourceFamily;
  preserved: boolean;
  completed: boolean;
  canceled: boolean;
  noShow: boolean;
};

type AppointmentPreservationOutcomeSlice = {
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
  byAppointmentType: Record<AppointmentType, OutcomeBucket>;
  byServiceFamily: Record<ServiceFamily, OutcomeBucket>;
  bySourceFamily: Record<SourceFamily, OutcomeBucket>;
  learned: {
    strongestTouchKind: TouchKind | null;
    needsHumanBackup: boolean;
  };
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
  byAppointmentType: Record<AppointmentType, OutcomeBucket>;
  byServiceFamily: Record<ServiceFamily, OutcomeBucket>;
  bySourceFamily: Record<SourceFamily, OutcomeBucket>;
  learned: AppointmentPreservationOutcomeSlice["learned"];
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

function classifyAppointmentType(value: string | null | undefined): AppointmentType {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "estimate") return "estimate";
  if (normalized === "in_person_quote") return "in_person_quote";
  if (normalized === "job") return "job";
  return "other";
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

function strongestTouchKind(summary: AppointmentPreservationOutcomeSlice): TouchKind | null {
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

function needsHumanBackup(summary: AppointmentPreservationOutcomeSlice): boolean {
  if (summary.attempts < 8) return false;
  return summary.canceledRate + summary.noShowRate >= 0.2 || summary.completedRate < 0.45;
}

function buildSlice(rows: PreservationOutcomeRow[]): AppointmentPreservationOutcomeSlice {
  const overall = summarize(rows);
  const slice: AppointmentPreservationOutcomeSlice = {
    attempts: overall.attempts,
    preserved: overall.preserved,
    preservedRate: overall.preservedRate,
    completed: overall.completed,
    completedRate: overall.completedRate,
    canceled: overall.canceled,
    canceledRate: overall.canceledRate,
    noShows: overall.noShows,
    noShowRate: overall.noShowRate,
    byKind: {
      requested: summarize(rows.filter((row) => row.touchKind === "requested")),
      rescheduled: summarize(rows.filter((row) => row.touchKind === "rescheduled")),
      reminder: summarize(rows.filter((row) => row.touchKind === "reminder")),
      other: summarize(rows.filter((row) => row.touchKind === "other")),
    },
    byAppointmentType: {
      estimate: summarize(rows.filter((row) => row.appointmentType === "estimate")),
      in_person_quote: summarize(rows.filter((row) => row.appointmentType === "in_person_quote")),
      job: summarize(rows.filter((row) => row.appointmentType === "job")),
      other: summarize(rows.filter((row) => row.appointmentType === "other")),
    },
    byServiceFamily: {
      junk: summarize(rows.filter((row) => row.serviceFamily === "junk")),
      demo: summarize(rows.filter((row) => row.serviceFamily === "demo")),
      brush: summarize(rows.filter((row) => row.serviceFamily === "brush")),
      unknown: summarize(rows.filter((row) => row.serviceFamily === "unknown")),
    },
    bySourceFamily: {
      facebook: summarize(rows.filter((row) => row.sourceFamily === "facebook")),
      public_site: summarize(rows.filter((row) => row.sourceFamily === "public_site")),
      other: summarize(rows.filter((row) => row.sourceFamily === "other")),
      unknown: summarize(rows.filter((row) => row.sourceFamily === "unknown")),
    },
    learned: {
      strongestTouchKind: null,
      needsHumanBackup: false,
    },
  };

  slice.learned.strongestTouchKind = strongestTouchKind(slice);
  slice.learned.needsHumanBackup = needsHumanBackup(slice);
  return slice;
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
      appointmentType: sql<string>`coalesce((
        select appt.type
        from ${appointments} appt
        where appt.id::text = ${appointmentIdExpr}
        limit 1
      ), '')`,
      leadSource: sql<string>`coalesce((
        select lead.source
        from ${appointments} appt
        left join ${leads} lead on lead.id = appt.lead_id
        where appt.id::text = ${appointmentIdExpr}
        limit 1
      ), '')`,
      leadServices: sql<string[]>`coalesce((
        select lead.services_requested
        from ${appointments} appt
        left join ${leads} lead on lead.id = appt.lead_id
        where appt.id::text = ${appointmentIdExpr}
        limit 1
      ), '{}'::text[])`,
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
    appointmentType: classifyAppointmentType(row.appointmentType),
    serviceFamily: classifyServiceFamily(
      (Array.isArray(row.leadServices) ? row.leadServices : []).filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      ),
    ),
    sourceFamily: classifySourceFamily(row.leadSource ?? null),
    preserved: row.preserved,
    completed: row.completed,
    canceled: row.canceled,
    noShow: row.noShow,
  }));

  const built = buildSlice(normalizedRows);

  const summary: AppointmentPreservationOutcomeSummary = {
    windowStart: windowStart.toISOString(),
    ...built,
  };
  return summary;
}
