import { SchedulingDomainError } from "./errors";
import {
  clipScheduleInterval,
  createScheduleInterval,
  scheduleIntervalsOverlap,
} from "./intervals";
import type { ScheduleCapacityBlock, ScheduleInterval } from "./types";

export type ScheduleCapacityEvaluationReason =
  | "available"
  | "capacity_exceeded"
  | "request_exceeds_pool_capacity";

export type ScheduleCapacityEvaluation = Readonly<{
  available: boolean;
  reason: ScheduleCapacityEvaluationReason;
  capacityPoolKey: string;
  poolCapacityUnits: number;
  requestedCapacityUnits: number;
  peakExistingUnits: number;
  peakTotalUnits: number;
  remainingCapacityUnits: number;
  overlappingBlockIds: readonly string[];
  blockingBlockIds: readonly string[];
}>;

type CapacityEvent = Readonly<{
  at: number;
  type: "start" | "end";
  blockId: string;
  units: number;
}>;

const CAPACITY_POOL_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

function requirePositiveUnits(value: unknown, message: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 10_000
  ) {
    throw new SchedulingDomainError("invalid_capacity", message);
  }
  return value;
}

function requirePoolCapacityUnits(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 10_000
  ) {
    throw new SchedulingDomainError(
      "invalid_capacity",
      "The schedule capacity configuration is invalid.",
    );
  }
  return value;
}

function validateCandidateInterval(
  interval: ScheduleInterval,
): ScheduleInterval {
  return createScheduleInterval(interval.startAt, interval.endAt);
}

/**
 * Evaluates weighted peak resource use over a candidate's half-open occupancy
 * interval. Sequential blocks do not accumulate merely because each overlaps
 * a different portion of a long candidate.
 */
export function evaluateWeightedScheduleCapacity(input: {
  candidate: Readonly<{
    capacityPoolKey: string;
    capacityUnits: number;
    occupancy: ScheduleInterval;
  }>;
  poolCapacityUnits: number;
  blocks: readonly ScheduleCapacityBlock[];
  excludeBlockIds?: ReadonlySet<string> | readonly string[];
}): ScheduleCapacityEvaluation {
  const capacityPoolKey = input.candidate.capacityPoolKey.trim();
  if (
    !CAPACITY_POOL_KEY_PATTERN.test(capacityPoolKey) ||
    capacityPoolKey !== input.candidate.capacityPoolKey
  ) {
    throw new SchedulingDomainError(
      "invalid_capacity",
      "The scheduling capacity pool is invalid.",
    );
  }
  const poolCapacityUnits = requirePoolCapacityUnits(input.poolCapacityUnits);
  const requestedCapacityUnits = requirePositiveUnits(
    input.candidate.capacityUnits,
    "The service capacity requirement is invalid.",
  );
  const candidateInterval = validateCandidateInterval(
    input.candidate.occupancy,
  );
  const excluded = new Set(input.excludeBlockIds ?? []);
  const seenIds = new Set<string>();
  const overlappingIds: string[] = [];
  const events: CapacityEvent[] = [];

  for (const block of input.blocks) {
    const blockId = block.id.trim();
    if (
      !blockId ||
      blockId !== block.id ||
      seenIds.has(blockId) ||
      !CAPACITY_POOL_KEY_PATTERN.test(block.capacityPoolKey) ||
      block.capacityPoolKey !== block.capacityPoolKey.trim()
    ) {
      throw new SchedulingDomainError(
        "invalid_capacity",
        "The schedule contains an invalid capacity block.",
      );
    }
    seenIds.add(blockId);
    if (excluded.has(blockId) || block.capacityPoolKey !== capacityPoolKey) {
      continue;
    }
    const blockUnits = requirePositiveUnits(
      block.capacityUnits,
      "The schedule contains an invalid capacity block.",
    );
    const blockInterval = createScheduleInterval(
      block.occupancy.startAt,
      block.occupancy.endAt,
    );
    if (!scheduleIntervalsOverlap(candidateInterval, blockInterval)) continue;
    const clipped = clipScheduleInterval(blockInterval, candidateInterval);
    if (!clipped) continue;
    overlappingIds.push(blockId);
    events.push(
      {
        at: clipped.startAt.getTime(),
        type: "start",
        blockId,
        units: blockUnits,
      },
      {
        at: clipped.endAt.getTime(),
        type: "end",
        blockId,
        units: blockUnits,
      },
    );
  }

  events.sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    if (left.type !== right.type) return left.type === "end" ? -1 : 1;
    return left.blockId.localeCompare(right.blockId);
  });

  let existingUnits = 0;
  let peakExistingUnits = 0;
  const activeUnitsById = new Map<string, number>();
  const blockingIds = new Set<string>();
  let index = 0;
  while (index < events.length) {
    const eventTime = events[index]?.at;
    if (eventTime === undefined) break;
    const atSameTime: CapacityEvent[] = [];
    while (index < events.length && events[index]?.at === eventTime) {
      const event = events[index];
      if (event) atSameTime.push(event);
      index += 1;
    }

    for (const event of atSameTime) {
      if (event.type !== "end") continue;
      const activeUnits = activeUnitsById.get(event.blockId);
      if (activeUnits !== undefined) {
        existingUnits -= activeUnits;
        activeUnitsById.delete(event.blockId);
      }
    }
    for (const event of atSameTime) {
      if (event.type !== "start") continue;
      activeUnitsById.set(event.blockId, event.units);
      existingUnits += event.units;
    }

    if (eventTime >= candidateInterval.endAt.getTime()) continue;
    peakExistingUnits = Math.max(peakExistingUnits, existingUnits);
    if (existingUnits + requestedCapacityUnits > poolCapacityUnits) {
      for (const blockId of activeUnitsById.keys()) blockingIds.add(blockId);
    }
  }

  const peakTotalUnits = peakExistingUnits + requestedCapacityUnits;
  const requestExceedsPool = requestedCapacityUnits > poolCapacityUnits;
  const available = peakTotalUnits <= poolCapacityUnits;
  const reason: ScheduleCapacityEvaluationReason = available
    ? "available"
    : requestExceedsPool
      ? "request_exceeds_pool_capacity"
      : "capacity_exceeded";

  return Object.freeze({
    available,
    reason,
    capacityPoolKey,
    poolCapacityUnits,
    requestedCapacityUnits,
    peakExistingUnits,
    peakTotalUnits,
    remainingCapacityUnits: Math.max(0, poolCapacityUnits - peakTotalUnits),
    overlappingBlockIds: Object.freeze(overlappingIds.sort()),
    blockingBlockIds: Object.freeze([...blockingIds].sort()),
  });
}
