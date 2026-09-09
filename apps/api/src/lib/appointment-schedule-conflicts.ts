import { createHash } from "node:crypto";
import { DateTime } from "luxon";
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
import {
  appointmentHolds,
  appointments,
  contacts,
  scheduleBlocks,
  scheduleResourcePools,
  scheduleDateOverrides,
  getDb,
} from "@/db";
import { evaluateWeightedScheduleCapacity } from "@/lib/scheduling/capacity";
import { isQuoteOnlyAppointmentType } from "@/lib/appointment-kind";
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
  kind: "appointment" | "hold" | "schedule_block";
  capacityUnits?: number;
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
  overrideAllowed?: boolean;
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
  capacityUnits?: number;
  capacityPoolKey?: string;
  timezone?: string;
  excludeAppointmentId?: string | null;
  excludeHoldInstantQuoteId?: string | null;
  excludeHoldQuoteVersionId?: string | null;
  includeHolds?: boolean;
  now?: Date;
};

type ScheduleReadSnapshot = {
  appointments: Array<
    typeof appointments.$inferSelect & {
      firstName: string | null;
      lastName: string | null;
    }
  >;
  holds: Array<typeof appointmentHolds.$inferSelect>;
  blocks: Array<typeof scheduleBlocks.$inferSelect>;
  pools: Array<typeof scheduleResourcePools.$inferSelect>;
  overrides: Array<typeof scheduleDateOverrides.$inferSelect>;
};

/** Bounded public reads use the same inspector as writes, with one database
 * snapshot instead of one set of SQL queries for every candidate. A read is
 * never a reservation; the real mutation still rechecks under the global lock. */
export async function filterScheduleReadCandidates<
  T extends { startAt: string },
>(input: {
  candidates: readonly T[];
  durationMinutes: number;
  travelBufferMinutes: number;
  capacity: number;
  capacityPoolKey?: string;
  capacityUnits?: number;
  timezone: string;
  now?: Date;
  excludeHoldInstantQuoteId?: string | null;
  excludeHoldQuoteVersionId?: string | null;
}): Promise<T[]> {
  if (!input.candidates.length) return [];
  if (input.candidates.length > 6000)
    throw new Error("schedule_candidate_read_limit");
  const starts = input.candidates.map((candidate) =>
    new Date(candidate.startAt).getTime(),
  );
  if (starts.some((start) => !Number.isFinite(start)))
    throw new Error("invalid_schedule_candidate");
  const startAt = new Date(Math.min(...starts));
  const endAt = new Date(
    Math.max(...starts) +
      (input.durationMinutes + input.travelBufferMinutes) * 60_000,
  );
  if (endAt.getTime() - startAt.getTime() > 93 * 86400000)
    throw new Error("schedule_candidate_read_range");
  const now = input.now ?? new Date(),
    poolKey = input.capacityPoolKey ?? "field_service";
  return getDb().transaction(async (tx) => {
    const [jobRows, holds, blocks, pools, overrides] = await Promise.all([
      tx
        .select({
          appointment: appointments,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
        })
        .from(appointments)
        .leftJoin(contacts, eq(contacts.id, appointments.contactId))
        .where(
          and(
            eq(appointments.capacityPoolKey, poolKey),
            isNotNull(appointments.startAt),
            notInArray(appointments.status, [
              ...NON_BLOCKING_APPOINTMENT_STATUSES,
            ]),
            lt(appointments.startAt, endAt),
            sql`${appointments.startAt} + (${appointments.durationMinutes} + ${appointments.travelBufferMinutes}) * interval '1 minute' > ${sql.param(startAt, appointments.startAt)}`,
          ),
        ),
      tx
        .select()
        .from(appointmentHolds)
        .where(
          and(
            eq(appointmentHolds.capacityPoolKey, poolKey),
            eq(appointmentHolds.status, "active"),
            gt(appointmentHolds.expiresAt, now),
            lt(appointmentHolds.startAt, endAt),
            sql`${appointmentHolds.startAt} + (${appointmentHolds.durationMinutes} + ${appointmentHolds.travelBufferMinutes}) * interval '1 minute' > ${sql.param(startAt, appointmentHolds.startAt)}`,
          ),
        ),
      tx
        .select()
        .from(scheduleBlocks)
        .where(
          and(
            eq(scheduleBlocks.capacityPoolKey, poolKey),
            eq(scheduleBlocks.active, true),
            isNull(scheduleBlocks.mirroredAppointmentId),
            lt(scheduleBlocks.startAt, endAt),
            gt(scheduleBlocks.endAt, startAt),
          ),
        ),
      tx
        .select()
        .from(scheduleResourcePools)
        .where(eq(scheduleResourcePools.key, poolKey)),
      tx
        .select()
        .from(scheduleDateOverrides)
        .where(eq(scheduleDateOverrides.timezone, input.timezone)),
    ]);
    const snapshot: ScheduleReadSnapshot = {
      appointments: jobRows.map(({ appointment, firstName, lastName }) => ({
        ...appointment,
        firstName,
        lastName,
      })),
      holds,
      blocks,
      pools,
      overrides,
    };
    const decisions = await Promise.all(
      input.candidates.map((candidate) =>
        inspectScheduleConflicts(
          tx,
          {
            startAt: new Date(candidate.startAt),
            durationMinutes: input.durationMinutes,
            travelBufferMinutes: input.travelBufferMinutes,
            capacity: input.capacity,
            capacityUnits: input.capacityUnits,
            capacityPoolKey: poolKey,
            timezone: input.timezone,
            now,
            excludeHoldInstantQuoteId: input.excludeHoldInstantQuoteId,
            excludeHoldQuoteVersionId: input.excludeHoldQuoteVersionId,
          },
          snapshot,
        ),
      ),
    );
    return input.candidates.filter((_, index) => !decisions[index]!.conflict);
  });
}

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
  requestedCapacityUnits = 1,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        capacity,
        requestedCapacityUnits,
        conflicts: conflicts.map((conflict) => ({
          id: conflict.id,
          startAt: conflict.startAt,
          endAt: conflict.endAt,
          capacityUnits: conflict.capacityUnits ?? 1,
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
  requestedCapacityUnits = 1,
): { maximumConcurrent: number; conflicts: ScheduleConflict[] } {
  const result = evaluateWeightedScheduleCapacity({
    candidate: {
      capacityPoolKey: "field_service",
      capacityUnits: requestedCapacityUnits,
      occupancy: proposed,
    },
    poolCapacityUnits: capacity,
    blocks: allOverlaps.map((entry) => ({
      id: entry.id,
      kind: entry.kind === "schedule_block" ? "external_busy" : entry.kind,
      capacityPoolKey: "field_service",
      capacityUnits: entry.capacityUnits ?? 1,
      occupancy: {
        startAt: new Date(entry.startAt),
        endAt: new Date(entry.endAt),
      },
    })),
  });
  const blockingIds = new Set(result.blockingBlockIds);
  return {
    maximumConcurrent: result.peakExistingUnits,
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
  const kind = isQuoteOnlyAppointmentType(input.type)
    ? "in-person quote"
    : "job";
  return contactName ? `${contactName} - ${kind}` : `CRM ${kind}`;
}

export async function inspectScheduleConflicts(
  tx: TeamMutationTransaction,
  input: InspectScheduleInput,
  snapshot?: ScheduleReadSnapshot,
): Promise<ScheduleConflictDecision> {
  const interval = buildScheduleOccupancyInterval(
    input.startAt,
    input.durationMinutes,
    input.travelBufferMinutes,
  );
  const legacyCapacity =
    Number.isFinite(input.capacity) && input.capacity >= 0
      ? Math.floor(input.capacity)
      : 1;
  const now = input.now ?? new Date();
  const [existing] = snapshot
    ? snapshot.appointments.filter(
        (row) => row.id === input.excludeAppointmentId,
      )
    : input.excludeAppointmentId
      ? await tx
          .select({
            capacityPoolKey: appointments.capacityPoolKey,
            capacityUnits: appointments.capacityUnits,
          })
          .from(appointments)
          .where(eq(appointments.id, input.excludeAppointmentId))
          .limit(1)
      : [];
  const poolKey =
    input.capacityPoolKey ?? existing?.capacityPoolKey ?? "field_service";
  const requestedCapacityUnits =
    input.capacityUnits ?? existing?.capacityUnits ?? 1;
  const [pool] = snapshot
    ? snapshot.pools.filter((row) => row.key === poolKey)
    : await tx
        .select({
          capacityUnits: scheduleResourcePools.capacityUnits,
          active: scheduleResourcePools.active,
        })
        .from(scheduleResourcePools)
        .where(eq(scheduleResourcePools.key, poolKey))
        .limit(1);
  // The legacy staffing setting may narrow a configured pool, never widen it.
  let capacity = pool
    ? pool.active
      ? Math.min(legacyCapacity, pool.capacityUnits)
      : 0
    : legacyCapacity;
  const timezone = input.timezone ?? EASTERN_TIME_ZONE;
  const localStart = DateTime.fromJSDate(interval.startAt, { zone: timezone });
  const localEnd = DateTime.fromJSDate(interval.endAt, { zone: timezone });
  const [dateOverride] = snapshot
    ? snapshot.overrides.filter(
        (row) =>
          row.localDate === localStart.toISODate() && row.timezone === timezone,
      )
    : await tx
        .select({
          closed: scheduleDateOverrides.closed,
          windows: scheduleDateOverrides.windows,
          capacityByPool: scheduleDateOverrides.capacityByPool,
        })
        .from(scheduleDateOverrides)
        .where(
          and(
            eq(scheduleDateOverrides.localDate, localStart.toISODate()!),
            eq(scheduleDateOverrides.timezone, timezone),
          ),
        )
        .limit(1);
  const overrideCapacity = dateOverride?.capacityByPool[poolKey];
  if (Number.isInteger(overrideCapacity) && overrideCapacity! >= 0)
    capacity = Math.min(capacity, overrideCapacity!);
  const outsideOverrideHours = Boolean(
    dateOverride?.windows.length &&
      !(
        localStart.toISODate() === localEnd.toISODate() &&
        dateOverride.windows.some(
          (window) =>
            localStart.hour * 60 + localStart.minute >= window.startMinute &&
            localEnd.hour * 60 + localEnd.minute <= window.endMinute,
        )
      ),
  );
  if (dateOverride?.closed || outsideOverrideHours) capacity = 0;

  const appointmentRows = snapshot
    ? snapshot.appointments.filter(
        (row) =>
          row.capacityPoolKey === poolKey &&
          row.id !== input.excludeAppointmentId &&
          row.startAt &&
          row.startAt < interval.endAt &&
          row.startAt.getTime() +
            (row.durationMinutes + row.travelBufferMinutes) * 60_000 >
            interval.startAt.getTime(),
      )
    : await tx
        .select({
          id: appointments.id,
          type: appointments.type,
          startAt: appointments.startAt,
          durationMinutes: appointments.durationMinutes,
          travelBufferMinutes: appointments.travelBufferMinutes,
          capacityUnits: appointments.capacityUnits,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
        })
        .from(appointments)
        .leftJoin(contacts, eq(appointments.contactId, contacts.id))
        .where(
          and(
            isNotNull(appointments.startAt),
            eq(appointments.capacityPoolKey, poolKey),
            notInArray(appointments.status, [
              ...NON_BLOCKING_APPOINTMENT_STATUSES,
            ]),
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
        .for("update", { of: appointments });

  const holdRows =
    input.includeHolds === false
      ? []
      : snapshot
        ? snapshot.holds.filter(
            (row) =>
              row.capacityPoolKey === poolKey &&
              row.expiresAt > now &&
              row.startAt < interval.endAt &&
              row.startAt.getTime() +
                (row.durationMinutes + row.travelBufferMinutes) * 60_000 >
                interval.startAt.getTime() &&
              (!input.excludeHoldInstantQuoteId ||
                row.instantQuoteId !== input.excludeHoldInstantQuoteId) &&
              (!input.excludeHoldQuoteVersionId ||
                row.quoteVersionId !== input.excludeHoldQuoteVersionId),
          )
        : await tx
            .select({
              id: appointmentHolds.id,
              startAt: appointmentHolds.startAt,
              durationMinutes: appointmentHolds.durationMinutes,
              travelBufferMinutes: appointmentHolds.travelBufferMinutes,
              capacityUnits: appointmentHolds.capacityUnits,
            })
            .from(appointmentHolds)
            .where(
              and(
                eq(appointmentHolds.status, "active"),
                eq(appointmentHolds.capacityPoolKey, poolKey),
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
                input.excludeHoldQuoteVersionId
                  ? or(
                      isNull(appointmentHolds.quoteVersionId),
                      ne(
                        appointmentHolds.quoteVersionId,
                        input.excludeHoldQuoteVersionId,
                      ),
                    )
                  : undefined,
              ),
            )
            .for("update");

  const externalBlocks = snapshot
    ? snapshot.blocks.filter(
        (row) =>
          row.capacityPoolKey === poolKey &&
          row.startAt < interval.endAt &&
          row.endAt > interval.startAt,
      )
    : await tx
        .select({
          id: scheduleBlocks.id,
          kind: scheduleBlocks.kind,
          startAt: scheduleBlocks.startAt,
          endAt: scheduleBlocks.endAt,
          capacityUnits: scheduleBlocks.capacityUnits,
        })
        .from(scheduleBlocks)
        .where(
          and(
            eq(scheduleBlocks.capacityPoolKey, poolKey),
            eq(scheduleBlocks.active, true),
            isNull(scheduleBlocks.mirroredAppointmentId),
            lt(scheduleBlocks.startAt, interval.endAt),
            gt(scheduleBlocks.endAt, interval.startAt),
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
          capacityUnits: row.capacityUnits,
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
          capacityUnits: row.capacityUnits,
        },
      ];
    }),
    ...externalBlocks.map((row) => ({
      id: `block:${row.id}`,
      kind: "schedule_block" as const,
      appointmentId: null,
      title:
        row.kind === "blackout"
          ? "Schedule blackout"
          : row.kind === "resource_unavailable"
            ? "Resource unavailable"
            : "External calendar or capacity block",
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      capacityUnits: row.capacityUnits,
    })),
  ].sort((left, right) => {
    const startDifference =
      Date.parse(left.startAt) - Date.parse(right.startAt);
    return startDifference || left.id.localeCompare(right.id);
  });

  const blocking = selectBlockingScheduleConflicts(
    allOverlaps,
    interval,
    capacity,
    requestedCapacityUnits,
  );
  const conflict =
    blocking.maximumConcurrent + requestedCapacityUnits > capacity;
  const conflicts = conflict ? blocking.conflicts : [];
  const requiredAcknowledgement = conflict
    ? buildConflictAcknowledgement(conflicts)
    : "";
  const fingerprint = buildConflictFingerprint(
    conflicts,
    capacity,
    requestedCapacityUnits,
  );
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
    overrideAllowed:
      capacity > 0 &&
      requestedCapacityUnits <= capacity &&
      !conflicts.some((item) => item.kind === "schedule_block"),
  };
}

export function decideScheduleConflictOverride(
  decision: ScheduleConflictDecision,
  input: ScheduleConflictOverrideInput,
): ScheduleConflictOverrideDecision {
  if (!decision.conflict) {
    return { ok: true, overridden: false, reason: null };
  }
  if (decision.overrideAllowed === false) {
    return {
      ok: false,
      code: "schedule_conflict",
      message:
        "This time is blocked by configured capacity, a blackout, or an external calendar block. Update the underlying schedule configuration or choose another time.",
    };
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
