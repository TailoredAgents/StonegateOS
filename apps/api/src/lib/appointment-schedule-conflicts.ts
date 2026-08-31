import { createHash } from "node:crypto";
import {
  and,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { appointmentHolds, appointments, contacts } from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const EASTERN_TIME_ZONE = "America/New_York";
const SCHEDULE_LOCK_KEY = "appointment_schedule_conflict_v1";
const NON_BLOCKING_APPOINTMENT_STATUSES = [
  "canceled",
  "completed",
  "no_show",
] as const;

export type ScheduleInterval = {
  startAt: Date;
  endAt: Date;
};

export type ScheduleConflict = {
  id: string;
  kind: "appointment" | "hold";
  appointmentId: string | null;
  title: string;
  startAt: string;
  endAt: string;
};

export type ScheduleConflictDecision = {
  conflict: boolean;
  capacity: number;
  overlappingCount: number;
  conflicts: ScheduleConflict[];
  fingerprint: string;
  requiredAcknowledgement: string;
  message: string;
};

export type ScheduleConflictOverrideInput = {
  reason?: string | null;
  acknowledgement?: string | null;
  fingerprint?: string | null;
};

export type ScheduleConflictOverrideDecision =
  | { ok: true; overridden: false; reason: null }
  | { ok: true; overridden: true; reason: string }
  | {
      ok: false;
      code:
        | "schedule_conflict"
        | "schedule_conflict_override_reason_required"
        | "schedule_conflict_override_stale";
      message: string;
    };

type InspectScheduleInput = {
  startAt: Date;
  durationMinutes: number;
  travelBufferMinutes?: number;
  capacity: number;
  excludeAppointmentId?: string | null;
  excludeHoldInstantQuoteId?: string | null;
  includeHolds?: boolean;
  now?: Date;
};

export function scheduleIntervalsOverlap(
  first: ScheduleInterval,
  second: ScheduleInterval,
): boolean {
  return first.startAt < second.endAt && second.startAt < first.endAt;
}

export function buildScheduleInterval(
  startAt: Date,
  durationMinutes: number,
): ScheduleInterval {
  const safeDuration =
    Number.isFinite(durationMinutes) && durationMinutes >= 15
      ? Math.floor(durationMinutes)
      : 60;
  return {
    startAt,
    endAt: new Date(startAt.getTime() + safeDuration * 60_000),
  };
}

export function buildScheduleOccupancyInterval(
  startAt: Date,
  durationMinutes: number,
  travelBufferMinutes = 0,
): ScheduleInterval {
  const safeBuffer =
    Number.isFinite(travelBufferMinutes) && travelBufferMinutes >= 0
      ? Math.floor(travelBufferMinutes)
      : 0;
  return buildScheduleInterval(startAt, durationMinutes + safeBuffer);
}

export async function acquireScheduleConflictLock(
  tx: TeamMutationTransaction,
): Promise<void> {
  // A predicate query alone cannot stop two concurrent inserts from both
  // observing an empty slot under READ COMMITTED. Every CRM booking and
  // reschedule takes this transaction-scoped lock before inspecting capacity.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${SCHEDULE_LOCK_KEY}))`,
  );
}

function formatConflictTime(startAt: string, endAt: string): string {
  const date = new Date(startAt);
  const end = new Date(endAt);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${day}, ${time.format(date)}-${time.format(end)} Eastern`;
}

function buildConflictFingerprint(
  conflicts: ScheduleConflict[],
  capacity: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        capacity,
        conflicts: conflicts.map((conflict) => ({
          id: conflict.id,
          startAt: conflict.startAt,
          endAt: conflict.endAt,
        })),
      }),
    )
    .digest("hex");
}

function buildConflictAcknowledgement(conflicts: ScheduleConflict[]): string {
  const writtenConflicts = conflicts
    .map(
      (conflict) =>
        `${conflict.title} (${formatConflictTime(conflict.startAt, conflict.endAt)})`,
    )
    .join("; ");
  return `I acknowledge this schedule conflict with: ${writtenConflicts}`;
}

/**
 * Finds the peak number of existing records active at any instant inside the
 * proposed half-open interval. Counting every record that overlaps a long job
 * would incorrectly reject sequential jobs that never consume capacity at the
 * same time.
 */
export function selectBlockingScheduleConflicts(
  allOverlaps: ScheduleConflict[],
  proposed: ScheduleInterval,
  capacity: number,
): { maximumConcurrent: number; conflicts: ScheduleConflict[] } {
  const proposedStart = proposed.startAt.getTime();
  const proposedEnd = proposed.endAt.getTime();
  const candidateTimes = [
    proposedStart,
    ...allOverlaps.map((conflict) =>
      Math.max(proposedStart, Date.parse(conflict.startAt)),
    ),
  ]
    .filter((time) => Number.isFinite(time) && time < proposedEnd)
    .sort((left, right) => left - right);
  const blockingIds = new Set<string>();
  let maximumConcurrent = 0;

  for (const time of [...new Set(candidateTimes)]) {
    const active = allOverlaps.filter((conflict) => {
      const start = Date.parse(conflict.startAt);
      const end = Date.parse(conflict.endAt);
      return start <= time && time < end;
    });
    maximumConcurrent = Math.max(maximumConcurrent, active.length);
    if (active.length >= capacity) {
      for (const conflict of active) blockingIds.add(conflict.id);
    }
  }

  return {
    maximumConcurrent,
    conflicts: allOverlaps.filter((conflict) => blockingIds.has(conflict.id)),
  };
}

function appointmentTitle(input: {
  firstName: string | null;
  lastName: string | null;
  type: string | null;
}): string {
  const contactName = [input.firstName, input.lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
  const kind =
    input.type?.trim().toLowerCase() === "in_person_quote"
      ? "in-person quote"
      : "job";
  return contactName ? `${contactName} - ${kind}` : `CRM ${kind}`;
}

export async function inspectScheduleConflicts(
  tx: TeamMutationTransaction,
  input: InspectScheduleInput,
): Promise<ScheduleConflictDecision> {
  const interval = buildScheduleOccupancyInterval(
    input.startAt,
    input.durationMinutes,
    input.travelBufferMinutes,
  );
  const capacity =
    Number.isFinite(input.capacity) && input.capacity > 0
      ? Math.floor(input.capacity)
      : 1;
  const now = input.now ?? new Date();

  const appointmentRows = await tx
    .select({
      id: appointments.id,
      type: appointments.type,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
    })
    .from(appointments)
    .innerJoin(contacts, eq(appointments.contactId, contacts.id))
    .where(
      and(
        isNotNull(appointments.startAt),
        notInArray(appointments.status, [...NON_BLOCKING_APPOINTMENT_STATUSES]),
        lt(appointments.startAt, interval.endAt),
        sql`${appointments.startAt} + ((${appointments.durationMinutes} + ${appointments.travelBufferMinutes}) * interval '1 minute') > ${sql.param(
          interval.startAt,
          appointments.startAt,
        )}`,
        input.excludeAppointmentId
          ? ne(appointments.id, input.excludeAppointmentId)
          : undefined,
      ),
    )
    .for("update");

  const holdRows =
    input.includeHolds === false
      ? []
      : await tx
          .select({
            id: appointmentHolds.id,
            startAt: appointmentHolds.startAt,
            durationMinutes: appointmentHolds.durationMinutes,
            travelBufferMinutes: appointmentHolds.travelBufferMinutes,
          })
          .from(appointmentHolds)
          .where(
            and(
              eq(appointmentHolds.status, "active"),
              gt(appointmentHolds.expiresAt, now),
              lt(appointmentHolds.startAt, interval.endAt),
              sql`${appointmentHolds.startAt} + ((${appointmentHolds.durationMinutes} + ${appointmentHolds.travelBufferMinutes}) * interval '1 minute') > ${sql.param(
                interval.startAt,
                appointmentHolds.startAt,
              )}`,
              input.excludeHoldInstantQuoteId
                ? or(
                    isNull(appointmentHolds.instantQuoteId),
                    ne(
                      appointmentHolds.instantQuoteId,
                      input.excludeHoldInstantQuoteId,
                    ),
                  )
                : undefined,
            ),
          )
          .for("update");

  const allOverlaps: ScheduleConflict[] = [
    ...appointmentRows.flatMap((row) => {
      if (!(row.startAt instanceof Date)) return [];
      const rowInterval = buildScheduleOccupancyInterval(
        row.startAt,
        row.durationMinutes ?? 60,
        row.travelBufferMinutes ?? 0,
      );
      if (!scheduleIntervalsOverlap(interval, rowInterval)) return [];
      return [
        {
          id: `appointment:${row.id}`,
          kind: "appointment" as const,
          appointmentId: row.id,
          title: appointmentTitle(row),
          startAt: rowInterval.startAt.toISOString(),
          endAt: rowInterval.endAt.toISOString(),
        },
      ];
    }),
    ...holdRows.flatMap((row) => {
      if (!(row.startAt instanceof Date)) return [];
      const rowInterval = buildScheduleOccupancyInterval(
        row.startAt,
        row.durationMinutes ?? 60,
        row.travelBufferMinutes ?? 0,
      );
      if (!scheduleIntervalsOverlap(interval, rowInterval)) return [];
      return [
        {
          id: `hold:${row.id}`,
          kind: "hold" as const,
          appointmentId: null,
          title: "Active booking hold",
          startAt: rowInterval.startAt.toISOString(),
          endAt: rowInterval.endAt.toISOString(),
        },
      ];
    }),
  ].sort((left, right) => {
    const startDifference =
      Date.parse(left.startAt) - Date.parse(right.startAt);
    return startDifference || left.id.localeCompare(right.id);
  });

  const blocking = selectBlockingScheduleConflicts(
    allOverlaps,
    interval,
    capacity,
  );
  const conflict = blocking.maximumConcurrent >= capacity;
  const conflicts = conflict ? blocking.conflicts : [];
  const requiredAcknowledgement = conflict
    ? buildConflictAcknowledgement(conflicts)
    : "";
  const fingerprint = buildConflictFingerprint(conflicts, capacity);
  const message = conflict
    ? `That time exceeds schedule capacity and overlaps ${conflicts
        .map(
          (item) =>
            `${item.title} (${formatConflictTime(item.startAt, item.endAt)})`,
        )
        .join(
          "; ",
        )}. Choose another time or use an authorized conflict override.`
    : "No schedule conflict.";

  return {
    conflict,
    capacity,
    overlappingCount: blocking.maximumConcurrent,
    conflicts,
    fingerprint,
    requiredAcknowledgement,
    message,
  };
}

export function decideScheduleConflictOverride(
  decision: ScheduleConflictDecision,
  input: ScheduleConflictOverrideInput,
): ScheduleConflictOverrideDecision {
  if (!decision.conflict) {
    return { ok: true, overridden: false, reason: null };
  }

  const reason = input.reason?.trim() ?? "";
  const acknowledgement = input.acknowledgement?.trim() ?? "";
  const fingerprint = input.fingerprint?.trim() ?? "";
  if (!reason && !acknowledgement && !fingerprint) {
    return {
      ok: false,
      code: "schedule_conflict",
      message: decision.message,
    };
  }
  if (reason.length < 10 || reason.length > 500) {
    return {
      ok: false,
      code: "schedule_conflict_override_reason_required",
      message:
        "Explain the operational reason for overriding this conflict in 10 to 500 characters.",
    };
  }
  if (
    fingerprint !== decision.fingerprint ||
    acknowledgement !== decision.requiredAcknowledgement
  ) {
    return {
      ok: false,
      code: "schedule_conflict_override_stale",
      message:
        "The conflicting schedule changed. Review the current jobs and times before overriding it.",
    };
  }
  return { ok: true, overridden: true, reason };
}
