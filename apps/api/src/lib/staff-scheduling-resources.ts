import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  appointments,
  partnerBookings,
  partnerSchedulingProfiles,
  partnerSchedulingProfileResourceRequirements,
  scheduleResources,
  scheduleResourcePools,
} from "@/db";
import { loadNamedResourcePlan } from "@/lib/scheduling-resource-store";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import {
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";
import { loadPartnerStaffInvitationAuthority } from "@/lib/partner-invitation-authority";

const KEY = /^[a-z][a-z0-9_-]{0,63}$/u;
const skills = z
  .array(z.string().regex(KEY))
  .max(50)
  .refine(
    (values) => new Set(values).size === values.length,
    "Remove duplicate skills.",
  );
export const StaffResourceMutationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("remove_requirement"),
      profileId: z.string().uuid(),
      resourceKind: z.enum(["crew", "truck", "equipment"]),
      reason: z.string().trim().min(12).max(1000),
      acknowledgeImpact: z.boolean(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("resource"),
      id: z.string().uuid().optional(),
      capacityPoolKey: z.string().regex(KEY),
      kind: z.enum(["crew", "truck", "equipment"]),
      label: z.string().trim().min(1).max(160),
      capacityUnits: z.number().int().min(1).max(10000),
      skillKeys: skills,
      active: z.boolean(),
      reason: z.string().trim().min(12).max(1000),
      acknowledgeImpact: z.boolean(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("requirement"),
      profileId: z.string().uuid(),
      resourceKind: z.enum(["crew", "truck", "equipment"]),
      quantity: z.number().int().min(1).max(20),
      capacityUnits: z.number().int().min(1).max(100),
      requiredSkillKeys: skills,
      reason: z.string().trim().min(12).max(1000),
      acknowledgeImpact: z.boolean(),
    })
    .strict(),
]);

export async function readStaffResourceConfiguration(
  tx = getDb() as unknown as TeamMutationTransaction,
) {
  const [resources, profiles, requirements, pools] = await Promise.all([
    tx
      .select()
      .from(scheduleResources)
      .orderBy(asc(scheduleResources.label), asc(scheduleResources.id))
      .limit(1001),
    tx
      .select()
      .from(partnerSchedulingProfiles)
      .orderBy(
        asc(partnerSchedulingProfiles.serviceKey),
        desc(partnerSchedulingProfiles.version),
      )
      .limit(1001),
    tx
      .select()
      .from(partnerSchedulingProfileResourceRequirements)
      .orderBy(asc(partnerSchedulingProfileResourceRequirements.id))
      .limit(3001),
    tx
      .select()
      .from(scheduleResourcePools)
      .orderBy(asc(scheduleResourcePools.key))
      .limit(101),
  ]);
  // Version covers the complete bounded configuration, including compatibility
  // records, so a stale editor cannot overwrite another staffing change.
  if (
    resources.length > 1000 ||
    profiles.length > 1000 ||
    requirements.length > 3000 ||
    pools.length > 100
  )
    throw new TeamMutationFailure(
      "invalid",
      "This scheduling configuration needs a filtered administration view before it can be changed.",
    );
  const version = createHash("sha256")
    .update(JSON.stringify({ resources, profiles, requirements, pools }))
    .digest("hex");
  return {
    version,
    resources,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      serviceKey: profile.serviceKey,
      version: profile.version,
      capacityPoolKey: profile.capacityPoolKey,
      active: profile.active,
      durationMinutes: profile.durationMinutes,
      travelBufferMinutes: profile.travelBufferMinutes,
    })),
    requirements,
    pools,
  };
}

export async function saveStaffResourceConfiguration(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  input: z.infer<typeof StaffResourceMutationSchema>,
) {
  await acquireScheduleConflictLock(tx);
  if (
    !mutation.actor.id ||
    !(await loadPartnerStaffInvitationAuthority(tx, mutation.actor.id, [
      "policy.write",
    ]))
  )
    throw new TeamMutationFailure(
      "forbidden",
      "Your scheduling configuration permission is no longer available.",
    );
  const before = await readStaffResourceConfiguration(tx);
  if (mutation.expectedVersion !== before.version)
    throw new TeamMutationFailure(
      "conflict",
      "Scheduling resources changed. Refresh before saving.",
    );
  if (!input.acknowledgeImpact)
    throw new TeamMutationFailure(
      "invalid",
      "Confirm that existing jobs and holds will need their resource assignments reviewed after this change.",
    );
  const now = new Date();
  let id: string;
  if (input.operation === "resource") {
    if (
      !before.pools.some(
        (pool) => pool.key === input.capacityPoolKey && pool.active,
      )
    )
      throw new TeamMutationFailure(
        "invalid",
        "Choose an active capacity pool.",
      );
    const existing = input.id
      ? before.resources.find(
          (resource) => resource.id === input.id && resource.source === "staff",
        )
      : null;
    if (input.id && !existing)
      throw new TeamMutationFailure(
        "invalid",
        "Choose an existing staff-defined resource. Compatibility pools are maintained by configuration, not renamed as physical crews.",
      );
    if (
      existing &&
      (existing.capacityPoolKey !== input.capacityPoolKey ||
        existing.kind !== input.kind)
    )
      throw new TeamMutationFailure(
        "invalid",
        "A resource's pool and kind cannot change. Deactivate it and create a separate resource.",
      );
    const values = {
      capacityPoolKey: input.capacityPoolKey,
      kind: input.kind,
      label: input.label,
      capacityUnits: input.capacityUnits,
      skillKeys: input.skillKeys,
      active: input.active,
      source: "staff" as const,
      updatedAt: now,
    };
    const [saved] = existing
      ? await tx
          .update(scheduleResources)
          .set(values)
          .where(eq(scheduleResources.id, existing.id))
          .returning({ id: scheduleResources.id })
      : await tx
          .insert(scheduleResources)
          .values(values)
          .returning({ id: scheduleResources.id });
    if (!saved) throw new Error("staff_resource_save_failed");
    id = saved.id;
  } else {
    const profile = before.profiles.find(
      (row) => row.id === input.profileId && row.active,
    );
    if (!profile)
      throw new TeamMutationFailure(
        "invalid",
        "Choose an active scheduling profile.",
      );
    const existing = before.requirements.find(
      (row) =>
        row.schedulingProfileId === profile.id &&
        row.resourceKind === input.resourceKind,
    );
    if (input.operation === "remove_requirement") {
      if (!existing)
        throw new TeamMutationFailure(
          "invalid",
          "This resource requirement no longer exists.",
        );
      await tx
        .delete(partnerSchedulingProfileResourceRequirements)
        .where(
          eq(partnerSchedulingProfileResourceRequirements.id, existing.id),
        );
      return {
        id: existing.id,
        operation: input.operation,
        removedRequirement: existing,
        configuration: await readStaffResourceConfiguration(tx),
        changedAt: now.toISOString(),
      };
    }
    const values = {
      schedulingProfileId: profile.id,
      resourceKind: input.resourceKind,
      quantity: input.quantity,
      capacityUnits: input.capacityUnits,
      requiredSkillKeys: input.requiredSkillKeys,
      source: "staff" as const,
      updatedAt: now,
    };
    const [saved] = existing
      ? await tx
          .update(partnerSchedulingProfileResourceRequirements)
          .set(values)
          .where(
            eq(partnerSchedulingProfileResourceRequirements.id, existing.id),
          )
          .returning({ id: partnerSchedulingProfileResourceRequirements.id })
      : await tx
          .insert(partnerSchedulingProfileResourceRequirements)
          .values(values)
          .returning({ id: partnerSchedulingProfileResourceRequirements.id });
    if (!saved) throw new Error("staff_requirement_save_failed");
    id = saved.id;
  }
  return {
    id,
    operation: input.operation,
    removedRequirement: null,
    configuration: await readStaffResourceConfiguration(tx),
    changedAt: now.toISOString(),
  };
}

export async function readStaffAppointmentResourceOptions(
  appointmentId: string,
) {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ appointment: appointments, job: partnerBookings })
      .from(appointments)
      .leftJoin(
        partnerBookings,
        eq(partnerBookings.appointmentId, appointments.id),
      )
      .where(eq(appointments.id, appointmentId))
      .limit(1);
    if (!row) return null;
    if (!row.job?.partnerAccountId)
      return {
        applicable: false,
        appointmentId,
        resources: [],
        requirements: [],
        selectedResourceIds: [],
        warning: null,
      };
    const now = new Date();
    const [profile] = await tx
      .select()
      .from(partnerSchedulingProfiles)
      .where(
        and(
          eq(partnerSchedulingProfiles.serviceKey, row.job.serviceKey ?? ""),
          eq(partnerSchedulingProfiles.active, true),
          lte(partnerSchedulingProfiles.effectiveFrom, now),
          or(
            isNull(partnerSchedulingProfiles.effectiveTo),
            gt(partnerSchedulingProfiles.effectiveTo, now),
          ),
        ),
      )
      .orderBy(desc(partnerSchedulingProfiles.version))
      .limit(1);
    const resolved = profile
      ? await loadNamedResourcePlan({ tx, profile })
      : null;
    return {
      applicable: true,
      appointmentId,
      profileId: profile?.id ?? null,
      version: row.appointment.updatedAt.toISOString(),
      resources: resolved?.plan?.resources ?? [],
      requirements: resolved?.plan?.requirements ?? [],
      selectedResourceIds: row.appointment.resourceAssignmentSnapshot.map(
        (assignment) => assignment.resourceId,
      ),
      warning: resolved?.plan
        ? null
        : "This service has no complete named-resource configuration. Configure its scheduling profile and requirements before choosing resources.",
    };
  });
}
