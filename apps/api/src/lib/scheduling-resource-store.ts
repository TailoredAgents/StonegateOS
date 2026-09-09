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
import { DateTime } from "luxon";
import {
  appointments,
  appointmentHolds,
  scheduleResources,
  partnerSchedulingProfileResourceRequirements,
} from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import type {
  NamedScheduleResource,
  NamedScheduleResourceRequirement,
  NamedScheduleResourceAssignment,
  NamedScheduleResourceBlock,
} from "@/lib/scheduling";

export type NamedResourcePlan = Readonly<{
  resources: readonly NamedScheduleResource[];
  requirements: readonly NamedScheduleResourceRequirement[];
  revision: string;
}>;
function sha256(value: string) {
  return createHash("sha256").update(value).update("\u0000").digest("hex");
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => JSON.stringify(key) + ":" + stableJson(value))
      .join(",") +
    "}"
  );
}

/** Translate stored assignments using the current definitions. An old pooled
 * or missing crew allocation must not make newly named crews appear free. */
export function namedResourceBlocksForOccupancy(input: {
  id: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  capacityPoolKey: string;
  assignments: readonly NamedScheduleResourceAssignment[];
  plan: NamedResourcePlan;
}): NamedScheduleResourceBlock[] {
  const localDate = DateTime.fromJSDate(input.startAt, {
    zone: input.timezone,
  }).toISODate()!;
  const result: NamedScheduleResourceBlock[] = [];
  for (const resource of input.plan.resources) {
    if (resource.capacityPoolKey !== input.capacityPoolKey) continue;
    const known = input.assignments.find(
      (assignment) => assignment.resourceId === resource.id,
    );
    const kindAssignments = input.assignments.filter(
      (assignment) => assignment.kind === resource.kind,
    );
    const unknown =
      (kindAssignments.length === 0 && resource.kind !== "equipment") ||
      kindAssignments.some(
        (assignment) =>
          !input.plan.resources.some(
            (current) => current.id === assignment.resourceId,
          ),
      );
    if (known || unknown)
      result.push({
        id: input.id,
        resourceId: resource.id,
        capacityUnits: unknown ? resource.capacityUnits : known!.capacityUnits,
        occupancy: { startAt: input.startAt, endAt: input.endAt },
        localDate,
      });
  }
  return result;
}

/** Read the complete local day for per-crew limits, not just intersecting jobs. */
export async function loadNamedResourceBlocks(input: {
  tx: TeamMutationTransaction;
  plan: NamedResourcePlan;
  capacityPoolKey: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  now: Date;
  excludeAppointmentId?: string;
  excludeDraftId?: string | null;
}): Promise<NamedScheduleResourceBlock[]> {
  const rangeStart = DateTime.fromJSDate(input.startAt, {
    zone: input.timezone,
  })
    .startOf("day")
    .toJSDate();
  const rangeEnd = DateTime.fromJSDate(input.endAt, { zone: input.timezone })
    .plus({ days: 1 })
    .startOf("day")
    .toJSDate();
  const [jobs, holds] = await Promise.all([
    input.tx
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.capacityPoolKey, input.capacityPoolKey),
          isNotNull(appointments.startAt),
          notInArray(appointments.status, ["canceled", "completed", "no_show"]),
          input.excludeAppointmentId
            ? ne(appointments.id, input.excludeAppointmentId)
            : undefined,
          lt(appointments.startAt, rangeEnd),
          sql`${appointments.startAt} + (${appointments.durationMinutes} + ${appointments.travelBufferMinutes}) * interval '1 minute' > ${sql.param(rangeStart, appointments.startAt)}`,
        ),
      ),
    input.tx
      .select()
      .from(appointmentHolds)
      .where(
        and(
          eq(appointmentHolds.capacityPoolKey, input.capacityPoolKey),
          eq(appointmentHolds.status, "active"),
          gt(appointmentHolds.expiresAt, input.now),
          input.excludeDraftId
            ? or(
                isNull(appointmentHolds.partnerBookingDraftId),
                ne(
                  appointmentHolds.partnerBookingDraftId,
                  input.excludeDraftId,
                ),
              )
            : undefined,
          lt(appointmentHolds.startAt, rangeEnd),
          sql`${appointmentHolds.startAt} + (${appointmentHolds.durationMinutes} + ${appointmentHolds.travelBufferMinutes}) * interval '1 minute' > ${sql.param(rangeStart, appointmentHolds.startAt)}`,
        ),
      ),
  ]);
  return [
    ...jobs.flatMap((row) =>
      row.startAt
        ? namedResourceBlocksForOccupancy({
            id: `appointment:${row.id}`,
            startAt: row.startAt,
            endAt: new Date(
              row.startAt.getTime() +
                (row.durationMinutes + row.travelBufferMinutes) * 60_000,
            ),
            capacityPoolKey: row.capacityPoolKey,
            assignments: row.resourceAssignmentSnapshot,
            timezone: input.timezone,
            plan: input.plan,
          })
        : [],
    ),
    ...holds.flatMap((row) =>
      namedResourceBlocksForOccupancy({
        id: `hold:${row.id}`,
        startAt: row.startAt,
        endAt: new Date(
          row.startAt.getTime() +
            (row.durationMinutes + row.travelBufferMinutes) * 60_000,
        ),
        capacityPoolKey: row.capacityPoolKey,
        assignments: row.resourceAssignmentSnapshot,
        timezone: input.timezone,
        plan: input.plan,
      }),
    ),
  ];
}

const SCHEDULE_RESOURCE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

function validScheduleResourceKeys(values: readonly string[]): boolean {
  return (
    values.length <= 50 &&
    values.every(
      (value) =>
        SCHEDULE_RESOURCE_KEY_PATTERN.test(value) &&
        value === value.trim().toLowerCase(),
    ) &&
    new Set(values).size === values.length
  );
}

export async function loadNamedResourcePlan(input: {
  tx: TeamMutationTransaction;
  profile: { id: string; capacityPoolKey: string };
}): Promise<{ plan: NamedResourcePlan | null; revision: string }> {
  const [resourceRows, requirementRows] = await Promise.all([
    input.tx
      .select()
      .from(scheduleResources)
      .where(
        eq(scheduleResources.capacityPoolKey, input.profile.capacityPoolKey),
      )
      .orderBy(
        scheduleResources.kind,
        scheduleResources.label,
        scheduleResources.id,
      ),
    input.tx
      .select()
      .from(partnerSchedulingProfileResourceRequirements)
      .where(
        eq(
          partnerSchedulingProfileResourceRequirements.schedulingProfileId,
          input.profile.id,
        ),
      )
      .orderBy(
        partnerSchedulingProfileResourceRequirements.resourceKind,
        partnerSchedulingProfileResourceRequirements.id,
      ),
  ]);
  const staffKinds = new Set(
    resourceRows
      .filter((resource) => resource.source === "staff")
      .map((resource) => resource.kind),
  );
  const selectedDefinitions = resourceRows.filter(
    (resource) => resource.source === "staff" || !staffKinds.has(resource.kind),
  );
  const resources = selectedDefinitions
    .filter((resource) => resource.active)
    .map((resource) =>
      Object.freeze({
        id: resource.id,
        capacityPoolKey: resource.capacityPoolKey,
        kind: resource.kind,
        label: resource.label,
        capacityUnits: resource.capacityUnits,
        dailyJobMultiplier:
          resource.source === "compatibility_pool" ? resource.capacityUnits : 1,
        skillKeys: Object.freeze([...resource.skillKeys]),
      }),
    );
  const requirements = requirementRows.map((requirement) =>
    Object.freeze({
      kind: requirement.resourceKind,
      quantity: requirement.quantity,
      capacityUnits: requirement.capacityUnits,
      requiredSkillKeys: Object.freeze([...requirement.requiredSkillKeys]),
    }),
  );
  const revision = sha256(
    stableJson({
      resources: resourceRows.map((resource) => ({
        id: resource.id,
        capacityPoolKey: resource.capacityPoolKey,
        kind: resource.kind,
        label: resource.label,
        capacityUnits: resource.capacityUnits,
        skillKeys: resource.skillKeys,
        active: resource.active,
        source: resource.source,
        updatedAt: resource.updatedAt.toISOString(),
      })),
      requirements: requirementRows.map((requirement) => ({
        id: requirement.id,
        kind: requirement.resourceKind,
        quantity: requirement.quantity,
        capacityUnits: requirement.capacityUnits,
        requiredSkillKeys: requirement.requiredSkillKeys,
        source: requirement.source,
        updatedAt: requirement.updatedAt.toISOString(),
      })),
    }),
  );
  const structurallyValid =
    requirements.length > 0 &&
    requirements.every(
      (requirement) =>
        validScheduleResourceKeys(requirement.requiredSkillKeys) &&
        selectedDefinitions.filter(
          (resource) =>
            resource.kind === requirement.kind &&
            resource.capacityUnits >= requirement.capacityUnits &&
            validScheduleResourceKeys(resource.skillKeys) &&
            requirement.requiredSkillKeys.every((skill) =>
              resource.skillKeys.includes(skill),
            ),
        ).length >= requirement.quantity,
    );
  return {
    plan: structurallyValid
      ? Object.freeze({
          resources: Object.freeze(resources),
          requirements: Object.freeze(requirements),
          revision,
        })
      : null,
    revision,
  };
}
