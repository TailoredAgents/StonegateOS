import { createHash } from "node:crypto";
import type { MutationResult } from "@myst-os/sdk";
import { and, eq, lte } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import { teamMutationIdempotency } from "@/db";
import {
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
  teamMutationExceptionResult,
  teamMutationResultResponse,
} from "@/lib/team-mutation";

const CLAIM_LEASE_MS = 30_000;
const MAX_EXTENDED_CLAIM_LEASE_MS = 15 * 60 * 1_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_CLAIM_ATTEMPTS = 3;
const MAX_SCOPE_PART_LENGTH = 500;

export type TeamMutationIdempotencyInput = {
  route: string;
  entityType: string;
  entityId: string;
  /** JSON-compatible values only. Object keys are sorted before hashing. */
  payload?: unknown;
};

export type TeamMutationIdempotencyFingerprint = {
  principalHash: string;
  keyHash: string;
  scopeHash: string;
  requestHash: string;
};

export type TeamMutationIdempotencyClaim =
  TeamMutationIdempotencyFingerprint & {
    id: string;
    operationId: string;
    attemptCount: number;
  };

export type TeamMutationIdempotencyReplay = {
  result: MutationResult<unknown>;
  status: number;
  correlationId: string;
};

export type TeamMutationIdempotencyClaimResult =
  | { kind: "execute"; claim: TeamMutationIdempotencyClaim }
  | { kind: "replay"; replay: TeamMutationIdempotencyReplay };

type IdempotencyRecord = typeof teamMutationIdempotency.$inferSelect;

export type TeamMutationIdempotencyDecision =
  | { kind: "scope_conflict" }
  | { kind: "replay" }
  | { kind: "expired" }
  | { kind: "in_progress"; retryAfterSeconds: number }
  | { kind: "reclaim" }
  | { kind: "exhausted" }
  | { kind: "corrupt" };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TeamMutationFailure(
        "invalid",
        "The idempotent request contains a non-finite number.",
      );
    }
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TeamMutationFailure(
        "invalid",
        "The idempotent request payload must not contain cycles.",
      );
    }
    const nextAncestors = new Set(ancestors).add(value);
    return value.map((item) =>
      item === undefined ? null : canonicalize(item, nextAncestors),
    );
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) {
      throw new TeamMutationFailure(
        "invalid",
        "The idempotent request payload must not contain cycles.",
      );
    }
    const nextAncestors = new Set(ancestors).add(value);
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined)
        canonical[key] = canonicalize(item, nextAncestors);
    }
    return canonical;
  }
  throw new TeamMutationFailure(
    "invalid",
    "The idempotent request payload must be JSON-compatible.",
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

function normalizedScopePart(value: string, name: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > MAX_SCOPE_PART_LENGTH) {
    throw new TeamMutationFailure(
      "invalid",
      `The idempotency ${name} is invalid.`,
    );
  }
  return normalized;
}

/**
 * Builds fingerprints without retaining or returning the raw client key.
 * Canonical serialization makes payload key order irrelevant while preserving
 * array order and the exact expected record version.
 */
export function fingerprintTeamMutationIdempotency(
  mutation: TeamMutationContext,
  input: TeamMutationIdempotencyInput,
): TeamMutationIdempotencyFingerprint {
  if (!mutation.idempotencyKeyHash) {
    throw new TeamMutationFailure(
      "invalid",
      "A valid Idempotency-Key is required for this action.",
    );
  }

  const principalIdentity =
    mutation.principalType === "human"
      ? `human:${mutation.actor.id ?? ""}`
      : `service:${mutation.actor.label ?? ""}`;
  const route = normalizedScopePart(input.route, "route");
  const entityType = normalizedScopePart(input.entityType, "entity type");
  const entityId = normalizedScopePart(input.entityId, "entity ID");
  const scope = { route, entityType, entityId };
  const scopeJson = canonicalJson(scope);

  return {
    principalHash: sha256(principalIdentity),
    keyHash: mutation.idempotencyKeyHash,
    scopeHash: sha256(scopeJson),
    requestHash: sha256(
      canonicalJson({
        scope,
        payload: input.payload ?? null,
        expectedVersion: mutation.expectedVersion,
      }),
    ),
  };
}

/** Pure decision function used by the durable store and focused unit tests. */
export function classifyTeamMutationIdempotencyRecord(
  record: Pick<
    IdempotencyRecord,
    | "scopeHash"
    | "requestHash"
    | "status"
    | "attemptCount"
    | "claimExpiresAt"
    | "expiresAt"
    | "responseStatus"
    | "responseBody"
  >,
  fingerprint: Pick<
    TeamMutationIdempotencyFingerprint,
    "scopeHash" | "requestHash"
  >,
  now: Date,
): TeamMutationIdempotencyDecision {
  if (
    record.scopeHash !== fingerprint.scopeHash ||
    record.requestHash !== fingerprint.requestHash
  ) {
    return { kind: "scope_conflict" };
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return { kind: "expired" };
  }
  if (record.status === "succeeded" || record.status === "failed") {
    return record.responseBody !== null && record.responseStatus !== null
      ? { kind: "replay" }
      : { kind: "corrupt" };
  }
  if (record.status !== "in_progress") return { kind: "corrupt" };
  if (record.claimExpiresAt.getTime() > now.getTime()) {
    return {
      kind: "in_progress",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((record.claimExpiresAt.getTime() - now.getTime()) / 1_000),
      ),
    };
  }
  return record.attemptCount < MAX_CLAIM_ATTEMPTS
    ? { kind: "reclaim" }
    : { kind: "exhausted" };
}

function executableClaim(
  record: Pick<IdempotencyRecord, "id" | "operationId" | "attemptCount">,
  fingerprint: TeamMutationIdempotencyFingerprint,
): TeamMutationIdempotencyClaim {
  return { ...fingerprint, ...record };
}

function assertStoredReplay(
  record: Pick<
    IdempotencyRecord,
    "responseBody" | "responseStatus" | "correlationId"
  >,
): TeamMutationIdempotencyReplay {
  const body = record.responseBody;
  if (
    body === null ||
    typeof body["ok"] !== "boolean" ||
    record.responseStatus === null
  ) {
    throw new TeamMutationFailure(
      "internal",
      "The original operation completed, but its replay receipt is unavailable. Contact support before retrying.",
    );
  }
  return {
    result: body as MutationResult<unknown>,
    status: record.responseStatus,
    correlationId: record.correlationId,
  };
}

export async function claimTeamMutationIdempotency(
  db: DatabaseClient,
  mutation: TeamMutationContext,
  input: TeamMutationIdempotencyInput,
  now = new Date(),
): Promise<TeamMutationIdempotencyClaimResult> {
  const fingerprint = fingerprintTeamMutationIdempotency(mutation, input);
  const claimExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
  const expiresAt = new Date(now.getTime() + RETENTION_MS);

  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(teamMutationIdempotency)
      .values({
        ...fingerprint,
        action: mutation.policy.auditAction,
        operationId: mutation.operationId,
        correlationId: mutation.correlationId,
        attemptCount: 1,
        claimedAt: now,
        claimExpiresAt,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          teamMutationIdempotency.principalHash,
          teamMutationIdempotency.action,
          teamMutationIdempotency.keyHash,
        ],
      })
      .returning({
        id: teamMutationIdempotency.id,
        operationId: teamMutationIdempotency.operationId,
        attemptCount: teamMutationIdempotency.attemptCount,
      });
    if (inserted) {
      return { kind: "execute", claim: executableClaim(inserted, fingerprint) };
    }

    // The unique insert may briefly wait for a concurrent short claim
    // transaction. Once visible, lock the row so only one stale takeover wins.
    const [existing] = await tx
      .select()
      .from(teamMutationIdempotency)
      .where(
        and(
          eq(teamMutationIdempotency.principalHash, fingerprint.principalHash),
          eq(teamMutationIdempotency.action, mutation.policy.auditAction),
          eq(teamMutationIdempotency.keyHash, fingerprint.keyHash),
        ),
      )
      .for("update")
      .limit(1);
    if (!existing) {
      throw new TeamMutationFailure(
        "internal",
        "The operation claim could not be verified. Try again.",
        { retryable: true },
      );
    }

    const decision = classifyTeamMutationIdempotencyRecord(
      existing,
      fingerprint,
      now,
    );
    if (decision.kind === "scope_conflict") {
      throw new TeamMutationFailure(
        "conflict",
        "This Idempotency-Key was already used for a different record, payload, or version. Use a new key.",
      );
    }
    if (decision.kind === "corrupt") {
      throw new TeamMutationFailure(
        "internal",
        "The original operation state is incomplete. Contact support before retrying.",
      );
    }
    if (decision.kind === "replay") {
      return { kind: "replay", replay: assertStoredReplay(existing) };
    }
    if (decision.kind === "expired") {
      throw new TeamMutationFailure(
        "conflict",
        "This Idempotency-Key has expired. Refresh and use a new key before retrying.",
      );
    }
    if (decision.kind === "in_progress") {
      throw new TeamMutationFailure(
        "conflict",
        "This operation is already in progress. Retry after the indicated delay.",
        {
          retryable: true,
          retryAfter: String(decision.retryAfterSeconds),
        },
      );
    }
    if (decision.kind === "exhausted") {
      throw new TeamMutationFailure(
        "conflict",
        "This operation could not be safely recovered after three attempts. Contact support before retrying.",
      );
    }

    const nextAttempt = existing.attemptCount + 1;
    const [reclaimed] = await tx
      .update(teamMutationIdempotency)
      .set({
        operationId: mutation.operationId,
        correlationId: mutation.correlationId,
        attemptCount: nextAttempt,
        claimedAt: now,
        claimExpiresAt,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(teamMutationIdempotency.id, existing.id),
          eq(teamMutationIdempotency.status, "in_progress"),
          eq(teamMutationIdempotency.attemptCount, existing.attemptCount),
          lte(teamMutationIdempotency.claimExpiresAt, now),
        ),
      )
      .returning({
        id: teamMutationIdempotency.id,
        operationId: teamMutationIdempotency.operationId,
        attemptCount: teamMutationIdempotency.attemptCount,
      });
    if (!reclaimed) {
      throw new TeamMutationFailure(
        "conflict",
        "This operation was claimed by another request. Retry shortly.",
        { retryable: true, retryAfter: "1" },
      );
    }
    return {
      kind: "execute",
      claim: executableClaim(reclaimed, fingerprint),
    };
  });
}

/**
 * Store the exact terminal response in the same transaction as the business
 * mutation and success audit. A lost or stale lease makes this update fail,
 * which rolls the business mutation back instead of allowing two executions.
 */
export async function completeTeamMutationIdempotency<T>(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  result: MutationResult<T>,
  responseStatus: number,
  now = new Date(),
): Promise<void> {
  const [completed] = await tx
    .update(teamMutationIdempotency)
    .set({
      status: result.ok ? "succeeded" : "failed",
      responseStatus,
      responseBody: result as unknown as Record<string, unknown>,
      completedAt: now,
      lastErrorCode: result.ok ? null : result.code,
      updatedAt: now,
    })
    .where(
      and(
        eq(teamMutationIdempotency.id, claim.id),
        eq(teamMutationIdempotency.status, "in_progress"),
        eq(teamMutationIdempotency.operationId, mutation.operationId),
        eq(teamMutationIdempotency.scopeHash, claim.scopeHash),
        eq(teamMutationIdempotency.requestHash, claim.requestHash),
      ),
    )
    .returning({ id: teamMutationIdempotency.id });
  if (!completed) {
    throw new TeamMutationFailure(
      "conflict",
      "The operation lease changed before commit. No changes were saved; retry shortly.",
      { retryable: true, retryAfter: "1" },
    );
  }
}

/**
 * Extends an active claim before a bounded provider read that may outlive the
 * default 30-second lease. The operation ID and fingerprints make a stale
 * worker unable to extend a claim that another request already reclaimed.
 */
export async function extendTeamMutationIdempotencyLease(
  db: DatabaseClient,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  leaseMs: number,
  now = new Date(),
): Promise<Date> {
  if (
    !Number.isInteger(leaseMs) ||
    leaseMs < CLAIM_LEASE_MS ||
    leaseMs > MAX_EXTENDED_CLAIM_LEASE_MS
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The requested operation lease is outside the safe range.",
    );
  }

  const claimExpiresAt = new Date(now.getTime() + leaseMs);
  const [extended] = await db
    .update(teamMutationIdempotency)
    .set({ claimExpiresAt, updatedAt: now })
    .where(
      and(
        eq(teamMutationIdempotency.id, claim.id),
        eq(teamMutationIdempotency.status, "in_progress"),
        eq(teamMutationIdempotency.operationId, mutation.operationId),
        eq(teamMutationIdempotency.scopeHash, claim.scopeHash),
        eq(teamMutationIdempotency.requestHash, claim.requestHash),
      ),
    )
    .returning({ id: teamMutationIdempotency.id });
  if (!extended) {
    throw new TeamMutationFailure(
      "conflict",
      "The operation lease changed before the provider check started. Retry shortly.",
      { retryable: true, retryAfter: "1" },
    );
  }
  return claimExpiresAt;
}

/**
 * Preserve deterministic non-retryable failures. Retryable failures only
 * expire the current lease; the next request may take over, up to three total
 * attempts. Failure to settle is safe because the 30-second lease still
 * provides bounded crash recovery.
 */
export async function settleTeamMutationIdempotencyFailure(
  db: DatabaseClient,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  error: unknown,
  now = new Date(),
): Promise<void> {
  const failure = teamMutationExceptionResult(error);
  if (failure.result.retryable) {
    await db
      .update(teamMutationIdempotency)
      .set({
        claimExpiresAt: now,
        lastErrorCode: failure.result.code,
        updatedAt: now,
      })
      .where(
        and(
          eq(teamMutationIdempotency.id, claim.id),
          eq(teamMutationIdempotency.status, "in_progress"),
          eq(teamMutationIdempotency.operationId, mutation.operationId),
        ),
      );
    return;
  }

  await db
    .update(teamMutationIdempotency)
    .set({
      status: "failed",
      responseStatus: failure.status,
      responseBody: failure.result as unknown as Record<string, unknown>,
      completedAt: now,
      lastErrorCode: failure.result.code,
      updatedAt: now,
    })
    .where(
      and(
        eq(teamMutationIdempotency.id, claim.id),
        eq(teamMutationIdempotency.status, "in_progress"),
        eq(teamMutationIdempotency.operationId, mutation.operationId),
      ),
    );
}

export function teamMutationIdempotencyReplayResponse(
  replay: TeamMutationIdempotencyReplay,
): Response {
  return teamMutationResultResponse(
    replay.result,
    replay.status,
    replay.correlationId,
    { "idempotency-replayed": "true" },
  );
}
