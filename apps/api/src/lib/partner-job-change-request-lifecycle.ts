import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  appointments,
  auditLogs,
  outboxEvents,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerBookings,
  partnerCancellationRequests,
  partnerJobChangeRequests,
  partnerJobEvents,
  partnerNotifications,
  type PartnerJobChangeProposedChanges,
} from "@/db";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import {
  applyApprovedPartnerJobPublicChanges,
  createPartnerJobChangeRequestSnapshot,
  PartnerJobChangeRequestBodySchema,
  partnerJobChangeRequiresChangeOrder,
  partnerJobChangeSnapshotStillMatches,
  type PartnerJobChangeRequestBody,
  type PartnerJobReferencesBody,
} from "@/lib/partner-job-change-requests";
import { createPartnerJobChangeOrderOffer } from "@/lib/partner-job-change-orders";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  evaluatePortalV2RevisionPrecondition,
  createPortalV2StrongEtag,
} from "@/lib/portal-v2-contract";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const TERMINAL_JOB_STATUSES = new Set(["completed", "canceled", "declined"]);
const TERMINAL_APPOINTMENT_STATUSES = new Set([
  "completed",
  "canceled",
  "no_show",
]);

export type PartnerJobChangeRequestDecision =
  | "approved"
  | "declined"
  | "change_order_required";

export type PartnerJobChangeRequestState =
  | "pending"
  | PartnerJobChangeRequestDecision
  | "superseded";

export class PartnerJobChangeRequestError extends Error {
  readonly code:
    | "not_found"
    | "conflict"
    | "idempotency_conflict"
    | "revision_mismatch";
  readonly status: 404 | 409 | 412;

  constructor(
    code: PartnerJobChangeRequestError["code"],
    status: PartnerJobChangeRequestError["status"],
    message: string,
  ) {
    super(message);
    this.name = "PartnerJobChangeRequestError";
    this.code = code;
    this.status = status;
  }
}

export async function acquirePartnerJobMutationLock(
  tx: TeamMutationTransaction,
  accountId: string,
  jobId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`partner_job_public_change_v1:${accountId}:${jobId}`}, 0))`,
  );
}

function assertCurrentPartnerRevision(input: {
  ifMatch: string | null;
  jobId: string;
  version: number;
  updatedAt: Date;
  correlationId: string;
}): void {
  const currentRevision = `${input.jobId}:${input.version}:${input.updatedAt.toISOString()}`;
  const result = evaluatePortalV2RevisionPrecondition({
    ifMatch: input.ifMatch,
    currentRevision,
    correlationId: input.correlationId,
  });
  if (!result.ok) {
    throw new PartnerJobChangeRequestError(
      "revision_mismatch",
      412,
      "The job changed. Refresh it before trying again.",
    );
  }
}

function isJobTerminal(
  publicStatus: string,
  appointmentStatus: string,
): boolean {
  return (
    TERMINAL_JOB_STATUSES.has(publicStatus) ||
    TERMINAL_APPOINTMENT_STATUSES.has(appointmentStatus)
  );
}

function proposedChangesForPersistence(
  proposed: PartnerJobChangeRequestBody["proposedChanges"],
): PartnerJobChangeProposedChanges {
  return Object.freeze({ version: 1 as const, ...proposed });
}

export type PartnerJobChangeRequestCreateResult = Readonly<{
  requestId: string;
  state: PartnerJobChangeRequestState;
  requestRevision: number;
  bookingRevision: number;
  bookingUpdatedAt: Date;
  createdAt: Date;
  resolution: Readonly<{
    outcome: Exclude<PartnerJobChangeRequestState, "pending">;
    resolvedAt: Date;
  }> | null;
  replayed: boolean;
}>;

/** Creates one immutable review request under the account/job lock. */
export async function createPartnerJobChangeRequest(
  tx: TeamMutationTransaction,
  input: {
    principal: PartnerPrincipal;
    jobId: string;
    payload: PartnerJobChangeRequestBody;
    operationKeyHash: string;
    requestHash: string;
    ifMatch: string | null;
    correlationId: string;
    now?: Date;
  },
): Promise<PartnerJobChangeRequestCreateResult> {
  const accountId = input.principal.accountId;
  const membershipId = input.principal.membershipId;
  if (!accountId || !membershipId) {
    throw new PartnerJobChangeRequestError(
      "not_found",
      404,
      "The job was not found.",
    );
  }
  await acquireScheduleConflictLock(tx);
  await acquirePartnerJobMutationLock(tx, accountId, input.jobId);
  const [job] = await tx
    .select({
      id: partnerBookings.id,
      publicStatus: partnerBookings.publicStatus,
      scopeSnapshot: partnerBookings.scopeSnapshot,
      version: partnerBookings.version,
      updatedAt: partnerBookings.updatedAt,
      appointmentStatus: appointments.status,
    })
    .from(partnerBookings)
    .innerJoin(appointments, eq(partnerBookings.appointmentId, appointments.id))
    .innerJoin(
      partnerAccountMemberships,
      and(
        eq(partnerAccountMemberships.id, membershipId),
        eq(partnerAccountMemberships.partnerAccountId, accountId),
        eq(partnerAccountMemberships.status, "active"),
      ),
    )
    .leftJoin(partnerAccountLocations, createPartnerJobLocationJoinCondition())
    .where(createPartnerJobAccessCondition(input.principal, input.jobId))
    .for("update", { of: partnerBookings })
    .limit(1);
  if (!job) {
    throw new PartnerJobChangeRequestError(
      "not_found",
      404,
      "The job was not found.",
    );
  }

  const [replay] = await tx
    .select({
      id: partnerJobChangeRequests.id,
      partnerBookingId: partnerJobChangeRequests.partnerBookingId,
      requestHash: partnerJobChangeRequests.requestHash,
      state: partnerJobChangeRequests.state,
      revision: partnerJobChangeRequests.revision,
      resolvedAt: partnerJobChangeRequests.resolvedAt,
      createdAt: partnerJobChangeRequests.createdAt,
    })
    .from(partnerJobChangeRequests)
    .where(
      and(
        eq(partnerJobChangeRequests.partnerAccountId, accountId),
        eq(partnerJobChangeRequests.operationKeyHash, input.operationKeyHash),
      ),
    )
    .for("update")
    .limit(1);
  if (replay) {
    if (
      replay.partnerBookingId !== job.id ||
      replay.requestHash !== input.requestHash
    ) {
      throw new PartnerJobChangeRequestError(
        "idempotency_conflict",
        409,
        "That idempotency key was used for a different request.",
      );
    }
    const resolution =
      replay.state !== "pending" && replay.resolvedAt
        ? Object.freeze({
            outcome: replay.state,
            resolvedAt: replay.resolvedAt,
          })
        : null;
    return Object.freeze({
      requestId: replay.id,
      state: replay.state,
      requestRevision: replay.revision,
      bookingRevision: job.version,
      bookingUpdatedAt: job.updatedAt,
      createdAt: replay.createdAt,
      resolution,
      replayed: true,
    });
  }

  assertCurrentPartnerRevision({
    ifMatch: input.ifMatch,
    jobId: job.id,
    version: job.version,
    updatedAt: job.updatedAt,
    correlationId: input.correlationId,
  });
  if (isJobTerminal(job.publicStatus, job.appointmentStatus)) {
    throw new PartnerJobChangeRequestError(
      "conflict",
      409,
      "Closed jobs cannot accept change requests.",
    );
  }
  const [pendingCancellation] = await tx
    .select({ id: partnerCancellationRequests.id })
    .from(partnerCancellationRequests)
    .where(
      and(
        eq(partnerCancellationRequests.partnerAccountId, accountId),
        eq(partnerCancellationRequests.partnerBookingId, job.id),
        eq(partnerCancellationRequests.state, "pending"),
      ),
    )
    .limit(1);
  if (pendingCancellation) {
    throw new PartnerJobChangeRequestError(
      "conflict",
      409,
      "A cancellation request is already under review.",
    );
  }
  const [pending] = await tx
    .select({ id: partnerJobChangeRequests.id })
    .from(partnerJobChangeRequests)
    .where(
      and(
        eq(partnerJobChangeRequests.partnerAccountId, accountId),
        eq(partnerJobChangeRequests.partnerBookingId, job.id),
        eq(partnerJobChangeRequests.state, "pending"),
      ),
    )
    .for("update")
    .limit(1);
  if (pending) {
    throw new PartnerJobChangeRequestError(
      "conflict",
      409,
      "A job change request is already under review.",
    );
  }

  const now = input.now ?? new Date();
  const proposedChanges = proposedChangesForPersistence(
    input.payload.proposedChanges,
  );
  const snapshot = createPartnerJobChangeRequestSnapshot({
    requestedAt: now,
    publicStatus: job.publicStatus,
    appointmentStatus: job.appointmentStatus,
    bookingRevision: job.version,
    scopeSnapshot: job.scopeSnapshot,
    proposedChanges: input.payload.proposedChanges,
  });
  const [created] = await tx
    .insert(partnerJobChangeRequests)
    .values({
      partnerAccountId: accountId,
      partnerBookingId: job.id,
      requestedByMembershipId: membershipId,
      state: "pending",
      reason: input.payload.reason,
      proposedChanges,
      requestSnapshot: snapshot,
      baseBookingRevision: job.version,
      operationKeyHash: input.operationKeyHash,
      requestHash: input.requestHash,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning({
      id: partnerJobChangeRequests.id,
      revision: partnerJobChangeRequests.revision,
      createdAt: partnerJobChangeRequests.createdAt,
    });
  if (!created) throw new Error("partner_job_change_request_create_failed");

  const [updatedJob] = await tx
    .update(partnerBookings)
    .set({ version: job.version + 1, updatedAt: now })
    .where(
      and(
        eq(partnerBookings.partnerAccountId, accountId),
        eq(partnerBookings.id, job.id),
        eq(partnerBookings.version, job.version),
      ),
    )
    .returning({
      version: partnerBookings.version,
      updatedAt: partnerBookings.updatedAt,
    });
  if (!updatedJob) {
    throw new PartnerJobChangeRequestError(
      "conflict",
      409,
      "The job changed while the request was being saved.",
    );
  }

  const [event] = await tx
    .insert(partnerJobEvents)
    .values({
      partnerAccountId: accountId,
      partnerBookingId: job.id,
      eventType: "job.change_requested",
      publicLabel: "Service change requested",
      publicDetail:
        "Stonegate will review the request. The current price, proof, and service time stay unchanged for now.",
      effectiveAt: now,
      actorType: "partner",
      actorMembershipId: membershipId,
      metadata: {
        changeRequestId: created.id,
        changeOrderReviewRequired: partnerJobChangeRequiresChangeOrder(
          input.payload.proposedChanges,
        ),
      },
      createdAt: now,
    })
    .returning({ id: partnerJobEvents.id });
  if (!event) throw new Error("partner_job_change_request_event_failed");
  await tx.insert(partnerNotifications).values({
    partnerAccountId: accountId,
    membershipId,
    partnerBookingId: job.id,
    eventKey: "job.change_requested",
    title: "Service change request received",
    body: "The current service details stay in place while Stonegate reviews your request.",
    actionPath: `/partners/bookings/${job.id}`,
    createdAt: now,
  });

  const auditId = randomUUID();
  await tx.insert(auditLogs).values({
    id: auditId,
    actorType: "human",
    actorId: input.principal.partnerUserId,
    actorLabel: input.principal.email,
    actorRole: input.principal.roleKey,
    sessionId: input.principal.session.id,
    authMethod: "partner_session",
    correlationId: input.correlationId,
    requiredPermissions: ["jobs.change_request"],
    outcome: "succeeded",
    surface: "/partners/jobs",
    idempotencyKeyHash: input.operationKeyHash,
    action: "partner.job.change_requested",
    entityType: "partner_job_change_request",
    entityId: created.id,
    meta: sanitizeAuditMetadata({
      eventId: auditId,
      correlationId: input.correlationId,
      partnerAccountId: accountId,
      partnerMembershipId: membershipId,
      partnerBookingId: job.id,
      changeRequestId: created.id,
      proposedFields: Object.keys(input.payload.proposedChanges).filter(
        (key) => key !== "materiality",
      ),
      materiality: input.payload.proposedChanges.materiality,
      before: { bookingRevision: job.version },
      after: {
        bookingRevision: updatedJob.version,
        changeRequestPending: true,
      },
    }),
    createdAt: now,
  });
  await tx.insert(outboxEvents).values({
    type: "partner.job_change_request.requested",
    payload: {
      partnerAccountId: accountId,
      partnerBookingId: job.id,
      changeRequestId: created.id,
      partnerJobEventId: event.id,
      sourceAuditEventId: auditId,
      correlationId: input.correlationId,
    },
    createdAt: now,
  });

  return Object.freeze({
    requestId: created.id,
    state: "pending" as const,
    requestRevision: created.revision,
    bookingRevision: updatedJob.version,
    bookingUpdatedAt: updatedJob.updatedAt,
    createdAt: created.createdAt,
    resolution: null,
    replayed: false,
  });
}

export type SupersededPartnerJobChangeRequestResult = Readonly<{
  requestId: string;
  revision: number;
  resolvedAt: Date;
}>;

/**
 * Closes a pending change request when its job is canceled. The cancellation
 * and this resolution must commit together; the helper re-acquires both
 * advisory locks so future callers cannot accidentally omit either one.
 */
export async function supersedePendingPartnerJobChangeRequestForCancellation(
  tx: TeamMutationTransaction,
  input:
    | Readonly<{
        accountId: string;
        jobId: string;
        actorType: "system";
        triggeringMembershipId: string;
        bookingRevisionBefore: number;
        bookingRevisionAfter: number;
        correlationId: string;
        now: Date;
      }>
    | Readonly<{
        accountId: string;
        jobId: string;
        actorType: "staff";
        teamMemberId: string;
        bookingRevisionBefore: number;
        bookingRevisionAfter: number;
        correlationId: string;
        now: Date;
      }>,
): Promise<SupersededPartnerJobChangeRequestResult | null> {
  if (
    input.bookingRevisionBefore < 1 ||
    input.bookingRevisionAfter <= input.bookingRevisionBefore
  ) {
    throw new Error("partner_job_change_cancellation_revision_invalid");
  }
  await acquireScheduleConflictLock(tx);
  await acquirePartnerJobMutationLock(tx, input.accountId, input.jobId);
  const [pending] = await tx
    .select({
      id: partnerJobChangeRequests.id,
      requestedByMembershipId: partnerJobChangeRequests.requestedByMembershipId,
      revision: partnerJobChangeRequests.revision,
    })
    .from(partnerJobChangeRequests)
    .where(
      and(
        eq(partnerJobChangeRequests.partnerAccountId, input.accountId),
        eq(partnerJobChangeRequests.partnerBookingId, input.jobId),
        eq(partnerJobChangeRequests.state, "pending"),
      ),
    )
    .for("update")
    .limit(1);
  if (!pending) return null;

  const trigger =
    input.actorType === "system"
      ? ("partner_direct_cancellation" as const)
      : ("staff_approved_cancellation" as const);
  const resolutionReason =
    input.actorType === "system"
      ? "Superseded automatically because the Partner directly canceled the job."
      : "Superseded because Staff approved the job cancellation.";
  const resolutionSnapshot = Object.freeze({
    version: 1 as const,
    outcome: "superseded" as const,
    actorType: input.actorType,
    trigger,
    ...(input.actorType === "system"
      ? { triggeringMembershipId: input.triggeringMembershipId }
      : {}),
    bookingRevisionBefore: input.bookingRevisionBefore,
    bookingRevisionAfter: input.bookingRevisionAfter,
  });
  const [resolved] = await tx
    .update(partnerJobChangeRequests)
    .set({
      state: "superseded",
      revision: pending.revision + 1,
      resolvedByTeamMemberId:
        input.actorType === "staff" ? input.teamMemberId : null,
      resolutionReason,
      resolutionSnapshot,
      resolvedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(partnerJobChangeRequests.id, pending.id),
        eq(partnerJobChangeRequests.partnerAccountId, input.accountId),
        eq(partnerJobChangeRequests.partnerBookingId, input.jobId),
        eq(partnerJobChangeRequests.state, "pending"),
        eq(partnerJobChangeRequests.revision, pending.revision),
      ),
    )
    .returning({
      revision: partnerJobChangeRequests.revision,
      resolvedAt: partnerJobChangeRequests.resolvedAt,
    });
  if (!resolved?.resolvedAt) {
    throw new TeamMutationFailure(
      "conflict",
      "The pending job change was resolved by another operation. Refresh and retry.",
      { status: 409 },
    );
  }

  const [event] = await tx
    .insert(partnerJobEvents)
    .values({
      partnerAccountId: input.accountId,
      partnerBookingId: input.jobId,
      eventType: "job.change_request_superseded",
      publicLabel: "Service change request closed",
      publicDetail:
        "The service was canceled, so the pending change request was closed without being applied.",
      effectiveAt: input.now,
      actorType: input.actorType,
      actorTeamMemberId:
        input.actorType === "staff" ? input.teamMemberId : null,
      metadata: {
        changeRequestId: pending.id,
        resolutionTrigger: trigger,
      },
      createdAt: input.now,
    })
    .returning({ id: partnerJobEvents.id });
  if (!event) throw new Error("partner_job_change_superseded_event_failed");
  await tx.insert(partnerNotifications).values({
    partnerAccountId: input.accountId,
    membershipId: pending.requestedByMembershipId,
    partnerBookingId: input.jobId,
    eventKey: "job.change_request_superseded",
    title: "Service change request closed",
    body: "The service was canceled, so the pending change request was closed without being applied.",
    actionPath: `/partners/bookings/${input.jobId}`,
    createdAt: input.now,
  });
  await tx.insert(outboxEvents).values({
    type: "partner.job_change_request.resolved",
    payload: {
      partnerAccountId: input.accountId,
      partnerBookingId: input.jobId,
      changeRequestId: pending.id,
      state: "superseded",
      revision: resolved.revision,
      partnerJobEventId: event.id,
      correlationId: input.correlationId,
    },
    createdAt: input.now,
  });

  return Object.freeze({
    requestId: pending.id,
    revision: resolved.revision,
    resolvedAt: resolved.resolvedAt,
  });
}

export type StaffPartnerJobChangeDecisionResult = Readonly<{
  requestId: string;
  partnerAccountId: string;
  partnerBookingId: string;
  state: PartnerJobChangeRequestDecision;
  revision: number;
  resolvedAt: Date;
  bookingRevision: number;
  publicStatus: string;
  appliedFields: readonly string[];
  changeOrder: Readonly<{
    id: string;
    partnerQuoteId: string;
    amountMinor: number;
    currency: string;
  }> | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}>;

/** Resolves one request once under a Staff-authenticated transaction. */
export async function decidePartnerJobChangeRequestAsStaff(
  tx: TeamMutationTransaction,
  input: {
    requestId: string;
    decision: PartnerJobChangeRequestDecision;
    reason: string;
    expectedVersion: string;
    partnerQuoteId?: string | null;
    teamMemberId: string;
    correlationId: string;
    now?: Date;
  },
): Promise<StaffPartnerJobChangeDecisionResult> {
  const [identity] = await tx
    .select({
      accountId: partnerJobChangeRequests.partnerAccountId,
      bookingId: partnerJobChangeRequests.partnerBookingId,
    })
    .from(partnerJobChangeRequests)
    .where(eq(partnerJobChangeRequests.id, input.requestId))
    .limit(1);
  if (!identity) {
    throw new TeamMutationFailure(
      "invalid",
      "The change request was not found.",
      {
        status: 404,
      },
    );
  }
  await acquireScheduleConflictLock(tx);
  await acquirePartnerJobMutationLock(
    tx,
    identity.accountId,
    identity.bookingId,
  );
  const [current] = await tx
    .select({
      requestId: partnerJobChangeRequests.id,
      partnerAccountId: partnerJobChangeRequests.partnerAccountId,
      partnerBookingId: partnerJobChangeRequests.partnerBookingId,
      requestedByMembershipId: partnerJobChangeRequests.requestedByMembershipId,
      requestState: partnerJobChangeRequests.state,
      requestRevision: partnerJobChangeRequests.revision,
      reason: partnerJobChangeRequests.reason,
      proposedChanges: partnerJobChangeRequests.proposedChanges,
      requestSnapshot: partnerJobChangeRequests.requestSnapshot,
      publicStatus: partnerBookings.publicStatus,
      scopeSnapshot: partnerBookings.scopeSnapshot,
      bookingRevision: partnerBookings.version,
      appointmentStatus: appointments.status,
    })
    .from(partnerJobChangeRequests)
    .innerJoin(
      partnerBookings,
      and(
        eq(
          partnerBookings.partnerAccountId,
          partnerJobChangeRequests.partnerAccountId,
        ),
        eq(partnerBookings.id, partnerJobChangeRequests.partnerBookingId),
      ),
    )
    .innerJoin(appointments, eq(appointments.id, partnerBookings.appointmentId))
    .where(eq(partnerJobChangeRequests.id, input.requestId))
    .for("update")
    .limit(1);
  if (!current) {
    throw new TeamMutationFailure(
      "invalid",
      "The change request was not found.",
      {
        status: 404,
      },
    );
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    current.requestRevision,
  );
  if (current.requestState !== "pending") {
    throw new TeamMutationFailure(
      "conflict",
      "This change request was already resolved. Refresh the queue.",
      { status: 409 },
    );
  }
  if (input.decision === "change_order_required" && !input.partnerQuoteId) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose the issued Quote V2 that contains the fixed change-order price.",
      {
        status: 422,
        fieldErrors: { partnerQuoteId: "Choose an issued job quote." },
      },
    );
  }
  if (input.decision !== "change_order_required" && input.partnerQuoteId) {
    throw new TeamMutationFailure(
      "invalid",
      "A quote may be attached only when a change order is required.",
      { status: 422, fieldErrors: { partnerQuoteId: "Clear the quote." } },
    );
  }
  if (
    input.decision === "approved" &&
    isJobTerminal(current.publicStatus, current.appointmentStatus)
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The job is now closed, so the requested changes cannot be applied. Decline the request or mark it change-order required to close the review.",
      { status: 409 },
    );
  }

  const { version: _version, ...proposed } = current.proposedChanges;
  const parsedEvidence = PartnerJobChangeRequestBodySchema.safeParse({
    reason: current.reason,
    proposedChanges: proposed,
  });
  if (!parsedEvidence.success) {
    throw new TeamMutationFailure(
      "conflict",
      "The stored change evidence failed validation and requires containment.",
      { status: 409 },
    );
  }
  const requiresChangeOrder = partnerJobChangeRequiresChangeOrder(
    parsedEvidence.data.proposedChanges,
  );
  if (input.decision === "approved" && requiresChangeOrder) {
    throw new TeamMutationFailure(
      "invalid",
      "This request affects price, schedule, service, quantity, hazards, or proof. Resolve it as change-order required instead.",
      { status: 422 },
    );
  }
  if (
    input.decision === "approved" &&
    !partnerJobChangeSnapshotStillMatches(
      current.requestSnapshot,
      current.scopeSnapshot,
    )
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The job’s public scope changed after this request. Refresh and route it to change-order review or decline it.",
      { status: 409 },
    );
  }

  const now = input.now ?? new Date();
  const nextScope =
    input.decision === "approved"
      ? applyApprovedPartnerJobPublicChanges({
          scopeSnapshot: current.scopeSnapshot,
          proposed: parsedEvidence.data.proposedChanges,
        })
      : current.scopeSnapshot;
  const appliedFields =
    input.decision === "approved"
      ? (
          [
            "description",
            "crewInstructions",
            "accessDetails",
            "onSiteContact",
          ] as const
        ).filter((key) =>
          Object.hasOwn(parsedEvidence.data.proposedChanges, key),
        )
      : [];
  const [updatedJob] = await tx
    .update(partnerBookings)
    .set({
      ...(input.decision === "approved" ? { scopeSnapshot: nextScope } : {}),
      version: current.bookingRevision + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerBookings.partnerAccountId, current.partnerAccountId),
        eq(partnerBookings.id, current.partnerBookingId),
        eq(partnerBookings.version, current.bookingRevision),
      ),
    )
    .returning({
      version: partnerBookings.version,
      publicStatus: partnerBookings.publicStatus,
    });
  if (!updatedJob) {
    throw new TeamMutationFailure(
      "conflict",
      "The job changed while the request was being resolved. Refresh the queue.",
      { status: 409 },
    );
  }

  const changeOrder =
    input.decision === "change_order_required" && input.partnerQuoteId
      ? await createPartnerJobChangeOrderOffer(tx, {
          partnerAccountId: current.partnerAccountId,
          partnerBookingId: current.partnerBookingId,
          partnerJobChangeRequestId: current.requestId,
          partnerQuoteId: input.partnerQuoteId,
          bookingRevision: updatedJob.version,
          offeredByTeamMemberId: input.teamMemberId,
          now,
        })
      : null;

  const resolutionSnapshot = Object.freeze({
    version: 1 as const,
    outcome: input.decision,
    appliedFields,
    bookingRevisionBefore: current.bookingRevision,
    bookingRevisionAfter: updatedJob.version,
    ...(changeOrder
      ? {
          changeOrderId: changeOrder.id,
          partnerQuoteId: changeOrder.snapshot.partnerQuoteId,
          quoteVersionId: changeOrder.snapshot.quoteVersionId,
          amountMinor: changeOrder.snapshot.amountMinor,
          currency: changeOrder.snapshot.currency,
        }
      : {}),
  });
  const [resolved] = await tx
    .update(partnerJobChangeRequests)
    .set({
      state: input.decision,
      revision: current.requestRevision + 1,
      resolvedByTeamMemberId: input.teamMemberId,
      resolutionReason: input.reason,
      resolutionSnapshot,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerJobChangeRequests.id, current.requestId),
        eq(partnerJobChangeRequests.state, "pending"),
        eq(partnerJobChangeRequests.revision, current.requestRevision),
      ),
    )
    .returning({
      state: partnerJobChangeRequests.state,
      revision: partnerJobChangeRequests.revision,
      resolvedAt: partnerJobChangeRequests.resolvedAt,
    });
  if (!resolved?.resolvedAt) {
    throw new TeamMutationFailure(
      "conflict",
      "Another reviewer resolved this request first. Refresh the queue.",
      { status: 409 },
    );
  }

  const publicCopy =
    input.decision === "approved"
      ? {
          eventType: "job.change_request_approved",
          label: "Service change approved",
          detail:
            "Stonegate approved the requested service details. Price, schedule, and proof requirements were not changed.",
          title: "Service change approved",
          body: "The approved details are now visible on the job.",
        }
      : input.decision === "declined"
        ? {
            eventType: "job.change_request_declined",
            label: "Service change declined",
            detail:
              "Stonegate declined the request. The current service details stay unchanged.",
            title: "Service change request declined",
            body: "The current service details stay unchanged.",
          }
        : {
            eventType: "job.change_order_required",
            label: "Change order required",
            detail:
              "Stonegate needs to review pricing or scheduling before this change can be accepted. The current service details stay unchanged.",
            title: "Change order required",
            body: "The current service details stay unchanged while Stonegate prepares the next step.",
          };
  await tx.insert(partnerJobEvents).values({
    partnerAccountId: current.partnerAccountId,
    partnerBookingId: current.partnerBookingId,
    eventType: publicCopy.eventType,
    publicLabel: publicCopy.label,
    publicDetail: publicCopy.detail,
    effectiveAt: now,
    actorType: "staff",
    actorTeamMemberId: input.teamMemberId,
    metadata: {
      changeRequestId: current.requestId,
      ...(changeOrder
        ? {
            changeOrderId: changeOrder.id,
            partnerQuoteId: changeOrder.snapshot.partnerQuoteId,
            amountMinor: changeOrder.snapshot.amountMinor,
            currency: changeOrder.snapshot.currency,
          }
        : {}),
    },
    createdAt: now,
  });
  await tx.insert(partnerNotifications).values({
    partnerAccountId: current.partnerAccountId,
    membershipId: current.requestedByMembershipId,
    partnerBookingId: current.partnerBookingId,
    eventKey: publicCopy.eventType,
    title: publicCopy.title,
    body: publicCopy.body,
    actionPath: `/partners/bookings/${current.partnerBookingId}`,
    createdAt: now,
  });
  await tx.insert(outboxEvents).values({
    type: "partner.job_change_request.resolved",
    payload: {
      partnerAccountId: current.partnerAccountId,
      partnerBookingId: current.partnerBookingId,
      changeRequestId: current.requestId,
      state: input.decision,
      revision: resolved.revision,
      ...(changeOrder
        ? {
            changeOrderId: changeOrder.id,
            partnerQuoteId: changeOrder.snapshot.partnerQuoteId,
          }
        : {}),
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
    bookingRevision: updatedJob.version,
    publicStatus: updatedJob.publicStatus,
    appliedFields,
    changeOrder: changeOrder
      ? Object.freeze({
          id: changeOrder.id,
          partnerQuoteId: changeOrder.snapshot.partnerQuoteId,
          amountMinor: changeOrder.snapshot.amountMinor,
          currency: changeOrder.snapshot.currency,
        })
      : null,
    before: {
      requestState: current.requestState,
      requestRevision: current.requestRevision,
      bookingRevision: current.bookingRevision,
    },
    after: {
      requestState: input.decision,
      requestRevision: resolved.revision,
      bookingRevision: updatedJob.version,
      appliedFields,
      changeOrderId: changeOrder?.id ?? null,
      partnerQuoteId: changeOrder?.snapshot.partnerQuoteId ?? null,
    },
  });
}

export type PartnerJobReferenceUpdateResult = Readonly<{
  jobId: string;
  revision: number;
  updatedAt: Date;
  references: Readonly<{
    poNumber: string | null;
    costCenter: string | null;
    projectReference: string | null;
  }>;
}>;

/** Directly updates only bounded commercial-reference fields. */
export async function updatePartnerJobReferences(
  tx: TeamMutationTransaction,
  input: {
    principal: PartnerPrincipal;
    jobId: string;
    payload: PartnerJobReferencesBody;
    operationKeyHash: string;
    ifMatch: string | null;
    correlationId: string;
    now?: Date;
  },
): Promise<PartnerJobReferenceUpdateResult> {
  const accountId = input.principal.accountId;
  const membershipId = input.principal.membershipId;
  if (!accountId || !membershipId) {
    throw new PartnerJobChangeRequestError(
      "not_found",
      404,
      "The job was not found.",
    );
  }
  await acquireScheduleConflictLock(tx);
  await acquirePartnerJobMutationLock(tx, accountId, input.jobId);
  const [job] = await tx
    .select({
      id: partnerBookings.id,
      publicStatus: partnerBookings.publicStatus,
      version: partnerBookings.version,
      updatedAt: partnerBookings.updatedAt,
      poNumber: partnerBookings.poNumber,
      costCenter: partnerBookings.costCenter,
      projectReference: partnerBookings.projectReference,
      appointmentStatus: appointments.status,
    })
    .from(partnerBookings)
    .innerJoin(appointments, eq(partnerBookings.appointmentId, appointments.id))
    .innerJoin(
      partnerAccountMemberships,
      and(
        eq(partnerAccountMemberships.id, membershipId),
        eq(partnerAccountMemberships.partnerAccountId, accountId),
        eq(partnerAccountMemberships.status, "active"),
      ),
    )
    .leftJoin(partnerAccountLocations, createPartnerJobLocationJoinCondition())
    .where(createPartnerJobAccessCondition(input.principal, input.jobId))
    .for("update", { of: partnerBookings })
    .limit(1);
  if (!job) {
    throw new PartnerJobChangeRequestError(
      "not_found",
      404,
      "The job was not found.",
    );
  }
  assertCurrentPartnerRevision({
    ifMatch: input.ifMatch,
    jobId: job.id,
    version: job.version,
    updatedAt: job.updatedAt,
    correlationId: input.correlationId,
  });
  if (isJobTerminal(job.publicStatus, job.appointmentStatus)) {
    throw new PartnerJobChangeRequestError(
      "conflict",
      409,
      "Closed jobs cannot accept commercial-reference changes.",
    );
  }

  const now = input.now ?? new Date();
  const nextReferences = {
    poNumber:
      input.payload.poNumber === undefined
        ? job.poNumber
        : input.payload.poNumber,
    costCenter:
      input.payload.costCenter === undefined
        ? job.costCenter
        : input.payload.costCenter,
    projectReference:
      input.payload.projectReference === undefined
        ? job.projectReference
        : input.payload.projectReference,
  };
  const [updated] = await tx
    .update(partnerBookings)
    .set({
      ...nextReferences,
      version: job.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerBookings.partnerAccountId, accountId),
        eq(partnerBookings.id, job.id),
        eq(partnerBookings.version, job.version),
      ),
    )
    .returning({
      revision: partnerBookings.version,
      updatedAt: partnerBookings.updatedAt,
      poNumber: partnerBookings.poNumber,
      costCenter: partnerBookings.costCenter,
      projectReference: partnerBookings.projectReference,
    });
  if (!updated) {
    throw new PartnerJobChangeRequestError(
      "conflict",
      409,
      "The job changed while its references were being saved.",
    );
  }

  const [event] = await tx
    .insert(partnerJobEvents)
    .values({
      partnerAccountId: accountId,
      partnerBookingId: job.id,
      eventType: "job.references_updated",
      publicLabel: "Commercial references updated",
      publicDetail: "The PO, cost center, or project reference was updated.",
      effectiveAt: now,
      actorType: "partner",
      actorMembershipId: membershipId,
      createdAt: now,
    })
    .returning({ id: partnerJobEvents.id });
  if (!event) throw new Error("partner_job_reference_event_failed");
  const auditId = randomUUID();
  const changedFields = (
    Object.keys(input.payload) as Array<keyof PartnerJobReferencesBody>
  ).sort();
  await tx.insert(auditLogs).values({
    id: auditId,
    actorType: "human",
    actorId: input.principal.partnerUserId,
    actorLabel: input.principal.email,
    actorRole: input.principal.roleKey,
    sessionId: input.principal.session.id,
    authMethod: "partner_session",
    correlationId: input.correlationId,
    requiredPermissions: ["commercial.edit"],
    outcome: "succeeded",
    surface: "/partners/jobs",
    idempotencyKeyHash: input.operationKeyHash,
    action: "partner.job.references_updated",
    entityType: "partner_booking",
    entityId: job.id,
    meta: sanitizeAuditMetadata({
      eventId: auditId,
      correlationId: input.correlationId,
      partnerAccountId: accountId,
      partnerMembershipId: membershipId,
      partnerBookingId: job.id,
      changedFields,
      before: { revision: job.version },
      after: { revision: updated.revision },
    }),
    createdAt: now,
  });
  await tx.insert(outboxEvents).values({
    type: "partner.job_references.updated",
    payload: {
      partnerAccountId: accountId,
      partnerBookingId: job.id,
      partnerJobEventId: event.id,
      revision: updated.revision,
      changedFields,
      sourceAuditEventId: auditId,
      correlationId: input.correlationId,
    },
    createdAt: now,
  });

  return Object.freeze({
    jobId: job.id,
    revision: updated.revision,
    updatedAt: updated.updatedAt,
    references: Object.freeze({
      poNumber: updated.poNumber,
      costCenter: updated.costCenter,
      projectReference: updated.projectReference,
    }),
  });
}

export function partnerJobChangeRequestEtag(input: {
  jobId: string;
  revision: number;
  updatedAt: Date;
}): string {
  return createPortalV2StrongEtag(
    `${input.jobId}:${input.revision}:${input.updatedAt.toISOString()}`,
  );
}
