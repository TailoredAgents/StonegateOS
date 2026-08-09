import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLogs, partnerInviteOperations, type DatabaseClient } from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  classifyPartnerInviteProviderResult,
  summarizePartnerInviteDeliveries,
  type PartnerInviteChannel,
  type PartnerInviteDeliverySummary,
  type PartnerInviteDeliveryState,
  type PartnerInviteProviderEvidence,
} from "@/lib/partner-invite-delivery";
import type { SendResult } from "@/lib/messaging";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export type PartnerAccessLinkOperationKind =
  | "team_invite"
  | "public_login_link";

export type PartnerInviteSemanticTarget = {
  operationKind?: PartnerAccessLinkOperationKind;
  orgContactId: string;
  partnerUserId: string;
  email: string;
  phoneE164: string | null;
  requestedChannels: readonly PartnerInviteChannel[];
};

export type PartnerInviteAuditContext = {
  actorType: "human" | "ai" | "system" | "worker";
  actorId: string | null;
  actorRole: string | null;
  actorLabel: string | null;
  sessionId: string | null;
  authMethod: "team_session" | "break_glass" | "service" | null;
  correlationId: string;
  requiredPermissions: string[] | null;
  surface: string;
  idempotencyKeyHash: string | null;
  operationId: string;
  risk: "read" | "normal" | "external" | "financial" | "destructive";
};

export type PartnerInviteAuditInput = {
  action: string;
  outcome: "attempted" | "succeeded" | "failed";
  userId?: string | null;
  providerOperationId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
};

export type PartnerInviteOperationAuditRecord = ReturnType<
  typeof buildPartnerInviteOperationAuditRecord
>;

export function buildPartnerInviteOperationAuditRecord(
  context: PartnerInviteAuditContext,
  input: PartnerInviteAuditInput,
) {
  const id = randomUUID();
  const createdAt = input.createdAt ?? new Date();
  return {
    id,
    actorType: context.actorType,
    actorId: context.actorId,
    actorRole: context.actorRole,
    actorLabel: context.actorLabel,
    sessionId: context.sessionId,
    authMethod: context.authMethod,
    correlationId: context.correlationId,
    requiredPermissions: context.requiredPermissions,
    outcome: input.outcome,
    surface: context.surface,
    providerOperationId: input.providerOperationId ?? null,
    idempotencyKeyHash: context.idempotencyKeyHash,
    action: input.action,
    entityType: "partner_user",
    entityId: input.userId ?? null,
    meta: sanitizeAuditMetadata({
      eventId: id,
      correlationId: context.correlationId,
      operationId: context.operationId,
      sessionId: context.sessionId,
      authMethod: context.authMethod,
      requiredPermissions: context.requiredPermissions,
      risk: context.risk,
      outcome: input.outcome,
      idempotencyKeyHash: context.idempotencyKeyHash,
      providerOperationId: input.providerOperationId ?? null,
      ...(input.metadata ?? {}),
    }),
    createdAt,
  };
}

export function partnerInviteProviderEvidenceMetadata(
  evidence: readonly PartnerInviteProviderEvidence[],
) {
  return evidence.map((item) => ({
    channel: item.channel,
    state: item.state,
    provider: item.provider,
    providerOperationIds: item.providerOperationIds,
    providerIdempotencySupported: item.providerIdempotencySupported,
    providerExactlyOnceClaimed: false,
    detail: item.detail,
  }));
}

/**
 * Preserve provider evidence that returns after a recovery worker or another
 * request has already made the durable operation terminal. The original
 * ledger stays immutable; append-only audit rows retain the late facts.
 */
export async function recordPartnerInviteLateProviderEvidence(
  db: DatabaseClient,
  context: PartnerInviteAuditContext,
  input: {
    actionRoot: "partner_user.invite" | "partner_user.login_link";
    userId: string | null;
    orgContactId: string;
    evidence: readonly PartnerInviteProviderEvidence[];
    reason: string;
  },
): Promise<boolean> {
  if (input.evidence.length === 0) return true;
  try {
    await db.transaction(async (tx) => {
      const now = new Date();
      for (const item of input.evidence) {
        const audit = buildPartnerInviteOperationAuditRecord(context, {
          action: `${input.actionRoot}.late_provider_outcome`,
          outcome: item.state === "succeeded" ? "succeeded" : "failed",
          userId: input.userId,
          providerOperationId: item.providerOperationId,
          metadata: {
            orgContactId: input.orgContactId,
            channel: item.channel,
            state: item.state,
            provider: item.provider,
            providerOperationIds: item.providerOperationIds,
            providerIdempotencySupported: item.providerIdempotencySupported,
            providerExactlyOnceClaimed: false,
            detail: item.detail,
            durableOperationAlreadySettled: true,
            terminalReceiptAlreadyPresent: true,
            originalProviderOutcomePreserved: true,
            reason: input.reason,
          },
          createdAt: now,
        });
        await tx.insert(auditLogs).values(audit);
      }
    });
    return true;
  } catch (error) {
    console.error("[partners] access_link_late_provider_audit_failed", {
      operationId: context.operationId,
      correlationId: context.correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return false;
  }
}

export async function capturePartnerInviteProviderResult(
  channel: PartnerInviteChannel,
  dispatch: () => Promise<SendResult>,
): Promise<PartnerInviteProviderEvidence> {
  try {
    return classifyPartnerInviteProviderResult(channel, await dispatch());
  } catch {
    return classifyPartnerInviteProviderResult(channel, {
      ok: false,
      provider: channel === "email" ? "smtp" : "twilio",
      providerIdempotencySupported: false,
      deliveryCertainty: "uncertain",
      detail: `${channel}_unexpected_dispatch_error`,
    });
  }
}

export async function transitionPartnerInviteOperationToDispatched(
  tx: TeamMutationTransaction,
  input: {
    operationId: string;
    dispatchAuditEventId: string;
    dispatchedAt: Date;
  },
): Promise<{ version: number; dispatchedAt: Date }> {
  const [operation] = await tx
    .select({
      id: partnerInviteOperations.id,
      state: partnerInviteOperations.state,
      version: partnerInviteOperations.version,
      requestedAt: partnerInviteOperations.requestedAt,
    })
    .from(partnerInviteOperations)
    .where(eq(partnerInviteOperations.id, input.operationId))
    .for("update")
    .limit(1);
  if (!operation || operation.state !== "requested") {
    throw new TeamMutationFailure(
      "conflict",
      "This partner access-link operation is no longer eligible for provider dispatch. Review its operation history before trying again.",
    );
  }

  const dispatchedAt = new Date(
    Math.max(input.dispatchedAt.getTime(), operation.requestedAt.getTime()),
  );
  const version = operation.version + 1;
  const [dispatched] = await tx
    .update(partnerInviteOperations)
    .set({
      state: "dispatched",
      version,
      dispatchAuditEventId: input.dispatchAuditEventId,
      dispatchedAt,
      updatedAt: dispatchedAt,
    })
    .where(
      and(
        eq(partnerInviteOperations.id, input.operationId),
        eq(partnerInviteOperations.state, "requested"),
        eq(partnerInviteOperations.version, operation.version),
      ),
    )
    .returning({ id: partnerInviteOperations.id });
  if (!dispatched?.id) {
    throw new TeamMutationFailure(
      "conflict",
      "This partner access-link operation changed before provider dispatch. Review its operation history before trying again.",
      { retryable: true },
    );
  }
  return { version, dispatchedAt };
}

export async function transitionPartnerInviteOperationToQuarantinedFailure(
  tx: TeamMutationTransaction,
  input: {
    operationId: string;
    terminalAuditEventId: string;
    completedAt: Date;
    failureCode: string;
    failureDetail: string;
    quarantineReason: string;
    quarantinedBy?: string | null;
  },
): Promise<{ version: number; completedAt: Date }> {
  const [operation] = await tx
    .select({
      id: partnerInviteOperations.id,
      state: partnerInviteOperations.state,
      version: partnerInviteOperations.version,
      requestedAt: partnerInviteOperations.requestedAt,
    })
    .from(partnerInviteOperations)
    .where(eq(partnerInviteOperations.id, input.operationId))
    .for("update")
    .limit(1);
  if (!operation || operation.state !== "requested") {
    throw new TeamMutationFailure(
      "conflict",
      "This partner access-link operation is no longer eligible for pre-dispatch quarantine.",
    );
  }

  const completedAt = new Date(
    Math.max(input.completedAt.getTime(), operation.requestedAt.getTime()),
  );
  const version = operation.version + 1;
  const [completed] = await tx
    .update(partnerInviteOperations)
    .set({
      state: "failed",
      version,
      terminalAuditEventId: input.terminalAuditEventId,
      failureCode: input.failureCode,
      failureDetail: input.failureDetail,
      retryable: false,
      quarantinedAt: completedAt,
      quarantinedBy: input.quarantinedBy ?? null,
      quarantineReason: input.quarantineReason,
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(partnerInviteOperations.id, input.operationId),
        eq(partnerInviteOperations.state, "requested"),
        eq(partnerInviteOperations.version, operation.version),
      ),
    )
    .returning({ id: partnerInviteOperations.id });
  if (!completed?.id) {
    throw new TeamMutationFailure(
      "conflict",
      "The partner access-link operation changed while it was being quarantined.",
      { retryable: true },
    );
  }
  return { version, completedAt };
}

export async function transitionPartnerInviteOperationToTerminal(
  tx: TeamMutationTransaction,
  input: {
    operationId: string;
    summary: PartnerInviteDeliverySummary;
    evidence: readonly PartnerInviteProviderEvidence[];
    terminalAuditEventId: string;
    completedAt: Date;
    failureDetail?: string | null;
  },
): Promise<{
  state: PartnerInviteDeliveryState;
  version: number;
  completedAt: Date;
}> {
  const [operation] = await tx
    .select({
      id: partnerInviteOperations.id,
      state: partnerInviteOperations.state,
      version: partnerInviteOperations.version,
      dispatchedAt: partnerInviteOperations.dispatchedAt,
    })
    .from(partnerInviteOperations)
    .where(eq(partnerInviteOperations.id, input.operationId))
    .for("update")
    .limit(1);
  if (
    !operation ||
    operation.state !== "dispatched" ||
    !operation.dispatchedAt
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The durable partner access-link dispatch is not awaiting a provider result. Review its operation history before trying again.",
    );
  }

  const completedAt = new Date(
    Math.max(input.completedAt.getTime(), operation.dispatchedAt.getTime()),
  );
  const state = input.summary.state;
  const reconciliationRequired = state === "reconciliation_required";
  const failed = state === "failed";
  const version = operation.version + 1;
  const [completed] = await tx
    .update(partnerInviteOperations)
    .set({
      state,
      version,
      providerOperationIds: input.summary.providerOperationIds,
      providerEvidence: partnerInviteProviderEvidenceMetadata(input.evidence),
      terminalAuditEventId: input.terminalAuditEventId,
      failureCode: reconciliationRequired
        ? "provider_delivery_uncertain"
        : failed
          ? "providers_confirmed_not_sent"
          : null,
      failureDetail:
        reconciliationRequired || failed
          ? (input.failureDetail ??
            (reconciliationRequired
              ? "One or more requested channels lack conclusive non-send evidence."
              : "Every requested provider channel confirmed that it did not send."))
          : null,
      retryable: failed,
      completedAt,
      reconciliationRequiredAt: reconciliationRequired ? completedAt : null,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(partnerInviteOperations.id, input.operationId),
        eq(partnerInviteOperations.state, "dispatched"),
        eq(partnerInviteOperations.version, operation.version),
      ),
    )
    .returning({ id: partnerInviteOperations.id });
  if (!completed?.id) {
    throw new TeamMutationFailure(
      "conflict",
      "The partner access-link operation changed while its provider result was being recorded.",
      { retryable: true },
    );
  }
  return { state, version, completedAt };
}

/**
 * Stable privacy-safe identity for the exact recipient and channel set. The
 * database additionally guards the unresolved partner user, which is stricter
 * and prevents changing a channel set from bypassing an ambiguous send.
 */
export function partnerInviteSemanticHash(
  target: PartnerInviteSemanticTarget,
): string {
  const channels = Array.from(new Set(target.requestedChannels)).sort();
  const canonical = JSON.stringify({
    version: 1,
    operationKind: target.operationKind ?? "team_invite",
    orgContactId: target.orgContactId.trim().toLowerCase(),
    partnerUserId: target.partnerUserId.trim().toLowerCase(),
    email: target.email.trim().toLowerCase(),
    phoneE164: target.phoneE164?.trim() || null,
    channels,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function partnerInviteProviderRequestKey(
  operationId: string,
  channel: PartnerInviteChannel,
): string {
  return `${operationId}.partner-access-link.${channel}`;
}

/**
 * Public callers do not supply a replay key. Each rate-limited request gets a
 * privacy-safe random operation identity; the unresolved-target database key,
 * not a user-controlled value, remains the cross-route duplicate-send guard.
 */
export function partnerInvitePublicRequestKeyHash(operationId: string): string {
  return createHash("sha256")
    .update(`public-partner-login-link:${operationId}`)
    .digest("hex");
}

/**
 * Missing, duplicate, or unexpected channel evidence is ambiguous—not a
 * confirmed provider non-send. This planner is shared by team invitations and
 * can be adopted by the public known-user request-link route without weakening
 * the retry boundary.
 */
export function planPartnerInviteTerminal(
  requestedChannels: readonly PartnerInviteChannel[],
  evidence: readonly PartnerInviteProviderEvidence[],
): PartnerInviteDeliverySummary {
  const requested = Array.from(new Set(requestedChannels)).sort();
  const observed = evidence.map((item) => item.channel).sort();
  const complete =
    requested.length === observed.length &&
    requested.every((channel, index) => channel === observed[index]);
  const summary = summarizePartnerInviteDeliveries(evidence);
  if (complete) return summary;

  return {
    ...summary,
    state: "reconciliation_required",
    uncertainChannels: Array.from(
      new Set([
        ...summary.uncertainChannels,
        ...requested.filter(
          (channel) => !evidence.some((item) => item.channel === channel),
        ),
      ]),
    ),
  };
}

export function isPartnerInviteUnresolvedState(
  state: string,
): state is "requested" | "dispatched" | "reconciliation_required" {
  return (
    state === "requested" ||
    state === "dispatched" ||
    state === "reconciliation_required"
  );
}
