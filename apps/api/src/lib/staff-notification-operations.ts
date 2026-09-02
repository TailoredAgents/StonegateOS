import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  outboxEvents,
  staffNotificationOperations,
  teamMembers,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import type { SendResult } from "@/lib/messaging";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const PARTNER_OPERATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const E164_PATTERN = /^\+[1-9][0-9]{9,14}$/u;

export const STAFF_NOTIFICATION_UNCERTAINTY_WINDOW_MS = 15 * 60_000;
export const STAFF_NOTIFICATION_MAX_ATTEMPTS = 3;

export type PartnerBookingAuditActor = {
  partnerUserId: string;
  sessionId: string;
  label: string;
};

export type PartnerBookingStaffAlertKind =
  | "partner_booking_created"
  | "partner_booking_canceled"
  | "partner_billing_dispute_requested";

export function normalizePartnerOperationKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return PARTNER_OPERATION_KEY_PATTERN.test(normalized) ? normalized : null;
}

export function hashPartnerOperationKey(
  partnerUserId: string,
  operationKey: string,
): string {
  return createHash("sha256")
    .update(`${partnerUserId}:${operationKey}`)
    .digest("hex");
}

export function hashPartnerBookingRequest(input: {
  propertyId: string;
  preferredDate: string;
  timeWindowId: string;
  serviceKey: string;
  tierKey: string | null;
  notes: string | null;
  rescheduleFromAppointmentId?: string | null;
  rescheduleFromVersion?: number | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.propertyId,
        input.preferredDate,
        input.timeWindowId,
        input.serviceKey,
        input.tierKey,
        input.notes,
        input.rescheduleFromAppointmentId ?? null,
        input.rescheduleFromVersion ?? null,
      ]),
    )
    .digest("hex");
}

export async function resolvePartnerBookingStaffRecipient(
  tx: TeamMutationTransaction,
): Promise<{
  teamMemberId: string;
  label: string;
  phoneE164: string;
} | null> {
  const config = await getSalesScorecardConfig(tx);
  const teamMemberId = config.defaultAssigneeMemberId?.trim() ?? "";
  if (!teamMemberId) return null;

  const [member] = await tx
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      phoneE164: teamMembers.phoneE164,
    })
    .from(teamMembers)
    .where(and(eq(teamMembers.id, teamMemberId), eq(teamMembers.active, true)))
    .limit(1);

  const phoneE164 = member?.phoneE164?.trim() ?? "";
  if (!member?.id || !E164_PATTERN.test(phoneE164)) return null;
  return {
    teamMemberId: member.id,
    label: member.name,
    phoneE164,
  };
}

function auditActorValues(actor: PartnerBookingAuditActor) {
  return {
    actorType: "human" as const,
    actorId: actor.partnerUserId,
    actorRole: "partner",
    actorLabel: actor.label,
    sessionId: actor.sessionId,
    authMethod: "partner_session",
  };
}

export async function queuePartnerBookingStaffAlert(
  tx: TeamMutationTransaction,
  input: {
    appointmentId: string;
    contactId: string | null;
    recipient: {
      teamMemberId: string;
      phoneE164: string;
    };
    kind: PartnerBookingStaffAlertKind;
    body: string;
    actor: PartnerBookingAuditActor;
    correlationId: string;
    now?: Date;
  },
): Promise<{
  operationId: string;
  outboxEventId: string | null;
  replay: boolean;
}> {
  const now = input.now ?? new Date();
  const operationId = randomUUID();
  const providerRequestKey = `staff-alert:${input.kind}:${input.appointmentId}:${input.recipient.teamMemberId}`;
  const [created] = await tx
    .insert(staffNotificationOperations)
    .values({
      id: operationId,
      appointmentId: input.appointmentId,
      contactId: input.contactId,
      recipientTeamMemberId: input.recipient.teamMemberId,
      kind: input.kind,
      channel: "sms",
      recipientAddress: input.recipient.phoneE164,
      body: input.body,
      state: "requested",
      providerRequestKey,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: staffNotificationOperations.id });

  if (!created?.id) {
    const [existing] = await tx
      .select({ id: staffNotificationOperations.id })
      .from(staffNotificationOperations)
      .where(
        and(
          eq(staffNotificationOperations.appointmentId, input.appointmentId),
          eq(staffNotificationOperations.kind, input.kind),
          eq(
            staffNotificationOperations.recipientAddress,
            input.recipient.phoneE164,
          ),
        ),
      )
      .limit(1);
    if (!existing?.id) {
      throw new Error("staff_notification_operation_conflict");
    }
    return { operationId: existing.id, outboxEventId: null, replay: true };
  }

  const [event] = await tx
    .insert(outboxEvents)
    .values({
      type: "staff_notification.dispatch",
      payload: {
        operationId: created.id,
        appointmentId: input.appointmentId,
        contactId: input.contactId,
      },
      createdAt: now,
    })
    .returning({ id: outboxEvents.id });
  if (!event?.id) throw new Error("staff_notification_outbox_create_failed");

  await tx.insert(auditLogs).values({
    ...auditActorValues(input.actor),
    correlationId: input.correlationId,
    outcome: "succeeded",
    surface:
      input.kind === "partner_billing_dispute_requested"
        ? "/partners/billing"
        : "/partners/bookings",
    action:
      input.kind === "partner_billing_dispute_requested"
        ? "partner.billing_dispute.staff_alert.requested"
        : "partner.booking.staff_alert.requested",
    entityType:
      input.kind === "partner_billing_dispute_requested"
        ? "partner_billing_dispute_request"
        : "appointment",
    entityId: input.appointmentId,
    meta: sanitizeAuditMetadata({
      operationId: created.id,
      outboxEventId: event.id,
      kind: input.kind,
      recipientTeamMemberId: input.recipient.teamMemberId,
      state: "requested",
    }),
    createdAt: now,
  });

  return { operationId: created.id, outboxEventId: event.id, replay: false };
}

type StaffNotificationRow = typeof staffNotificationOperations.$inferSelect;

export type PrepareStaffNotificationResult =
  | {
      kind: "dispatch";
      operation: Pick<
        StaffNotificationRow,
        | "id"
        | "appointmentId"
        | "contactId"
        | "recipientTeamMemberId"
        | "kind"
        | "channel"
        | "recipientAddress"
        | "body"
        | "providerRequestKey"
        | "attemptCount"
      >;
    }
  | { kind: "in_flight"; retryAt: Date }
  | {
      kind: "terminal";
      state: "succeeded" | "failed" | "reconciliation_required";
    }
  | { kind: "unavailable" };

export async function prepareStaffNotificationDispatch(
  tx: TeamMutationTransaction,
  input: { operationId: string; outboxEventId: string; now?: Date },
): Promise<PrepareStaffNotificationResult> {
  const now = input.now ?? new Date();
  const [operation] = await tx
    .select()
    .from(staffNotificationOperations)
    .where(eq(staffNotificationOperations.id, input.operationId))
    .for("update")
    .limit(1);
  if (!operation) return { kind: "unavailable" };

  if (
    operation.state === "succeeded" ||
    operation.state === "failed" ||
    operation.state === "reconciliation_required"
  ) {
    return { kind: "terminal", state: operation.state };
  }

  if (operation.state === "dispatched") {
    if (operation.uncertaintyAt && operation.uncertaintyAt > now) {
      return { kind: "in_flight", retryAt: operation.uncertaintyAt };
    }
    await tx
      .update(staffNotificationOperations)
      .set({
        state: "reconciliation_required",
        retryable: false,
        failureCode: "provider_effect_uncertain",
        deliveryCertainty: "uncertain",
        failedAt: now,
        updatedAt: now,
      })
      .where(eq(staffNotificationOperations.id, operation.id));
    await insertWorkerAudit(tx, {
      operation,
      outboxEventId: input.outboxEventId,
      action: "staff_notification.reconciliation_required",
      outcome: "failed",
      state: "reconciliation_required",
      now,
    });
    return { kind: "terminal", state: "reconciliation_required" };
  }

  const [currentRecipient] = operation.recipientTeamMemberId
    ? await tx
        .select({
          id: teamMembers.id,
          active: teamMembers.active,
          phoneE164: teamMembers.phoneE164,
        })
        .from(teamMembers)
        .where(eq(teamMembers.id, operation.recipientTeamMemberId))
        .for("update")
        .limit(1)
    : [];
  const currentRecipientPhone = currentRecipient?.phoneE164?.trim() ?? "";
  const recipientFailureCode =
    !currentRecipient || !currentRecipient.active
      ? "recipient_unavailable"
      : !E164_PATTERN.test(currentRecipientPhone) ||
          currentRecipientPhone !== operation.recipientAddress
        ? "recipient_address_changed"
        : null;
  if (recipientFailureCode) {
    const [failed] = await tx
      .update(staffNotificationOperations)
      .set({
        state: "failed",
        retryable: false,
        deliveryCertainty: "not_sent",
        failureCode: recipientFailureCode,
        failedAt: now,
        updatedAt: now,
      })
      .where(eq(staffNotificationOperations.id, operation.id))
      .returning();
    if (!failed) return { kind: "unavailable" };
    await insertWorkerAudit(tx, {
      operation: failed,
      outboxEventId: input.outboxEventId,
      action: "staff_notification.dispatch.suppressed",
      outcome: "failed",
      state: "failed",
      failureCode: recipientFailureCode,
      now,
    });
    return { kind: "terminal", state: "failed" };
  }

  const uncertaintyAt = new Date(
    now.getTime() + STAFF_NOTIFICATION_UNCERTAINTY_WINDOW_MS,
  );
  const [claimed] = await tx
    .update(staffNotificationOperations)
    .set({
      state: "dispatched",
      retryable: false,
      attemptCount: operation.attemptCount + 1,
      dispatchedAt: now,
      uncertaintyAt,
      provider: null,
      providerOperationId: null,
      deliveryCertainty: null,
      failureCode: null,
      failedAt: null,
      updatedAt: now,
    })
    .where(eq(staffNotificationOperations.id, operation.id))
    .returning();
  if (!claimed) return { kind: "unavailable" };

  await insertWorkerAudit(tx, {
    operation: claimed,
    outboxEventId: input.outboxEventId,
    action: "staff_notification.dispatch.attempted",
    outcome: "attempted",
    state: "dispatched",
    now,
  });
  return { kind: "dispatch", operation: claimed };
}

function isRetryableNotSentFailure(result: SendResult): boolean {
  if (result.deliveryCertainty !== "not_sent") return false;
  const detail = result.detail ?? "";
  return !(
    detail.includes("not_configured") ||
    detail.includes("invalid_configuration") ||
    detail.includes("invalid_input") ||
    detail.includes("external_sends_disabled")
  );
}

async function insertWorkerAudit(
  tx: TeamMutationTransaction,
  input: {
    operation: Pick<
      StaffNotificationRow,
      | "id"
      | "appointmentId"
      | "contactId"
      | "recipientTeamMemberId"
      | "kind"
      | "attemptCount"
      | "providerRequestKey"
    >;
    outboxEventId: string;
    action: string;
    outcome: "attempted" | "succeeded" | "failed";
    state: string;
    now: Date;
    provider?: string | null;
    providerOperationId?: string | null;
    failureCode?: string | null;
  },
): Promise<void> {
  const billingDispute =
    input.operation.kind === "partner_billing_dispute_requested";
  await tx.insert(auditLogs).values({
    actorType: "worker",
    actorId: null,
    actorRole: "outbox-dispatcher",
    actorLabel: "outbox-dispatcher",
    authMethod: "service",
    outcome: input.outcome,
    surface: billingDispute ? "/partners/billing" : "/partners/bookings",
    providerOperationId: input.providerOperationId ?? null,
    idempotencyKeyHash: createHash("sha256")
      .update(input.operation.providerRequestKey)
      .digest("hex"),
    action: input.action,
    entityType: billingDispute
      ? "partner_billing_dispute_request"
      : "appointment",
    entityId: input.operation.appointmentId,
    meta: sanitizeAuditMetadata({
      operationId: input.operation.id,
      outboxEventId: input.outboxEventId,
      contactId: input.operation.contactId,
      recipientTeamMemberId: input.operation.recipientTeamMemberId,
      kind: input.operation.kind,
      attempt: input.operation.attemptCount,
      state: input.state,
      provider: input.provider ?? null,
      failureCode: input.failureCode ?? null,
    }),
    createdAt: input.now,
  });
}

export type FinalizeStaffNotificationResult =
  | {
      kind: "processed";
      state: "succeeded" | "failed" | "reconciliation_required";
    }
  | { kind: "retry"; retryAt: Date; error: string };

export async function finalizeStaffNotificationDispatch(
  tx: TeamMutationTransaction,
  input: {
    operationId: string;
    outboxEventId: string;
    result: SendResult;
    now?: Date;
  },
): Promise<FinalizeStaffNotificationResult> {
  const now = input.now ?? new Date();
  const [operation] = await tx
    .select()
    .from(staffNotificationOperations)
    .where(eq(staffNotificationOperations.id, input.operationId))
    .for("update")
    .limit(1);
  if (!operation || operation.state !== "dispatched") {
    throw new Error("staff_notification_dispatch_not_claimed");
  }

  const providerOperationId =
    input.result.providerMessageId ??
    input.result.providerOperationIds?.[0] ??
    null;
  if (input.result.ok && input.result.deliveryCertainty === "accepted") {
    await tx
      .update(staffNotificationOperations)
      .set({
        state: "succeeded",
        provider: input.result.provider ?? null,
        providerOperationId,
        deliveryCertainty: "accepted",
        retryable: false,
        failureCode: null,
        succeededAt: now,
        failedAt: null,
        updatedAt: now,
      })
      .where(eq(staffNotificationOperations.id, operation.id));
    await insertWorkerAudit(tx, {
      operation,
      outboxEventId: input.outboxEventId,
      action: "staff_notification.dispatch.succeeded",
      outcome: "succeeded",
      state: "succeeded",
      provider: input.result.provider ?? null,
      providerOperationId,
      now,
    });
    return { kind: "processed", state: "succeeded" };
  }

  const failureCode =
    input.result.detail ??
    (input.result.deliveryCertainty
      ? "staff_notification_failed"
      : "provider_delivery_certainty_missing");
  if (input.result.deliveryCertainty !== "not_sent") {
    await tx
      .update(staffNotificationOperations)
      .set({
        state: "reconciliation_required",
        provider: input.result.provider ?? null,
        providerOperationId,
        deliveryCertainty: "uncertain",
        retryable: false,
        failureCode,
        failedAt: now,
        updatedAt: now,
      })
      .where(eq(staffNotificationOperations.id, operation.id));
    await insertWorkerAudit(tx, {
      operation,
      outboxEventId: input.outboxEventId,
      action: "staff_notification.reconciliation_required",
      outcome: "failed",
      state: "reconciliation_required",
      provider: input.result.provider ?? null,
      providerOperationId,
      failureCode,
      now,
    });
    return { kind: "processed", state: "reconciliation_required" };
  }

  const retryable =
    isRetryableNotSentFailure(input.result) &&
    operation.attemptCount < STAFF_NOTIFICATION_MAX_ATTEMPTS;
  if (retryable) {
    const retryAt = new Date(now.getTime() + 60_000 * operation.attemptCount);
    await tx
      .update(staffNotificationOperations)
      .set({
        state: "requested",
        provider: input.result.provider ?? null,
        providerOperationId,
        deliveryCertainty: "not_sent",
        retryable: true,
        failureCode,
        uncertaintyAt: null,
        succeededAt: null,
        failedAt: null,
        updatedAt: now,
      })
      .where(eq(staffNotificationOperations.id, operation.id));
    await insertWorkerAudit(tx, {
      operation,
      outboxEventId: input.outboxEventId,
      action: "staff_notification.dispatch.failed",
      outcome: "failed",
      state: "requested",
      provider: input.result.provider ?? null,
      providerOperationId,
      failureCode,
      now,
    });
    return { kind: "retry", retryAt, error: failureCode };
  }

  await tx
    .update(staffNotificationOperations)
    .set({
      state: "failed",
      provider: input.result.provider ?? null,
      providerOperationId,
      deliveryCertainty: input.result.deliveryCertainty ?? "not_sent",
      retryable: false,
      failureCode,
      failedAt: now,
      updatedAt: now,
    })
    .where(eq(staffNotificationOperations.id, operation.id));
  await insertWorkerAudit(tx, {
    operation,
    outboxEventId: input.outboxEventId,
    action: "staff_notification.dispatch.failed",
    outcome: "failed",
    state: "failed",
    provider: input.result.provider ?? null,
    providerOperationId,
    failureCode,
    now,
  });
  return { kind: "processed", state: "failed" };
}
