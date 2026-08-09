import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerInviteOperations,
  partnerLoginTokens,
  type DatabaseClient,
} from "@/db";
import {
  buildPartnerInviteOperationAuditRecord,
  planPartnerInviteTerminal,
  transitionPartnerInviteOperationToQuarantinedFailure,
  transitionPartnerInviteOperationToTerminal,
  type PartnerInviteAuditContext,
} from "@/lib/partner-invite-operations";
import type { PartnerInviteChannel } from "@/lib/partner-invite-delivery";

const DEFAULT_REQUESTED_STALE_MS = 2 * 60 * 1000;
const DEFAULT_DISPATCHED_STALE_MS = 10 * 60 * 1000;
const MAX_STALE_MS = 24 * 60 * 60 * 1000;

export type PartnerInviteRecoveryStats = {
  scanned: number;
  requestedQuarantined: number;
  dispatchedReconciled: number;
  skipped: number;
  errors: number;
};

type PartnerInviteRecoveryOptions = {
  db?: DatabaseClient;
  limit?: number;
  now?: Date;
  requestedStaleMs?: number;
  dispatchedStaleMs?: number;
  onError?: (error: unknown, operationId: string) => void;
};

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) && value! >= minimum && value! <= maximum
    ? value!
    : fallback;
}

function auditContext(operation: {
  id: string;
  correlationId: string;
  idempotencyKeyHash: string;
}): PartnerInviteAuditContext {
  return {
    actorType: "worker",
    actorId: null,
    actorRole: "service",
    actorLabel: "partner-invite-recovery",
    sessionId: null,
    authMethod: "service",
    correlationId: operation.correlationId,
    requiredPermissions: ["partners.invite"],
    surface: "worker.partner_invite_recovery",
    idempotencyKeyHash: operation.idempotencyKeyHash,
    operationId: operation.id,
    risk: "external",
  };
}

function checkedRequestedChannels(
  value: readonly string[],
): PartnerInviteChannel[] {
  if (
    value.length < 1 ||
    value.length > 2 ||
    value.some((channel) => channel !== "email" && channel !== "sms") ||
    new Set(value).size !== value.length
  ) {
    throw new Error("partner_invite_operation_channels_invalid");
  }
  return [...value] as PartnerInviteChannel[];
}

/**
 * Settles only operations whose request process stopped making progress.
 *
 * A stale `requested` row proves provider dispatch never became eligible, so
 * it is quarantined and its unused token is invalidated. A stale `dispatched`
 * row crossed the provider boundary and is therefore moved to operator review
 * with every requested channel marked uncertain. This function never imports
 * or invokes a provider adapter and can never resend an access link.
 */
export async function recoverStalePartnerInviteOperations(
  options: PartnerInviteRecoveryOptions = {},
): Promise<PartnerInviteRecoveryStats> {
  const db = options.db ?? getDb();
  const limit = boundedPositiveInteger(options.limit, 50, 1, 100);
  const requestedStaleMs = boundedPositiveInteger(
    options.requestedStaleMs,
    DEFAULT_REQUESTED_STALE_MS,
    30_000,
    MAX_STALE_MS,
  );
  const dispatchedStaleMs = boundedPositiveInteger(
    options.dispatchedStaleMs,
    DEFAULT_DISPATCHED_STALE_MS,
    30_000,
    MAX_STALE_MS,
  );
  const now = options.now ?? new Date();
  const requestedCutoff = new Date(now.getTime() - requestedStaleMs);
  const dispatchedCutoff = new Date(now.getTime() - dispatchedStaleMs);
  const stats: PartnerInviteRecoveryStats = {
    scanned: 0,
    requestedQuarantined: 0,
    dispatchedReconciled: 0,
    skipped: 0,
    errors: 0,
  };

  const candidates = await db
    .select({
      id: partnerInviteOperations.id,
    })
    .from(partnerInviteOperations)
    .where(
      and(
        isNull(partnerInviteOperations.resolvedAt),
        or(
          and(
            eq(partnerInviteOperations.state, "requested"),
            lte(partnerInviteOperations.updatedAt, requestedCutoff),
          ),
          and(
            eq(partnerInviteOperations.state, "dispatched"),
            lte(partnerInviteOperations.updatedAt, dispatchedCutoff),
          ),
        ),
      ),
    )
    .orderBy(
      asc(partnerInviteOperations.updatedAt),
      asc(partnerInviteOperations.id),
    )
    .limit(limit);
  stats.scanned = candidates.length;

  for (const candidate of candidates) {
    try {
      const outcome = await db.transaction(async (tx) => {
        const [operation] = await tx
          .select({
            id: partnerInviteOperations.id,
            orgContactId: partnerInviteOperations.orgContactId,
            partnerUserId: partnerInviteOperations.partnerUserId,
            operationKind: partnerInviteOperations.operationKind,
            correlationId: partnerInviteOperations.correlationId,
            idempotencyKeyHash: partnerInviteOperations.idempotencyKeyHash,
            requestedChannels: partnerInviteOperations.requestedChannels,
            state: partnerInviteOperations.state,
            updatedAt: partnerInviteOperations.updatedAt,
            resolvedAt: partnerInviteOperations.resolvedAt,
          })
          .from(partnerInviteOperations)
          .where(eq(partnerInviteOperations.id, candidate.id))
          .for("update")
          .limit(1);
        if (!operation || operation.resolvedAt) return "skipped" as const;
        const isStaleRequested =
          operation.state === "requested" &&
          operation.updatedAt.getTime() <= requestedCutoff.getTime();
        const isStaleDispatched =
          operation.state === "dispatched" &&
          operation.updatedAt.getTime() <= dispatchedCutoff.getTime();
        if (!isStaleRequested && !isStaleDispatched) {
          return "skipped" as const;
        }

        const context = auditContext(operation);
        const requestedChannels = checkedRequestedChannels(
          operation.requestedChannels,
        );
        const actionRoot =
          operation.operationKind === "public_login_link"
            ? "partner_user.login_link"
            : "partner_user.invite";
        if (isStaleRequested) {
          const audit = buildPartnerInviteOperationAuditRecord(context, {
            action: `${actionRoot}.recovery_quarantined`,
            outcome: "failed",
            userId: operation.partnerUserId,
            metadata: {
              orgContactId: operation.orgContactId,
              operationKind: operation.operationKind,
              priorState: "requested",
              providerBoundaryCrossed: false,
              providerCalled: false,
              redispatchPrevented: false,
              reason: "requested_operation_lease_expired",
            },
            createdAt: now,
          });
          await tx.insert(auditLogs).values(audit);
          await tx
            .update(partnerLoginTokens)
            .set({ usedAt: now })
            .where(
              and(
                eq(partnerLoginTokens.partnerUserId, operation.partnerUserId),
                isNull(partnerLoginTokens.usedAt),
              ),
            );
          await transitionPartnerInviteOperationToQuarantinedFailure(tx, {
            operationId: operation.id,
            terminalAuditEventId: audit.id,
            completedAt: now,
            failureCode: "requested_operation_lease_expired",
            failureDetail:
              "The request process stopped before durable provider dispatch.",
            quarantineReason: "recovery_before_provider_dispatch",
          });
          return "requested_quarantined" as const;
        }

        const summary = planPartnerInviteTerminal(requestedChannels, []);
        const audit = buildPartnerInviteOperationAuditRecord(context, {
          action: `${actionRoot}.recovery_reconciliation_required`,
          outcome: "failed",
          userId: operation.partnerUserId,
          metadata: {
            orgContactId: operation.orgContactId,
            operationKind: operation.operationKind,
            priorState: "dispatched",
            requestedChannels,
            uncertainChannels: summary.uncertainChannels,
            providerBoundaryCrossed: true,
            automaticProviderRetryAttempted: false,
            redispatchPrevented: true,
            reason: "dispatched_operation_lease_expired",
          },
          createdAt: now,
        });
        await tx.insert(auditLogs).values(audit);
        await transitionPartnerInviteOperationToTerminal(tx, {
          operationId: operation.id,
          summary,
          evidence: [],
          terminalAuditEventId: audit.id,
          completedAt: now,
          failureDetail:
            "The request process stopped after provider dispatch began; provider outcome requires operator review.",
        });
        return "dispatched_reconciled" as const;
      });

      if (outcome === "requested_quarantined") {
        stats.requestedQuarantined += 1;
      } else if (outcome === "dispatched_reconciled") {
        stats.dispatchedReconciled += 1;
      } else {
        stats.skipped += 1;
      }
    } catch (error) {
      stats.errors += 1;
      if (options.onError) {
        options.onError(error, candidate.id);
      } else {
        console.error("[partners] invite_recovery_failed", {
          operationId: candidate.id,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  }

  return stats;
}
