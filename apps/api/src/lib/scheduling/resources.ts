import { SchedulingDomainError } from "./errors";
import {
  clipScheduleInterval,
  createScheduleInterval,
  scheduleIntervalsOverlap,
} from "./intervals";
import type { ScheduleInterval } from "./types";

export const SCHEDULE_RESOURCE_KINDS = ["crew", "truck", "equipment"] as const;

export type ScheduleResourceKind = (typeof SCHEDULE_RESOURCE_KINDS)[number];

export type NamedScheduleResource = Readonly<{
  id: string;
  capacityPoolKey: string;
  kind: ScheduleResourceKind;
  label: string;
  capacityUnits: number;
  dailyJobMultiplier: number;
  skillKeys: readonly string[];
}>;

export type NamedScheduleResourceRequirement = Readonly<{
  kind: ScheduleResourceKind;
  quantity: number;
  capacityUnits: number;
  requiredSkillKeys: readonly string[];
}>;

export type NamedScheduleResourceAssignment = Readonly<{
  resourceId: string;
  kind: ScheduleResourceKind;
  label: string;
  capacityUnits: number;
}>;

export type NamedScheduleResourceBlock = Readonly<{
  id: string;
  resourceId: string;
  capacityUnits: number;
  occupancy: ScheduleInterval;
  localDate: string;
}>;

export type NamedScheduleResourceEvaluation = Readonly<{
  available: boolean;
  reason:
    | "available"
    | "configuration_missing"
    | "skill_unavailable"
    | "resource_capacity"
    | "crew_daily_limit";
  assignments: readonly NamedScheduleResourceAssignment[];
}>;

const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function invalidResource(message: string): never {
  throw new SchedulingDomainError("invalid_capacity", message);
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

function validKind(value: unknown): value is ScheduleResourceKind {
  return (SCHEDULE_RESOURCE_KINDS as readonly unknown[]).includes(value);
}

function normalizedKeys(
  values: readonly string[],
  field: "skills" | "required skills",
): readonly string[] {
  if (
    values.length > 50 ||
    values.some(
      (value) =>
        typeof value !== "string" ||
        !KEY_PATTERN.test(value) ||
        value !== value.trim().toLowerCase(),
    ) ||
    new Set(values).size !== values.length
  ) {
    return invalidResource(`The schedule resource ${field} are invalid.`);
  }
  return values;
}

function peakResourceUnits(input: {
  resourceId: string;
  occupancy: ScheduleInterval;
  blocks: readonly NamedScheduleResourceBlock[];
}): number {
  const events: Array<{ at: number; delta: number; type: "start" | "end" }> =
    [];
  for (const block of input.blocks) {
    if (block.resourceId !== input.resourceId) continue;
    if (!positiveInteger(block.capacityUnits, 10_000)) {
      return invalidResource("A named resource allocation is invalid.");
    }
    const occupancy = createScheduleInterval(
      block.occupancy.startAt,
      block.occupancy.endAt,
    );
    if (!scheduleIntervalsOverlap(input.occupancy, occupancy)) continue;
    const clipped = clipScheduleInterval(occupancy, input.occupancy);
    if (!clipped) continue;
    events.push(
      {
        at: clipped.startAt.getTime(),
        delta: block.capacityUnits,
        type: "start",
      },
      {
        at: clipped.endAt.getTime(),
        delta: -block.capacityUnits,
        type: "end",
      },
    );
  }
  events.sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    if (left.type !== right.type) return left.type === "end" ? -1 : 1;
    return 0;
  });
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    if (
      event.at >= input.occupancy.startAt.getTime() &&
      event.at < input.occupancy.endAt.getTime()
    ) {
      peak = Math.max(peak, current);
    }
  }
  return peak;
}

function dailyResourceLoad(input: {
  resource: NamedScheduleResource;
  localDate: string;
  blocks: readonly NamedScheduleResourceBlock[];
}): number {
  const capacityByJob = new Map<string, number>();
  for (const block of input.blocks) {
    if (
      block.resourceId !== input.resource.id ||
      block.localDate !== input.localDate
    ) {
      continue;
    }
    if (!block.id || !positiveInteger(block.capacityUnits, 10_000)) {
      return invalidResource("A named resource allocation is invalid.");
    }
    capacityByJob.set(
      block.id,
      Math.max(capacityByJob.get(block.id) ?? 0, block.capacityUnits),
    );
  }
  // A physical crew receives one job against its daily cap. Compatibility
  // resources represent an aggregate pool, so weighted crew units must be
  // consumed or a multi-crew job could silently exceed maxJobsPerCrew.
  return input.resource.dailyJobMultiplier > 1
    ? [...capacityByJob.values()].reduce((total, units) => total + units, 0)
    : capacityByJob.size;
}

/**
 * Selects deterministic named resources for one candidate while preserving
 * weighted capacity, skill requirements, and the legacy per-crew daily cap.
 * Callers must repeat this evaluation while holding the shared schedule lock
 * before persisting a reservation.
 */
export function assignNamedScheduleResources(input: {
  capacityPoolKey: string;
  occupancy: ScheduleInterval;
  localDate: string;
  resources: readonly NamedScheduleResource[];
  requirements: readonly NamedScheduleResourceRequirement[];
  blocks: readonly NamedScheduleResourceBlock[];
  maxJobsPerCrew: number;
}): NamedScheduleResourceEvaluation {
  const occupancy = createScheduleInterval(
    input.occupancy.startAt,
    input.occupancy.endAt,
  );
  if (
    !KEY_PATTERN.test(input.capacityPoolKey) ||
    !LOCAL_DATE_PATTERN.test(input.localDate) ||
    !Number.isSafeInteger(input.maxJobsPerCrew) ||
    input.maxJobsPerCrew < 0 ||
    input.maxJobsPerCrew > 10_000
  ) {
    return invalidResource("The named resource scheduling context is invalid.");
  }
  if (input.requirements.length === 0 || input.requirements.length > 20) {
    return Object.freeze({
      available: false,
      reason: "configuration_missing" as const,
      assignments: Object.freeze([]),
    });
  }

  const seenResourceIds = new Set<string>();
  for (const resource of input.resources) {
    if (
      !resource.id ||
      resource.id.length > 160 ||
      seenResourceIds.has(resource.id) ||
      resource.capacityPoolKey !== input.capacityPoolKey ||
      !validKind(resource.kind) ||
      !resource.label.trim() ||
      resource.label.length > 160 ||
      !positiveInteger(resource.capacityUnits, 10_000) ||
      !positiveInteger(resource.dailyJobMultiplier, 10_000)
    ) {
      return invalidResource("A named schedule resource is invalid.");
    }
    seenResourceIds.add(resource.id);
    normalizedKeys(resource.skillKeys, "skills");
  }

  const assignments: NamedScheduleResourceAssignment[] = [];
  const assignedResourceIds = new Set<string>();
  for (const requirement of [...input.requirements].sort((left, right) =>
    left.kind.localeCompare(right.kind),
  )) {
    if (
      !validKind(requirement.kind) ||
      !positiveInteger(requirement.quantity, 20) ||
      !positiveInteger(requirement.capacityUnits, 100)
    ) {
      return invalidResource("A named resource requirement is invalid.");
    }
    const requiredSkills = normalizedKeys(
      requirement.requiredSkillKeys,
      "required skills",
    );
    const matching = input.resources.filter(
      (resource) =>
        resource.kind === requirement.kind &&
        requiredSkills.every((skill) => resource.skillKeys.includes(skill)),
    );
    if (matching.length < requirement.quantity) {
      return Object.freeze({
        available: false,
        reason: "skill_unavailable" as const,
        assignments: Object.freeze([]),
      });
    }

    const eligible = matching
      .filter((resource) => !assignedResourceIds.has(resource.id))
      .map((resource) => {
        const peakUnits = peakResourceUnits({
          resourceId: resource.id,
          occupancy,
          blocks: input.blocks,
        });
        const dailyJobs = dailyResourceLoad({
          resource,
          localDate: input.localDate,
          blocks: input.blocks,
        });
        const dailyLimit =
          requirement.kind === "crew" && input.maxJobsPerCrew > 0
            ? input.maxJobsPerCrew * resource.dailyJobMultiplier
            : 0;
        return {
          resource,
          peakUnits,
          dailyLimitReached: dailyLimit > 0 && dailyJobs >= dailyLimit,
          remainingUnits: resource.capacityUnits - peakUnits,
        };
      })
      .filter(
        (candidate) =>
          !candidate.dailyLimitReached &&
          candidate.remainingUnits >= requirement.capacityUnits,
      )
      .sort(
        (left, right) =>
          right.remainingUnits - left.remainingUnits ||
          left.resource.label.localeCompare(right.resource.label) ||
          left.resource.id.localeCompare(right.resource.id),
      );

    if (eligible.length < requirement.quantity) {
      const dailyLimitBlocked = matching.some((resource) => {
        if (requirement.kind !== "crew" || input.maxJobsPerCrew === 0) {
          return false;
        }
        const jobs = dailyResourceLoad({
          resource,
          localDate: input.localDate,
          blocks: input.blocks,
        });
        return jobs >= input.maxJobsPerCrew * resource.dailyJobMultiplier;
      });
      return Object.freeze({
        available: false,
        reason: dailyLimitBlocked
          ? ("crew_daily_limit" as const)
          : ("resource_capacity" as const),
        assignments: Object.freeze([]),
      });
    }
    for (const candidate of eligible.slice(0, requirement.quantity)) {
      assignedResourceIds.add(candidate.resource.id);
      assignments.push(
        Object.freeze({
          resourceId: candidate.resource.id,
          kind: candidate.resource.kind,
          label: candidate.resource.label,
          capacityUnits: requirement.capacityUnits,
        }),
      );
    }
  }

  return Object.freeze({
    available: true,
    reason: "available" as const,
    assignments: Object.freeze(assignments),
  });
}
