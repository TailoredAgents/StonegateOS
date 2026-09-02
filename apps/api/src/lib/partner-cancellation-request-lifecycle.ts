import { and, eq, sql } from "drizzle-orm";
import {
  appointmentTasks,
  appointments,
  outboxEvents,
  partnerBookings,
  partnerCancellationRequests,
  partnerJobEvents,
  partnerNotifications,
  partnerRescheduleRequests,
  type PartnerCancellationRequestSnapshot,
} from "@/db";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import {
  acquirePartnerJobMutationLock,
  supersedePendingPartnerJobChangeRequestForCancellation,
} from "@/lib/partner-job-change-request-lifecycle";
import { supersedeOfferedPartnerJobChangeOrderForCancellation } from "@/lib/partner-job-change-orders";
import { queuePartnerBookingNotification } from "@/lib/partner-notification-delivery";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const REVIEW_REASON = "cancellation_review_requested";
const CANCELLABLE_PUBLIC_STATUSES = new Set([
  "requested",
  "approval_needed",
  "under_review",
  "confirmed",
  "en_route",
  "in_progress",
]);
const CANCELLABLE_APPOINTMENT_STATUSES = new Set(["requested", "confirmed"]);

export type PartnerCancellationRequestState =
  | "pending"
  | "approved"
  | "declined";

export type PartnerCancellationRequestDecision = "approved" | "declined";

export function createPartnerCancellationRequestSnapshot(input: {
  requestedAt: Date;
  publicStatus: string;
  appointmentStatus: string;
  bookingVersion: number;
  promisedArrivalStartAt: Date | null;
  promisedArrivalEndAt: Date | null;
  timezone: string;
  cutoffMinutes: number;
  directCancellationEnabled: boolean;
  policySource: "launch_default" | "configured" | "unconfigured";
  policyRevision: number | null;
  deadlineAt: string | null;
  decisionReasonCode: string;
}): PartnerCancellationRequestSnapshot {
  if (
    !Number.isSafeInteger(input.bookingVersion) ||
    input.bookingVersion < 1 ||
    !Number.isSafeInteger(input.cutoffMinutes) ||
    input.cutoffMinutes < 0 ||
    input.timezone.trim().length < 1 ||
    input.timezone.length > 100 ||
    input.decisionReasonCode.trim().length < 1 ||
    input.decisionReasonCode.length > 100
  ) {
    throw new Error("partner_cancellation_request_snapshot_invalid");
  }
  return Object.freeze({
    version: 1 as const,
    requestedAt: input.requestedAt.toISOString(),
    job: Object.freeze({
      publicStatus: input.publicStatus,
      appointmentStatus: input.appointmentStatus,
      bookingVersion: input.bookingVersion,
    }),
    schedule: Object.freeze({
      promisedArrivalStartAt:
        input.promisedArrivalStartAt?.toISOString() ?? null,
      promisedArrivalEndAt: input.promisedArrivalEndAt?.toISOString() ?? null,
      timezone: input.timezone,
    }),
    policy: Object.freeze({
      cutoffMinutes: input.cutoffMinutes,
      directCancellationEnabled: input.directCancellationEnabled,
      lateCancellationDisposition: "staff_review" as const,
      automaticFeeMinor: null,
      source: input.policySource,
      revision: input.policyRevision,
      deadlineAt: input.deadlineAt,
      decisionReasonCode: input.decisionReasonCode,
    }),
  });
}

export type StaffCancellationRequestDecisionResult = Readonly<{
  requestId: string;
  partnerAccountId: string;
  partnerBookingId: string;
  state: PartnerCancellationRequestDecision;
  revision: number;
  resolvedAt: Date;
  publicStatus: string;
  bookingVersion: number;
  appointmentStatus: string;
  supersededRescheduleRequestId: string | null;
  supersededChangeRequestId: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}>;

/**
 * Resolve a cancellation review under the global schedule lock. Callers must
 * write the Staff audit through the same transaction before committing.
 */
export async function decidePartnerCancellationRequestAsStaff(
  tx: TeamMutationTransaction,
  input: {
    requestId: string;
    decision: PartnerCancellationRequestDecision;
    reason: string;
    expectedVersion: string;
    teamMemberId: string;
    correlationId: string;
    now?: Date;
  },
): Promise<StaffCancellationRequestDecisionResult> {
  await acquireScheduleConflictLock(tx);
  const [identity] = await tx
    .select({
      accountId: partnerCancellationRequests.partnerAccountId,
      bookingId: partnerCancellationRequests.partnerBookingId,
    })
    .from(partnerCancellationRequests)
    .where(eq(partnerCancellationRequests.id, input.requestId))
    .limit(1);
  if (!identity) {
    throw new TeamMutationFailure(
      "invalid",
      "The cancellation request was not found.",
      { status: 404 },
    );
  }
  await acquirePartnerJobMutationLock(
    tx,
    identity.accountId,
    identity.bookingId,
  );
  const now = input.now ?? new Date();
  const [current] = await tx
    .select({
      requestId: partnerCancellationRequests.id,
      partnerAccountId: partnerCancellationRequests.partnerAccountId,
      partnerBookingId: partnerCancellationRequests.partnerBookingId,
      requestedByMembershipId:
        partnerCancellationRequests.requestedByMembershipId,
      requestState: partnerCancellationRequests.state,
      requestRevision: partnerCancellationRequests.revision,
      requestReason: partnerCancellationRequests.reason,
      requestSnapshot: partnerCancellationRequests.requestSnapshot,
      requestCreatedAt: partnerCancellationRequests.createdAt,
      bookingVersion: partnerBookings.version,
      publicStatus: partnerBookings.publicStatus,
      requestedByBookingMembershipId: partnerBookings.requestedByMembershipId,
      arrivalWindowStartAt: partnerBookings.arrivalWindowStartAt,
      appointmentId: partnerBookings.appointmentId,
      appointmentStatus: appointments.status,
      calendarEventId: appointments.calendarEventId,
    })
    .from(partnerCancellationRequests)
    .innerJoin(
      partnerBookings,
      and(
        eq(
          partnerBookings.partnerAccountId,
          partnerCancellationRequests.partnerAccountId,
        ),
        eq(partnerBookings.id, partnerCancellationRequests.partnerBookingId),
      ),
    )
    .innerJoin(appointments, eq(appointments.id, partnerBookings.appointmentId))
    .where(eq(partnerCancellationRequests.id, input.requestId))
    .for("update")
    .limit(1);
  if (!current) {
    throw new TeamMutationFailure(
      "invalid",
      "The cancellation request was not found.",
      { status: 404 },
    );
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    current.requestRevision,
  );
  if (current.requestState !== "pending") {
    throw new TeamMutationFailure(
      "conflict",
      "This cancellation request was already resolved. Refresh the queue.",
      { status: 409 },
    );
  }

  let supersededRescheduleRequestId: string | null = null;
  let supersededChangeRequestId: string | null = null;
  let nextPublicStatus = current.publicStatus;
  let nextAppointmentStatus = current.appointmentStatus;
  let nextBookingVersion = current.bookingVersion;

  if (
    !CANCELLABLE_PUBLIC_STATUSES.has(current.publicStatus) ||
    !CANCELLABLE_APPOINTMENT_STATUSES.has(current.appointmentStatus)
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The job changed and this review can no longer be resolved safely. Refresh the request.",
      { status: 409 },
    );
  }

  if (input.decision === "approved") {
    const [pendingReschedule] = await tx
      .select({ id: partnerRescheduleRequests.id })
      .from(partnerRescheduleRequests)
      .where(
        and(
          eq(
            partnerRescheduleRequests.partnerAccountId,
            current.partnerAccountId,
          ),
          eq(
            partnerRescheduleRequests.partnerBookingId,
            current.partnerBookingId,
          ),
          eq(partnerRescheduleRequests.state, "pending"),
        ),
      )
      .for("update")
      .limit(1);
    if (pendingReschedule) {
      const [superseded] = await tx
        .update(partnerRescheduleRequests)
        .set({
          state: "superseded",
          resolvedByTeamMemberId: input.teamMemberId,
          resolutionReason:
            "Superseded because Staff approved the cancellation request.",
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerRescheduleRequests.id, pendingReschedule.id),
            eq(partnerRescheduleRequests.state, "pending"),
          ),
        )
        .returning({ id: partnerRescheduleRequests.id });
      if (!superseded) {
        throw new TeamMutationFailure(
          "conflict",
          "The pending schedule change was resolved by another operation. Refresh and retry.",
        );
      }
      supersededRescheduleRequestId = superseded.id;
    }

    const [appointment] = await tx
      .update(appointments)
      .set({ status: "canceled", updatedAt: now })
      .where(
        and(
          eq(appointments.id, current.appointmentId),
          eq(appointments.status, current.appointmentStatus),
        ),
      )
      .returning({
        status: appointments.status,
        updatedAt: appointments.updatedAt,
      });
    if (!appointment) {
      throw new TeamMutationFailure(
        "conflict",
        "The appointment changed while the request was being reviewed. Refresh and retry.",
      );
    }
    nextAppointmentStatus = appointment.status;

    const [booking] = await tx
      .update(partnerBookings)
      .set({
        publicStatus: "canceled",
        requestedReviewReasons: sql`array_remove(${partnerBookings.requestedReviewReasons}, ${REVIEW_REASON})`,
        canceledAt: now,
        version: current.bookingVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerBookings.id, current.partnerBookingId),
          eq(partnerBookings.partnerAccountId, current.partnerAccountId),
          eq(partnerBookings.version, current.bookingVersion),
        ),
      )
      .returning({
        publicStatus: partnerBookings.publicStatus,
        version: partnerBookings.version,
      });
    if (!booking) {
      throw new TeamMutationFailure(
        "conflict",
        "The job changed while the request was being reviewed. Refresh and retry.",
      );
    }
    nextPublicStatus = booking.publicStatus;
    nextBookingVersion = booking.version;

    const supersededChangeRequest =
      await supersedePendingPartnerJobChangeRequestForCancellation(tx, {
        accountId: current.partnerAccountId,
        jobId: current.partnerBookingId,
        actorType: "staff",
        teamMemberId: input.teamMemberId,
        bookingRevisionBefore: current.bookingVersion,
        bookingRevisionAfter: booking.version,
        correlationId: input.correlationId,
        now,
      });
    supersededChangeRequestId = supersededChangeRequest?.requestId ?? null;
    await supersedeOfferedPartnerJobChangeOrderForCancellation(tx, {
      partnerAccountId: current.partnerAccountId,
      partnerBookingId: current.partnerBookingId,
      bookingRevisionBefore: current.bookingVersion,
      bookingRevisionAfter: booking.version,
      correlationId: input.correlationId,
      now,
    });

    await tx.insert(partnerJobEvents).values({
      partnerAccountId: current.partnerAccountId,
      partnerBookingId: current.partnerBookingId,
      eventType: "job.cancellation_request_approved",
      publicLabel: "Cancellation approved",
      publicDetail:
        "Stonegate approved the cancellation request. This job is canceled.",
      effectiveAt: now,
      actorType: "staff",
      actorTeamMemberId: input.teamMemberId,
      metadata: { cancellationRequestId: current.requestId },
      createdAt: now,
    });
    await queuePartnerBookingNotification({
      tx,
      accountId: current.partnerAccountId,
      membershipId: current.requestedByMembershipId,
      fallbackMembershipId: current.requestedByBookingMembershipId,
      partnerBookingId: current.partnerBookingId,
      eventType: "booking.canceled",
      dedupeKey: `cancellation-request-approved:${current.requestId}:${current.requestRevision + 1}`,
      correlationId: input.correlationId,
      occurredAt: now,
      accountTimezone: current.requestSnapshot.schedule.timezone,
      serviceAt: current.arrivalWindowStartAt,
    });
    await tx.insert(outboxEvents).values({
      type: "estimate.status_changed",
      payload: {
        appointmentId: current.appointmentId,
        status: "canceled",
        statusChanged: true,
        customerNotificationRequested: false,
        version: now.toISOString(),
      },
      createdAt: now,
    });
    if (current.calendarEventId) {
      await tx.insert(outboxEvents).values({
        type: "appointment.calendar_sync_requested",
        payload: {
          appointmentId: current.appointmentId,
          version: now.toISOString(),
          reason: "partner.cancellation_request.approved",
          requestedCalendarEventId: current.calendarEventId,
          correlationId: input.correlationId,
        },
        createdAt: now,
      });
    }
  } else {
    const [booking] = await tx
      .update(partnerBookings)
      .set({
        cancelOperationKeyHash: null,
        cancelRequestHash: null,
        requestedReviewReasons: sql`array_remove(${partnerBookings.requestedReviewReasons}, ${REVIEW_REASON})`,
        version: current.bookingVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerBookings.id, current.partnerBookingId),
          eq(partnerBookings.partnerAccountId, current.partnerAccountId),
          eq(partnerBookings.version, current.bookingVersion),
        ),
      )
      .returning({
        publicStatus: partnerBookings.publicStatus,
        version: partnerBookings.version,
      });
    if (!booking) {
      throw new TeamMutationFailure(
        "conflict",
        "The job changed while the request was being reviewed. Refresh and retry.",
      );
    }
    nextPublicStatus = booking.publicStatus;
    nextBookingVersion = booking.version;
    await tx.insert(partnerJobEvents).values({
      partnerAccountId: current.partnerAccountId,
      partnerBookingId: current.partnerBookingId,
      eventType: "job.cancellation_request_declined",
      publicLabel: "Cancellation request declined",
      publicDetail:
        "Stonegate declined the cancellation request. The existing schedule remains in place.",
      effectiveAt: now,
      actorType: "staff",
      actorTeamMemberId: input.teamMemberId,
      metadata: { cancellationRequestId: current.requestId },
      createdAt: now,
    });
    await tx.insert(partnerNotifications).values({
      partnerAccountId: current.partnerAccountId,
      membershipId: current.requestedByMembershipId,
      partnerBookingId: current.partnerBookingId,
      eventKey: "job.cancellation_request_declined",
      title: "Cancellation request declined",
      body: "The existing schedule remains in place. Open the job for current details.",
      actionPath: `/partners/bookings/${current.partnerBookingId}`,
      createdAt: now,
    });
  }

  const [resolved] = await tx
    .update(partnerCancellationRequests)
    .set({
      state: input.decision,
      revision: current.requestRevision + 1,
      resolvedByTeamMemberId: input.teamMemberId,
      resolutionReason: input.reason,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerCancellationRequests.id, current.requestId),
        eq(
          partnerCancellationRequests.partnerAccountId,
          current.partnerAccountId,
        ),
        eq(partnerCancellationRequests.state, "pending"),
        eq(partnerCancellationRequests.revision, current.requestRevision),
      ),
    )
    .returning({
      state: partnerCancellationRequests.state,
      revision: partnerCancellationRequests.revision,
      resolvedAt: partnerCancellationRequests.resolvedAt,
    });
  if (!resolved?.resolvedAt) {
    throw new TeamMutationFailure(
      "conflict",
      "Another reviewer resolved this request first. Refresh the queue.",
    );
  }

  const reviewTaskTitle = `Review partner cancellation request ${current.requestId
    .slice(0, 8)
    .toUpperCase()} · job ${current.partnerBookingId.slice(0, 8).toUpperCase()}`;
  await tx
    .update(appointmentTasks)
    .set({ status: "completed", updatedAt: now })
    .where(
      and(
        eq(appointmentTasks.appointmentId, current.appointmentId),
        eq(appointmentTasks.status, "open"),
        eq(appointmentTasks.title, reviewTaskTitle),
      ),
    );

  await tx.insert(outboxEvents).values({
    type: "partner.cancellation_request.resolved",
    payload: {
      partnerAccountId: current.partnerAccountId,
      partnerBookingId: current.partnerBookingId,
      cancellationRequestId: current.requestId,
      state: input.decision,
      revision: resolved.revision,
      correlationId: input.correlationId,
    },
    createdAt: now,
  });

  return Object.freeze({
    requestId: current.requestId,
    partnerAccountId: current.partnerAccountId,
    partnerBookingId: current.partnerBookingId,
    state: input.decision,
    revision: resolved.revision,
    resolvedAt: resolved.resolvedAt,
    publicStatus: nextPublicStatus,
    bookingVersion: nextBookingVersion,
    appointmentStatus: nextAppointmentStatus,
    supersededRescheduleRequestId,
    supersededChangeRequestId,
    before: {
      state: current.requestState,
      revision: current.requestRevision,
      publicStatus: current.publicStatus,
      bookingVersion: current.bookingVersion,
      appointmentStatus: current.appointmentStatus,
    },
    after: {
      state: input.decision,
      revision: resolved.revision,
      publicStatus: nextPublicStatus,
      bookingVersion: nextBookingVersion,
      appointmentStatus: nextAppointmentStatus,
      supersededChangeRequestId,
    },
  });
}
