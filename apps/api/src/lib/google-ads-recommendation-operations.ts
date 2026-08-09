import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  auditLogs,
  googleAdsAnalystRecommendationEvents,
  googleAdsAnalystRecommendations,
  googleAdsRecommendationOperations,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  GoogleAdsMutationDispatchError,
  normalizeGoogleAdsNegativeKeywordTerm,
} from "@/lib/google-ads-insights";
import type { TeamMutationIdempotencyClaim } from "@/lib/team-mutation-idempotency";
import {
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export const GOOGLE_ADS_RECOMMENDATION_STATUSES = [
  "proposed",
  "approved",
  "ignored",
  "applying",
  "applied",
  "failed",
  "reconciliation_required",
] as const;

export type GoogleAdsRecommendationStatus =
  (typeof GOOGLE_ADS_RECOMMENDATION_STATUSES)[number];

export type GoogleAdsReviewStatus = "proposed" | "approved" | "ignored";

export type GoogleAdsApplyRequestItem = {
  id: string;
  expectedVersion: string;
};

type OperationRow = typeof googleAdsRecommendationOperations.$inferSelect;

export type PreparedGoogleAdsOperation = {
  recommendationId: string;
  reportId: string;
  kind: string;
  recommendationVersion: string;
  operation: OperationRow;
};

export type GoogleAdsOperationPublicState = {
  id: string;
  state: OperationRow["state"];
  version: number;
  provider: string;
  providerOperationId: string | null;
  providerIdempotencySupported: boolean;
  term: string;
  matchType: string;
  requestedAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  reconciliationRequiredAt: string | null;
  providerStatus: number | null;
  failureCode: string | null;
  failureDetail: string | null;
};

export type GoogleAdsProviderTerminalOutcome =
  | {
      state: "succeeded";
      providerOperationId: string;
      providerStatus: number;
      failureCode: null;
      failureDetail: null;
    }
  | {
      state: "failed" | "reconciliation_required";
      providerOperationId: string | null;
      providerStatus: number | null;
      failureCode: string;
      failureDetail: string;
    };

export type FinalizedGoogleAdsOperation = {
  recommendationId: string;
  recommendationStatus: "applied" | "failed" | "reconciliation_required";
  recommendationVersion: string;
  operation: GoogleAdsOperationPublicState;
  auditEventId: string;
  committedAt: string;
};

export function finalizedGoogleAdsOperationFromPrepared(
  prepared: PreparedGoogleAdsOperation,
): FinalizedGoogleAdsOperation {
  const operation = prepared.operation;
  if (
    operation.state !== "succeeded" &&
    operation.state !== "failed" &&
    operation.state !== "reconciliation_required"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The Google Ads operation is not terminal.",
    );
  }
  if (!operation.terminalAuditEventId || !operation.completedAt) {
    throw new TeamMutationFailure(
      "internal",
      "The terminal Google Ads operation receipt is incomplete. Reconcile it before retrying.",
    );
  }
  return {
    recommendationId: prepared.recommendationId,
    recommendationStatus:
      operation.state === "succeeded" ? "applied" : operation.state,
    recommendationVersion: prepared.recommendationVersion,
    operation: publicGoogleAdsOperation(operation),
    auditEventId: operation.terminalAuditEventId,
    committedAt: operation.completedAt.toISOString(),
  };
}

const REVIEWABLE_STATUSES = new Set<GoogleAdsRecommendationStatus>([
  "proposed",
  "approved",
  "ignored",
  "failed",
]);

function safeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nextTimestamp(previous: Date, candidate = new Date()): Date {
  return new Date(Math.max(candidate.getTime(), previous.getTime() + 1));
}

function requireActorId(mutation: TeamMutationContext): string {
  const actorId = mutation.actor.id;
  if (!actorId || mutation.principalType !== "human") {
    throw new TeamMutationFailure(
      "internal",
      "The verified Google Ads actor is incomplete.",
    );
  }
  return actorId;
}

function requireIdempotencyHash(mutation: TeamMutationContext): string {
  if (!mutation.idempotencyKeyHash) {
    throw new TeamMutationFailure(
      "invalid",
      "A valid Idempotency-Key is required for this Google Ads action.",
    );
  }
  return mutation.idempotencyKeyHash;
}

function recommendationTerm(payload: Record<string, unknown>): string {
  const raw = safeString(payload["term"] ?? payload["keyword"]);
  if (!raw) {
    throw new TeamMutationFailure(
      "invalid",
      "This recommendation does not contain a negative keyword.",
      { fieldErrors: { term: "Generate a new recommendation." } },
    );
  }
  const normalized = normalizeGoogleAdsNegativeKeywordTerm(raw);
  if (!normalized.term || normalized.term.length > 80) {
    throw new TeamMutationFailure(
      "invalid",
      "The proposed negative keyword is outside Google Ads limits.",
      { fieldErrors: { term: "Use a keyword between 1 and 80 characters." } },
    );
  }
  return raw;
}

export function isGoogleAdsReviewStatus(
  value: string,
): value is GoogleAdsReviewStatus {
  return value === "proposed" || value === "approved" || value === "ignored";
}

export function assertGoogleAdsReviewTransition(
  fromStatus: string,
  toStatus: GoogleAdsReviewStatus,
): void {
  if (
    !GOOGLE_ADS_RECOMMENDATION_STATUSES.includes(
      fromStatus as GoogleAdsRecommendationStatus,
    ) ||
    !REVIEWABLE_STATUSES.has(fromStatus as GoogleAdsRecommendationStatus)
  ) {
    const guidance =
      fromStatus === "reconciliation_required"
        ? "Reconcile the provider result before changing this recommendation."
        : fromStatus === "applied"
          ? "Applied recommendations are immutable."
          : "Wait for the current apply operation to finish.";
    throw new TeamMutationFailure("conflict", guidance);
  }
  if (fromStatus === toStatus) {
    throw new TeamMutationFailure(
      "conflict",
      `This recommendation is already ${toStatus}. Refresh the page.`,
    );
  }
}

export function classifyGoogleAdsProviderMutationFailure(
  error: unknown,
): GoogleAdsProviderTerminalOutcome {
  if (error instanceof GoogleAdsMutationDispatchError) {
    const uncertain = error.certainty === "uncertain";
    return {
      state: uncertain ? "reconciliation_required" : "failed",
      providerOperationId: null,
      providerStatus: error.providerStatus,
      failureCode: error.failureCode,
      failureDetail: uncertain
        ? "Google Ads may have accepted this change. It was quarantined and must be reconciled before any retry."
        : "Google Ads rejected this change. Review the recommendation before trying again.",
    };
  }

  // All unexpected exceptions after the dispatched boundary are uncertain.
  return {
    state: "reconciliation_required",
    providerOperationId: null,
    providerStatus: null,
    failureCode: "google_ads_mutation_unclassified_uncertainty",
    failureDetail:
      "The provider result could not be classified. It was quarantined and must be reconciled before any retry.",
  };
}

export function publicGoogleAdsOperation(
  operation: OperationRow,
): GoogleAdsOperationPublicState {
  return {
    id: operation.id,
    state: operation.state,
    version: operation.version,
    provider: operation.provider,
    providerOperationId: operation.providerOperationId,
    providerIdempotencySupported: operation.providerIdempotencySupported,
    term: operation.term,
    matchType: operation.matchType,
    requestedAt: operation.requestedAt.toISOString(),
    dispatchedAt: operation.dispatchedAt?.toISOString() ?? null,
    completedAt: operation.completedAt?.toISOString() ?? null,
    reconciliationRequiredAt:
      operation.reconciliationRequiredAt?.toISOString() ?? null,
    providerStatus: operation.providerStatus,
    failureCode: operation.failureCode,
    failureDetail: operation.failureDetail,
  };
}

export function buildGoogleAdsRecommendationChange(
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (kind !== "negative_keyword") return null;
  const raw = safeString(payload["term"] ?? payload["keyword"]);
  if (!raw) return null;
  const normalized = normalizeGoogleAdsNegativeKeywordTerm(raw);
  return {
    action: "add",
    scope: "customer",
    entity: "negative_keyword",
    current: null,
    currentEvidence: "not_queried",
    proposed: {
      term: normalized.term,
      matchType: normalized.matchType,
    },
  };
}

async function insertOperationAudit(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  input: {
    outcome: "attempted" | "succeeded" | "failed";
    recommendationId: string;
    operation: Pick<
      OperationRow,
      "id" | "state" | "providerRequestKey" | "providerIdempotencySupported"
    >;
    providerOperationId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt: Date;
    auditEventId?: string;
  },
): Promise<string> {
  const auditEventId = input.auditEventId ?? randomUUID();
  await tx.insert(auditLogs).values({
    id: auditEventId,
    actorType: mutation.actor.type,
    actorId: mutation.actor.id ?? null,
    actorRole: mutation.actor.role ?? null,
    actorLabel: mutation.actor.label ?? null,
    sessionId: mutation.actor.sessionId ?? null,
    authMethod: mutation.actor.authMethod,
    correlationId: mutation.correlationId,
    requiredPermissions: mutation.policy.requiredPermissions,
    outcome: input.outcome,
    surface: "team.marketing.ads",
    providerOperationId: input.providerOperationId ?? null,
    idempotencyKeyHash: mutation.idempotencyKeyHash,
    action: mutation.policy.auditAction,
    entityType: "google_ads_analyst_recommendation",
    entityId: input.recommendationId,
    meta: sanitizeAuditMetadata({
      eventId: auditEventId,
      correlationId: mutation.correlationId,
      operationId: mutation.operationId,
      googleAdsOperationId: input.operation.id,
      operationState: input.operation.state,
      provider: "google_ads",
      providerRequestKey: input.operation.providerRequestKey,
      providerIdempotencySupported:
        input.operation.providerIdempotencySupported,
      providerExactlyOnceClaimed: false,
      ...input.metadata,
    }),
    createdAt: input.createdAt,
  });
  return auditEventId;
}

function operationForRequest(
  operations: OperationRow[],
  item: GoogleAdsApplyRequestItem,
  actorId: string,
  idempotencyKeyHash: string,
): OperationRow | null {
  return (
    operations.find(
      (operation) =>
        operation.recommendationId === item.id &&
        operation.actorMemberId === actorId &&
        operation.idempotencyKeyHash === idempotencyKeyHash,
    ) ?? null
  );
}

/**
 * Validate every selected row under locks, then create all requested
 * operations atomically. Existing operations from the same caller key are
 * returned for crash-safe recovery and are never duplicated.
 */
export async function prepareGoogleAdsRecommendationOperations(
  db: DatabaseClient,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  items: GoogleAdsApplyRequestItem[],
): Promise<PreparedGoogleAdsOperation[]> {
  const actorId = requireActorId(mutation);
  const idempotencyKeyHash = requireIdempotencyHash(mutation);
  if (claim.keyHash !== idempotencyKeyHash) {
    throw new TeamMutationFailure(
      "internal",
      "The Google Ads operation key could not be verified.",
    );
  }

  const uniqueIds = new Set(items.map((item) => item.id));
  if (uniqueIds.size !== items.length) {
    throw new TeamMutationFailure(
      "invalid",
      "Each Google Ads recommendation may be selected only once.",
    );
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: googleAdsAnalystRecommendations.id,
        reportId: googleAdsAnalystRecommendations.reportId,
        kind: googleAdsAnalystRecommendations.kind,
        status: googleAdsAnalystRecommendations.status,
        payload: googleAdsAnalystRecommendations.payload,
        updatedAt: googleAdsAnalystRecommendations.updatedAt,
      })
      .from(googleAdsAnalystRecommendations)
      .where(inArray(googleAdsAnalystRecommendations.id, [...uniqueIds]))
      .orderBy(asc(googleAdsAnalystRecommendations.id))
      .for("update");
    if (rows.length !== items.length) {
      throw new TeamMutationFailure(
        "invalid",
        "One or more Google Ads recommendations no longer exist.",
        { status: 404 },
      );
    }

    const operations = await tx
      .select()
      .from(googleAdsRecommendationOperations)
      .where(
        and(
          inArray(googleAdsRecommendationOperations.recommendationId, [
            ...uniqueIds,
          ]),
          eq(
            googleAdsRecommendationOperations.idempotencyKeyHash,
            idempotencyKeyHash,
          ),
          eq(googleAdsRecommendationOperations.actorMemberId, actorId),
        ),
      )
      .orderBy(desc(googleAdsRecommendationOperations.createdAt))
      .for("update");

    const byId = new Map(rows.map((row) => [row.id, row]));
    const prepared: PreparedGoogleAdsOperation[] = [];
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      const row = byId.get(item.id);
      if (!row) {
        throw new TeamMutationFailure(
          "invalid",
          "A selected Google Ads recommendation no longer exists.",
          { status: 404 },
        );
      }

      const existingOperation = operationForRequest(
        operations,
        item,
        actorId,
        idempotencyKeyHash,
      );
      if (existingOperation) {
        if (existingOperation.expectedVersion !== item.expectedVersion) {
          throw new TeamMutationFailure(
            "conflict",
            "This Idempotency-Key belongs to a different recommendation version.",
          );
        }
        prepared.push({
          recommendationId: row.id,
          reportId: row.reportId,
          kind: row.kind,
          recommendationVersion: row.updatedAt.toISOString(),
          operation: existingOperation,
        });
        continue;
      }

      if (row.updatedAt.toISOString() !== item.expectedVersion) {
        throw new TeamMutationFailure(
          "conflict",
          "A Google Ads recommendation changed after it was loaded. Refresh and review the current proposal.",
          { fieldErrors: { version: "The submitted version is stale." } },
        );
      }
      if (row.status !== "approved") {
        const message =
          row.status === "reconciliation_required"
            ? "This recommendation requires provider reconciliation and cannot be applied again."
            : row.status === "applying"
              ? "This recommendation already has an active apply operation."
              : row.status === "applied"
                ? "This recommendation is already applied."
                : "Approve this recommendation before applying it.";
        throw new TeamMutationFailure("conflict", message);
      }
      if (row.kind !== "negative_keyword") {
        throw new TeamMutationFailure(
          "invalid",
          `Google Ads apply does not support recommendation type ${row.kind}.`,
        );
      }

      const rawTerm = recommendationTerm(row.payload);
      const normalized = normalizeGoogleAdsNegativeKeywordTerm(rawTerm);
      const now = new Date();
      const nextVersion = nextTimestamp(row.updatedAt, now);
      const operationId = randomUUID();
      const [operation] = await tx
        .insert(googleAdsRecommendationOperations)
        .values({
          id: operationId,
          recommendationId: row.id,
          parentOperationId: mutation.operationId,
          correlationId: mutation.correlationId,
          idempotencyKeyHash,
          expectedVersion: item.expectedVersion,
          actorMemberId: actorId,
          actorLabel: mutation.actor.label ?? null,
          state: "requested",
          version: 1,
          provider: "google_ads",
          providerRequestKey: randomUUID(),
          providerIdempotencySupported: false,
          term: normalized.term,
          matchType: normalized.matchType,
          requestedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!operation) {
        throw new TeamMutationFailure(
          "internal",
          "The Google Ads operation could not be recorded.",
          { retryable: true },
        );
      }

      const [updated] = await tx
        .update(googleAdsAnalystRecommendations)
        .set({ status: "applying", updatedAt: nextVersion })
        .where(
          and(
            eq(googleAdsAnalystRecommendations.id, row.id),
            eq(googleAdsAnalystRecommendations.status, "approved"),
            eq(googleAdsAnalystRecommendations.updatedAt, row.updatedAt),
          ),
        )
        .returning({ id: googleAdsAnalystRecommendations.id });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "This recommendation changed while the apply operation was being prepared.",
          { retryable: true },
        );
      }

      await tx.insert(googleAdsAnalystRecommendationEvents).values({
        recommendationId: row.id,
        reportId: row.reportId,
        kind: row.kind,
        fromStatus: row.status,
        toStatus: "applying",
        note: "Apply requested. No provider call had started at this checkpoint; Google Ads does not support this caller idempotency key.",
        actorMemberId: actorId,
        actorSource: "ui",
        createdAt: now,
      });
      await insertOperationAudit(tx, mutation, {
        outcome: "attempted",
        recommendationId: row.id,
        operation,
        metadata: {
          phase: "requested",
          providerDispatchPossible: false,
          before: { status: row.status, version: item.expectedVersion },
          after: {
            status: "applying",
            version: nextVersion.toISOString(),
          },
        },
        createdAt: now,
      });

      prepared.push({
        recommendationId: row.id,
        reportId: row.reportId,
        kind: row.kind,
        recommendationVersion: nextVersion.toISOString(),
        operation,
      });
    }
    return prepared;
  });
}

export type ClaimGoogleAdsDispatchResult =
  | { kind: "dispatch"; prepared: PreparedGoogleAdsOperation }
  | { kind: "uncertain"; prepared: PreparedGoogleAdsOperation }
  | { kind: "terminal"; prepared: PreparedGoogleAdsOperation };

export function planGoogleAdsOperationDispatch(
  state: OperationRow["state"],
): "dispatch" | "uncertain" | "terminal" {
  if (state === "requested") return "dispatch";
  if (state === "dispatched") return "uncertain";
  return "terminal";
}

export async function claimGoogleAdsOperationDispatch(
  db: DatabaseClient,
  mutation: TeamMutationContext,
  prepared: PreparedGoogleAdsOperation,
): Promise<ClaimGoogleAdsDispatchResult> {
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(googleAdsRecommendationOperations)
      .where(eq(googleAdsRecommendationOperations.id, prepared.operation.id))
      .for("update")
      .limit(1);
    if (!operation) {
      throw new TeamMutationFailure(
        "internal",
        "The Google Ads operation evidence is missing.",
      );
    }
    const current: PreparedGoogleAdsOperation = {
      ...prepared,
      operation,
    };
    const plan = planGoogleAdsOperationDispatch(operation.state);
    if (plan === "uncertain") {
      return { kind: "uncertain", prepared: current };
    }
    if (plan === "terminal") {
      return { kind: "terminal", prepared: current };
    }

    const now = new Date();
    const [dispatched] = await tx
      .update(googleAdsRecommendationOperations)
      .set({
        state: "dispatched",
        version: operation.version + 1,
        dispatchedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(googleAdsRecommendationOperations.id, operation.id),
          eq(googleAdsRecommendationOperations.state, "requested"),
          eq(googleAdsRecommendationOperations.version, operation.version),
        ),
      )
      .returning();
    if (!dispatched) {
      throw new TeamMutationFailure(
        "conflict",
        "Another request claimed this Google Ads operation.",
        { retryable: true, retryAfter: "1" },
      );
    }

    await tx.insert(googleAdsAnalystRecommendationEvents).values({
      recommendationId: prepared.recommendationId,
      reportId: prepared.reportId,
      kind: prepared.kind,
      fromStatus: "applying",
      toStatus: "applying",
      note: "Provider dispatch boundary entered. Automatic redispatch is disabled because Google Ads does not accept the CRM idempotency key.",
      actorMemberId: mutation.actor.id ?? null,
      actorSource: "ui",
      createdAt: now,
    });
    await insertOperationAudit(tx, mutation, {
      outcome: "attempted",
      recommendationId: prepared.recommendationId,
      operation: dispatched,
      metadata: {
        phase: "dispatched",
        providerDispatchPossible: true,
        redispatchAllowed: false,
      },
      createdAt: now,
    });

    return {
      kind: "dispatch",
      prepared: { ...current, operation: dispatched },
    };
  });
}

export async function finalizeGoogleAdsOperation(
  db: DatabaseClient,
  mutation: TeamMutationContext,
  prepared: PreparedGoogleAdsOperation,
  outcome: GoogleAdsProviderTerminalOutcome,
): Promise<FinalizedGoogleAdsOperation> {
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(googleAdsRecommendationOperations)
      .where(eq(googleAdsRecommendationOperations.id, prepared.operation.id))
      .for("update")
      .limit(1);
    if (!operation) {
      throw new TeamMutationFailure(
        "internal",
        "The Google Ads operation evidence is missing.",
      );
    }
    if (
      operation.state === "succeeded" ||
      operation.state === "failed" ||
      operation.state === "reconciliation_required"
    ) {
      const [recommendation] = await tx
        .select({ updatedAt: googleAdsAnalystRecommendations.updatedAt })
        .from(googleAdsAnalystRecommendations)
        .where(
          eq(googleAdsAnalystRecommendations.id, prepared.recommendationId),
        )
        .limit(1);
      if (!recommendation) {
        throw new TeamMutationFailure(
          "internal",
          "The Google Ads recommendation is missing.",
        );
      }
      if (!operation.terminalAuditEventId || !operation.completedAt) {
        throw new TeamMutationFailure(
          "internal",
          "The terminal Google Ads operation receipt is incomplete.",
        );
      }
      return {
        recommendationId: prepared.recommendationId,
        recommendationStatus:
          operation.state === "succeeded" ? "applied" : operation.state,
        recommendationVersion: recommendation.updatedAt.toISOString(),
        operation: publicGoogleAdsOperation(operation),
        auditEventId: operation.terminalAuditEventId,
        committedAt: operation.completedAt.toISOString(),
      };
    }
    if (operation.state !== "dispatched") {
      throw new TeamMutationFailure(
        "conflict",
        "The Google Ads operation has not crossed the provider dispatch boundary.",
      );
    }

    const [recommendation] = await tx
      .select({
        status: googleAdsAnalystRecommendations.status,
        updatedAt: googleAdsAnalystRecommendations.updatedAt,
      })
      .from(googleAdsAnalystRecommendations)
      .where(eq(googleAdsAnalystRecommendations.id, prepared.recommendationId))
      .for("update")
      .limit(1);
    if (!recommendation || recommendation.status !== "applying") {
      throw new TeamMutationFailure(
        "conflict",
        "The Google Ads recommendation changed before its provider result could be recorded.",
      );
    }

    const now = new Date();
    const recommendationStatus =
      outcome.state === "succeeded" ? "applied" : outcome.state;
    const nextRecommendationVersion = nextTimestamp(
      recommendation.updatedAt,
      now,
    );
    const terminalAuditEventId = randomUUID();
    const auditEventId = await insertOperationAudit(tx, mutation, {
      outcome: outcome.state === "succeeded" ? "succeeded" : "failed",
      recommendationId: prepared.recommendationId,
      operation: { ...operation, state: outcome.state },
      providerOperationId: outcome.providerOperationId,
      metadata: {
        phase: "terminal",
        providerStatus: outcome.providerStatus,
        failureCode: outcome.failureCode,
        failureDetail: outcome.failureDetail,
        redispatchAllowed: false,
        before: {
          status: recommendation.status,
          version: recommendation.updatedAt.toISOString(),
        },
        after: {
          status: recommendationStatus,
          version: nextRecommendationVersion.toISOString(),
        },
      },
      createdAt: now,
      auditEventId: terminalAuditEventId,
    });
    const [settledOperation] = await tx
      .update(googleAdsRecommendationOperations)
      .set({
        state: outcome.state,
        version: operation.version + 1,
        providerOperationId: outcome.providerOperationId,
        terminalAuditEventId,
        providerStatus: outcome.providerStatus,
        completedAt: now,
        reconciliationRequiredAt:
          outcome.state === "reconciliation_required" ? now : null,
        failureCode: outcome.failureCode,
        failureDetail: outcome.failureDetail,
        updatedAt: now,
      })
      .where(
        and(
          eq(googleAdsRecommendationOperations.id, operation.id),
          eq(googleAdsRecommendationOperations.state, "dispatched"),
          eq(googleAdsRecommendationOperations.version, operation.version),
        ),
      )
      .returning();
    if (!settledOperation) {
      throw new TeamMutationFailure(
        "conflict",
        "The Google Ads provider result was claimed by another request.",
      );
    }

    const [updatedRecommendation] = await tx
      .update(googleAdsAnalystRecommendations)
      .set({
        status: recommendationStatus,
        appliedAt: outcome.state === "succeeded" ? now : null,
        updatedAt: nextRecommendationVersion,
      })
      .where(
        and(
          eq(googleAdsAnalystRecommendations.id, prepared.recommendationId),
          eq(googleAdsAnalystRecommendations.status, "applying"),
          eq(
            googleAdsAnalystRecommendations.updatedAt,
            recommendation.updatedAt,
          ),
        ),
      )
      .returning({ id: googleAdsAnalystRecommendations.id });
    if (!updatedRecommendation) {
      throw new TeamMutationFailure(
        "conflict",
        "The recommendation changed while its provider result was being saved.",
      );
    }

    const note =
      outcome.state === "succeeded"
        ? `Google Ads confirmed the negative keyword (${operation.matchType}); provider operation ${outcome.providerOperationId}.`
        : outcome.failureDetail;
    await tx.insert(googleAdsAnalystRecommendationEvents).values({
      recommendationId: prepared.recommendationId,
      reportId: prepared.reportId,
      kind: prepared.kind,
      fromStatus: "applying",
      toStatus: recommendationStatus,
      note: note.slice(0, 800),
      actorMemberId: mutation.actor.id ?? null,
      actorSource: "ui",
      createdAt: now,
    });
    return {
      recommendationId: prepared.recommendationId,
      recommendationStatus,
      recommendationVersion: nextRecommendationVersion.toISOString(),
      operation: publicGoogleAdsOperation(settledOperation),
      auditEventId,
      committedAt: now.toISOString(),
    };
  });
}

export async function latestGoogleAdsOperationsForRecommendations(
  db: DatabaseClient,
  recommendationIds: string[],
): Promise<Map<string, GoogleAdsOperationPublicState>> {
  if (recommendationIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([googleAdsRecommendationOperations.recommendationId])
    .from(googleAdsRecommendationOperations)
    .where(
      inArray(
        googleAdsRecommendationOperations.recommendationId,
        recommendationIds,
      ),
    )
    .orderBy(
      googleAdsRecommendationOperations.recommendationId,
      desc(googleAdsRecommendationOperations.createdAt),
      desc(googleAdsRecommendationOperations.id),
    );
  return new Map(
    rows.map((operation) => [
      operation.recommendationId,
      publicGoogleAdsOperation(operation),
    ]),
  );
}
