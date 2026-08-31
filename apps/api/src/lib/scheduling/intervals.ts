import { SchedulingDomainError } from "./errors";
import {
  MAX_SCHEDULE_DURATION_MINUTES,
  MAX_TRAVEL_BUFFER_MINUTES,
} from "./demand";
import type {
  ScheduleDemand,
  ScheduleInterval,
  ScheduleOccupancy,
} from "./types";

function requireValidDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SchedulingDomainError(
      "invalid_interval",
      `The scheduling ${field} is invalid.`,
    );
  }
  return new Date(value.getTime());
}

export function createScheduleInterval(
  startAt: Date,
  endAt: Date,
): ScheduleInterval {
  const safeStart = requireValidDate(startAt, "start time");
  const safeEnd = requireValidDate(endAt, "end time");
  if (safeEnd.getTime() <= safeStart.getTime()) {
    throw new SchedulingDomainError(
      "invalid_interval",
      "The scheduling end time must be after its start time.",
    );
  }
  return Object.freeze({ startAt: safeStart, endAt: safeEnd });
}

/**
 * Builds the canonical work and occupancy intervals. Travel buffer is a
 * post-service resource buffer; an arrival window is never used as duration.
 */
export function createScheduleOccupancy(
  startAt: Date,
  demand: Pick<ScheduleDemand, "durationMinutes" | "travelBufferMinutes">,
): ScheduleOccupancy {
  const start = requireValidDate(startAt, "start time");
  const durationMinutes = demand.durationMinutes;
  const travelBufferMinutes = demand.travelBufferMinutes;
  if (
    !Number.isSafeInteger(durationMinutes) ||
    durationMinutes < 15 ||
    durationMinutes > MAX_SCHEDULE_DURATION_MINUTES ||
    !Number.isSafeInteger(travelBufferMinutes) ||
    travelBufferMinutes < 0 ||
    travelBufferMinutes > MAX_TRAVEL_BUFFER_MINUTES
  ) {
    throw new SchedulingDomainError(
      "invalid_interval",
      "The scheduling duration or travel buffer is invalid.",
    );
  }

  const workEndAt = new Date(start.getTime() + durationMinutes * 60_000);
  const occupancyEndAt = new Date(
    workEndAt.getTime() + travelBufferMinutes * 60_000,
  );
  if (
    !Number.isFinite(workEndAt.getTime()) ||
    !Number.isFinite(occupancyEndAt.getTime())
  ) {
    throw new SchedulingDomainError(
      "invalid_interval",
      "The scheduling interval is outside the supported date range.",
    );
  }

  return Object.freeze({
    work: createScheduleInterval(start, workEndAt),
    occupancy: createScheduleInterval(start, occupancyEndAt),
    durationMinutes,
    travelBufferMinutes,
  });
}

/** Half-open interval overlap: [start, end). Exact boundaries are available. */
export function scheduleIntervalsOverlap(
  first: ScheduleInterval,
  second: ScheduleInterval,
): boolean {
  return (
    first.startAt.getTime() < second.endAt.getTime() &&
    second.startAt.getTime() < first.endAt.getTime()
  );
}

export function scheduleIntervalContains(
  outer: ScheduleInterval,
  inner: ScheduleInterval,
): boolean {
  return (
    outer.startAt.getTime() <= inner.startAt.getTime() &&
    inner.endAt.getTime() <= outer.endAt.getTime()
  );
}

export function clipScheduleInterval(
  interval: ScheduleInterval,
  boundary: ScheduleInterval,
): ScheduleInterval | null {
  if (!scheduleIntervalsOverlap(interval, boundary)) return null;
  return createScheduleInterval(
    new Date(Math.max(interval.startAt.getTime(), boundary.startAt.getTime())),
    new Date(Math.min(interval.endAt.getTime(), boundary.endAt.getTime())),
  );
}
