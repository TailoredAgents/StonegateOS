import { DateTime } from "luxon";
import { resolveEasternAppointmentTime } from "@/lib/appointment-time";
import {
  and,
  eq,
  inArray,
  isNotNull,
  sql,
  lt,
  gt,
  lte,
  ne,
  isNull,
  or,
  notInArray,
  desc,
} from "drizzle-orm";
import {
  appointments,
  partnerApprovalRequests,
  partnerBookings,
  partnerJobEvents,
  partnerScheduleAssistanceRequests,
  appointmentHolds,
  partnerSchedulingProfiles,
  scheduleResourcePools,
  scheduleBlocks,
  scheduleDateOverrides,
} from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import {
  getBusinessHoursPolicy,
  getBookingRulesPolicy,
  type WeekdayKey,
  type BusinessHoursPolicy,
} from "@/lib/policy";
import {
  loadNamedResourcePlan,
  loadNamedResourceBlocks,
} from "@/lib/scheduling-resource-store";
import {
  groupThirtyMinutePartnerWindows,
  evaluateWeightedScheduleCapacity,
  assignNamedScheduleResources,
  type ScheduleCapacityBlock,
} from "@/lib/scheduling";
import { PartnerPortalSchedulingError } from "@/lib/partner-portal-v2-scheduling/errors";
import { queuePartnerJobAudienceNotification } from "@/lib/partner-notification-delivery";
import { ensurePartnerJobThread } from "@/lib/partner-job-thread";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";

async function assertPartnerStaffCapacity(
  tx: TeamMutationTransaction,
  job: typeof partnerBookings.$inferSelect,
  input: {
    appointmentId: string;
    startAt: Date;
    now: Date;
    durationMinutes?: number;
    travelBufferMinutes?: number;
    selectedResourceIds?: readonly string[];
  },
  timezone: string,
) {
  const [appointment] = await tx
    .select()
    .from(appointments)
    .where(eq(appointments.id, input.appointmentId))
    .limit(1);
  if (!appointment)
    throw new PartnerPortalSchedulingError(
      "not_found",
      "The appointment was not found.",
      { status: 404 },
    );
  const [profile] = job.serviceKey
    ? await tx
        .select()
        .from(partnerSchedulingProfiles)
        .where(
          and(
            eq(partnerSchedulingProfiles.serviceKey, job.serviceKey),
            eq(partnerSchedulingProfiles.active, true),
            lte(partnerSchedulingProfiles.effectiveFrom, input.now),
            or(
              isNull(partnerSchedulingProfiles.effectiveTo),
              gt(partnerSchedulingProfiles.effectiveTo, input.now),
            ),
          ),
        )
        .orderBy(desc(partnerSchedulingProfiles.version))
        .limit(1)
    : [];
  const poolKey = profile?.capacityPoolKey ?? appointment.capacityPoolKey;
  const units = Math.max(
    profile?.capacityUnits ?? 1,
    appointment.capacityUnits,
  );
  const duration = input.durationMinutes ?? appointment.durationMinutes;
  const buffer = input.travelBufferMinutes ?? appointment.travelBufferMinutes;
  if (
    duration < (profile?.durationMinutes ?? appointment.durationMinutes) ||
    buffer <
      Math.max(
        profile?.travelBufferMinutes ?? 0,
        appointment.travelBufferMinutes,
      )
  )
    throw new PartnerPortalSchedulingError(
      "conflict",
      "The selected duration or travel buffer is shorter than this partner service requires.",
      { status: 409 },
    );
  if (poolKey !== appointment.capacityPoolKey)
    throw new PartnerPortalSchedulingError(
      "review_required",
      "The service resource pool changed. Reconcile the service configuration before scheduling.",
      { status: 422 },
    );
  const [pool] = await tx
    .select()
    .from(scheduleResourcePools)
    .where(
      and(
        eq(scheduleResourcePools.key, poolKey),
        eq(scheduleResourcePools.active, true),
      ),
    )
    .limit(1);
  if (!pool)
    throw new PartnerPortalSchedulingError(
      "review_required",
      "Configure this service's capacity pool before confirming.",
      { status: 422 },
    );
  const localDate = DateTime.fromJSDate(input.startAt, {
    zone: timezone,
  }).toISODate()!;
  const [override] = await tx
    .select()
    .from(scheduleDateOverrides)
    .where(
      and(
        eq(scheduleDateOverrides.localDate, localDate),
        eq(scheduleDateOverrides.timezone, timezone),
      ),
    )
    .orderBy(desc(scheduleDateOverrides.revision))
    .limit(1);
  if (override?.closed)
    throw new PartnerPortalSchedulingError(
      "slot_unavailable",
      "This date is closed on Stonegate's schedule.",
      { status: 409 },
    );
  const poolCapacity = Math.min(
    pool.capacityUnits,
    override?.capacityByPool[poolKey] ?? pool.capacityUnits,
  );
  if (poolCapacity <= 0)
    throw new PartnerPortalSchedulingError(
      "slot_unavailable",
      "This date has no configured service capacity.",
      { status: 409 },
    );
  const endAt = new Date(
    input.startAt.getTime() + (duration + buffer) * 60_000,
  );
  let assignments = appointment.resourceAssignmentSnapshot;
  if (profile) {
    const { plan } = await loadNamedResourcePlan({ tx, profile });
    if (!plan)
      throw new PartnerPortalSchedulingError(
        "review_required",
        "Configure this service's crew, truck, and equipment requirements before confirming.",
        { status: 422 },
      );
    const selected = input.selectedResourceIds?.length
      ? [...new Set(input.selectedResourceIds)]
      : null;
    if (
      selected &&
      (selected.length !== input.selectedResourceIds!.length ||
        selected.some(
          (id) => !plan.resources.some((resource) => resource.id === id),
        ))
    )
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "A selected resource is inactive or belongs to another pool. Refresh the resource list.",
        { status: 422 },
      );
    const [resourceBlocks, rules] = await Promise.all([
      loadNamedResourceBlocks({
        tx,
        plan,
        capacityPoolKey: poolKey,
        startAt: input.startAt,
        endAt,
        timezone,
        now: input.now,
        excludeAppointmentId: appointment.id,
        excludeDraftId: job.bookingDraftId,
      }),
      getBookingRulesPolicy(tx),
    ]);
    const assigned = assignNamedScheduleResources({
      capacityPoolKey: poolKey,
      occupancy: { startAt: input.startAt, endAt },
      localDate,
      resources: selected
        ? plan.resources.filter((resource) => selected.includes(resource.id))
        : plan.resources,
      requirements: plan.requirements,
      blocks: resourceBlocks,
      maxJobsPerCrew: rules.maxJobsPerCrew,
    });
    if (!assigned.available)
      throw new PartnerPortalSchedulingError(
        "slot_unavailable",
        "The selected crew or equipment cannot cover this job, or its daily limit is reached. Choose another resource or time.",
        { status: 409 },
      );
    if (
      selected &&
      (assigned.assignments.length !== selected.length ||
        assigned.assignments.some(
          (assignment) => !selected.includes(assignment.resourceId),
        ))
    )
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Select exactly the resources required for this service, or choose automatic assignment.",
        { status: 422 },
      );
    assignments = assigned.assignments.map((assignment) => ({ ...assignment }));
  } else if (input.selectedResourceIds?.length)
    throw new PartnerPortalSchedulingError(
      "review_required",
      "Configure a scheduling profile before choosing named resources.",
      { status: 422 },
    );
  const [jobs, holds, external] = await Promise.all([
    tx
      .select()
      .from(appointments)
      .where(
        and(
          ne(appointments.id, appointment.id),
          notInArray(appointments.status, ["canceled", "completed", "no_show"]),
          eq(appointments.capacityPoolKey, poolKey),
          isNotNull(appointments.startAt),
          lt(appointments.startAt, endAt),
          sql`${appointments.startAt} + (${appointments.durationMinutes} + ${appointments.travelBufferMinutes}) * interval '1 minute' > ${sql.param(input.startAt, appointments.startAt)}`,
        ),
      ),
    tx
      .select()
      .from(appointmentHolds)
      .where(
        and(
          eq(appointmentHolds.capacityPoolKey, poolKey),
          eq(appointmentHolds.status, "active"),
          gt(appointmentHolds.expiresAt, input.now),
          lt(appointmentHolds.startAt, endAt),
          sql`${appointmentHolds.startAt} + (${appointmentHolds.durationMinutes} + ${appointmentHolds.travelBufferMinutes}) * interval '1 minute' > ${sql.param(input.startAt, appointments.startAt)}`,
          job.bookingDraftId
            ? or(
                isNull(appointmentHolds.partnerBookingDraftId),
                ne(appointmentHolds.partnerBookingDraftId, job.bookingDraftId),
              )
            : undefined,
        ),
      ),
    tx
      .select()
      .from(scheduleBlocks)
      .where(
        and(
          eq(scheduleBlocks.capacityPoolKey, poolKey),
          eq(scheduleBlocks.active, true),
          lt(scheduleBlocks.startAt, endAt),
          gt(scheduleBlocks.endAt, input.startAt),
          or(
            isNull(scheduleBlocks.mirroredAppointmentId),
            ne(scheduleBlocks.mirroredAppointmentId, appointment.id),
          ),
        ),
      ),
  ]);
  const blocks: ScheduleCapacityBlock[] = [
    ...jobs.map((row) => ({
      id: `appointment:${row.id}`,
      kind: "appointment" as const,
      capacityPoolKey: poolKey,
      capacityUnits: row.capacityUnits,
      occupancy: {
        startAt: row.startAt!,
        endAt: new Date(
          row.startAt!.getTime() +
            (row.durationMinutes + row.travelBufferMinutes) * 60_000,
        ),
      },
    })),
    ...holds.map((row) => ({
      id: `hold:${row.id}`,
      kind: "hold" as const,
      capacityPoolKey: poolKey,
      capacityUnits: row.capacityUnits,
      occupancy: {
        startAt: row.startAt,
        endAt: new Date(
          row.startAt.getTime() +
            (row.durationMinutes + row.travelBufferMinutes) * 60_000,
        ),
      },
    })),
    ...external.map((row) => ({
      id: `block:${row.id}`,
      kind: "external_busy" as const,
      capacityPoolKey: poolKey,
      capacityUnits: row.capacityUnits,
      occupancy: { startAt: row.startAt, endAt: row.endAt },
    })),
  ];
  const decision = evaluateWeightedScheduleCapacity({
    candidate: {
      capacityPoolKey: poolKey,
      capacityUnits: units,
      occupancy: { startAt: input.startAt, endAt },
    },
    poolCapacityUnits: poolCapacity,
    blocks,
  });
  if (!decision.available)
    throw new PartnerPortalSchedulingError(
      "slot_unavailable",
      "This time does not have enough capacity after travel buffers, active holds, and calendar blocks. Choose another time.",
      { status: 409 },
    );
  await tx
    .update(appointments)
    .set({ capacityUnits: units, resourceAssignmentSnapshot: assignments })
    .where(eq(appointments.id, appointment.id));
  if (job.bookingDraftId)
    await tx
      .update(appointmentHolds)
      .set({ status: "released", updatedAt: input.now })
      .where(
        and(
          eq(appointmentHolds.partnerBookingDraftId, job.bookingDraftId),
          eq(appointmentHolds.status, "active"),
        ),
      );
}

/** The preview and the scheduling transaction share one arrival-window calculation. */
export function partnerStaffArrivalWindow(
  startAt: Date,
  policy: BusinessHoursPolicy,
) {
  const local = DateTime.fromJSDate(startAt, { zone: policy.timezone });
  const windows =
    policy.weekly[local.toFormat("cccc").toLowerCase() as WeekdayKey] ?? [];
  const starts = windows.map(
    (window) =>
      Number(window.start.slice(0, 2)) * 60 + Number(window.start.slice(3)),
  );
  const minute = local.hour * 60 + local.minute;
  // A staff-agreed out-of-hours visit anchors its own window; normal hours use
  // the same operating-day anchor as the partner availability presentation.
  const anchor =
    starts.length && Math.min(...starts) <= minute
      ? Math.min(...starts)
      : minute;
  if (
    !local.isValid ||
    local.second !== 0 ||
    local.millisecond !== 0 ||
    (minute - anchor) % 30 !== 0
  )
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a partner start time on a 30-minute increment.",
      { status: 422 },
    );
  const [window] = groupThirtyMinutePartnerWindows(
    [{ id: "preview", startAt: startAt, available: true }],
    {
      timezone: policy.timezone,
      anchorMinuteByLocalDate: { [local.toISODate()]: anchor },
    },
  );
  if (!window)
    throw new PartnerPortalSchedulingError(
      "invalid_fields",
      "Choose a valid partner arrival time.",
      { status: 422 },
    );
  return window;
}

/** Uses the same Eastern input interpretation as the staff scheduling writer. */
export function partnerStaffArrivalPreview(
  day: string,
  time: string,
  policy: BusinessHoursPolicy,
) {
  const resolved = resolveEasternAppointmentTime(day, time);
  if (!resolved.ok)
    throw new PartnerPortalSchedulingError("invalid_fields", resolved.message, {
      status: 422,
    });
  const window = partnerStaffArrivalWindow(resolved.value, policy);
  return {
    startAt: resolved.value.toISOString(),
    arrivalStartAt: window.startAt.toISOString(),
    arrivalEndAt: window.endAt.toISOString(),
    timezone: policy.timezone,
  };
}

/** Called only inside the CRM's already locked, capacity-checked scheduling transaction. */
export async function synchronizePartnerStaffSchedule(
  tx: TeamMutationTransaction,
  input: {
    appointmentId: string;
    startAt: Date;
    previousStartAt: Date | null;
    now: Date;
    actorTeamMemberId: string | null;
    correlationId: string;
    durationMinutes?: number;
    travelBufferMinutes?: number;
    selectedResourceIds?: readonly string[];
  },
): Promise<boolean> {
  await acquireScheduleConflictLock(tx);
  const [job] = await tx
    .select()
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.appointmentId, input.appointmentId),
        isNotNull(partnerBookings.partnerAccountId),
      ),
    )
    .for("update")
    .limit(1);
  if (!job?.partnerAccountId) return false;
  const accountId = job.partnerAccountId;
  if (["completed", "canceled", "declined"].includes(job.publicStatus))
    throw new PartnerPortalSchedulingError(
      "conflict",
      "This partner request is closed. Use Book again for new work.",
      { status: 409 },
    );
  const [approval] = await tx
    .select({ id: partnerApprovalRequests.id })
    .from(partnerApprovalRequests)
    .where(
      and(
        eq(partnerApprovalRequests.partnerAccountId, accountId),
        eq(partnerApprovalRequests.partnerBookingId, job.id),
        inArray(partnerApprovalRequests.state, [
          "pending",
          "declined",
          "expired",
        ]),
      ),
    )
    .limit(1);
  if (approval || job.publicStatus === "approval_needed")
    throw new PartnerPortalSchedulingError(
      "conflict",
      "Resolve the partner's required approval before confirming service.",
      { status: 409 },
    );
  const policy = await getBusinessHoursPolicy(tx);
  await assertPartnerStaffCapacity(tx, job, input, policy.timezone);
  const window = partnerStaffArrivalWindow(input.startAt, policy);
  if (
    job.publicStatus === "confirmed" &&
    input.previousStartAt?.getTime() === input.startAt.getTime() &&
    job.arrivalWindowStartAt?.getTime() === window.startAt.getTime() &&
    job.arrivalWindowEndAt?.getTime() === window.endAt.getTime()
  )
    return true;
  await tx
    .update(appointments)
    .set({
      promisedArrivalStartAt: window.startAt,
      promisedArrivalEndAt: window.endAt,
      schedulingTimezone: policy.timezone,
    })
    .where(eq(appointments.id, input.appointmentId));
  await tx
    .update(partnerBookings)
    .set({
      publicStatus: "confirmed",
      arrivalWindowStartAt: window.startAt,
      arrivalWindowEndAt: window.endAt,
      requestedReviewReasons: [],
      version: job.version + 1,
      updatedAt: input.now,
    })
    .where(eq(partnerBookings.id, job.id));
  if (input.actorTeamMemberId)
    await tx
      .update(partnerScheduleAssistanceRequests)
      .set({
        state: "fulfilled",
        resolvedByTeamMemberId: input.actorTeamMemberId,
        resolutionNote: "Service scheduled with Stonegate.",
        resolvedAt: input.now,
        revision: sql`${partnerScheduleAssistanceRequests.revision} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(partnerScheduleAssistanceRequests.partnerAccountId, accountId),
          eq(partnerScheduleAssistanceRequests.partnerBookingId, job.id),
          inArray(partnerScheduleAssistanceRequests.state, [
            "pending",
            "contacted",
          ]),
        ),
      );
  await tx.insert(partnerJobEvents).values({
    partnerAccountId: accountId,
    partnerBookingId: job.id,
    eventType: input.previousStartAt ? "job.rescheduled" : "job.confirmed",
    publicLabel: input.previousStartAt
      ? "Arrival window updated by Stonegate"
      : "Service confirmed by Stonegate",
    publicDetail: "Your two-hour arrival window is confirmed.",
    actorType: input.actorTeamMemberId ? "staff" : "system",
    actorTeamMemberId: input.actorTeamMemberId,
    effectiveAt: input.now,
  });
  await ensurePartnerJobThread(tx, accountId, job.id);
  await queuePartnerJobAudienceNotification({
    tx,
    accountId,
    partnerBookingId: job.id,
    eventType: input.previousStartAt
      ? "booking.rescheduled"
      : "booking.created",
    dedupeKey: `staff-schedule:${job.id}:${job.version + 1}`,
    occurredAt: input.now,
    correlationId: input.correlationId,
    accountTimezone: policy.timezone,
    serviceAt: window.startAt,
  });
  return true;
}
