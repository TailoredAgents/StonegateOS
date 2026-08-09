import { createHash } from "node:crypto";
import {
  AGENT_ACTION_PERMISSIONS,
  canonicalAgentActionJson,
  parseAgentActionPayload,
  type AgentActionPayload,
  type AgentActionType,
  type AgentOperationalMutationResult,
} from "@myst-os/sdk";

export const AGENT_AUTHORITATIVE_OPERATION_ACTIONS = {
  google_ads_recommendations_bulk_update:
    "marketing.google_ads_recommendations.bulk_update",
  google_ads_recommendations_bulk_apply:
    "marketing.google_ads_recommendations.bulk_apply",
} as const satisfies Partial<Record<AgentActionType, string>>;

export type AgentAuthoritativeActionType =
  keyof typeof AGENT_AUTHORITATIVE_OPERATION_ACTIONS;

export type AgentAuthoritativeOperationBinding = {
  auditAction: string;
  route: string;
  entityType: string;
  entityId: string;
  keyHash: string;
  scopeHash: string;
  requestHash: string;
};

export type AgentAuthoritativeIdempotencyEvidence = {
  operationId: string;
  action: string;
  keyHash: string;
  scopeHash: string;
  requestHash: string;
  status: string;
  correlationId: string;
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
};

export type AgentAuthoritativeAuditEvidence = {
  id: string;
  actorId: string | null;
  sessionId: string | null;
  authMethod: string | null;
  correlationId: string | null;
  requiredPermissions: string[] | null;
  outcome: string;
  providerOperationId: string | null;
  idempotencyKeyHash: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: Date;
};

export type AgentAuthoritativeEvidenceResult =
  | { ok: true }
  | { ok: false; reason: string };

export type AgentReservationFinalizationBinding = {
  finalizationId: string | null;
  upstreamOperationId: string | null;
  upstreamHash: string | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isAgentAuthoritativeActionType(
  actionType: AgentActionType,
): actionType is AgentAuthoritativeActionType {
  return actionType in AGENT_AUTHORITATIVE_OPERATION_ACTIONS;
}

export function requireAgentAuthoritativeAuditAction(
  actionType: AgentActionType,
): string | null {
  return isAgentAuthoritativeActionType(actionType)
    ? AGENT_AUTHORITATIVE_OPERATION_ACTIONS[actionType]
    : null;
}

/**
 * An untouched reservation may bind once. A reclaimed exact finalization may
 * reuse that same triple; any alternate key, operation, or response is denied.
 */
export function canBindAgentReservationFinalization(
  current: AgentReservationFinalizationBinding,
  attempted: Required<AgentReservationFinalizationBinding>,
): boolean {
  if (
    current.finalizationId === null &&
    current.upstreamOperationId === null &&
    current.upstreamHash === null
  ) {
    return true;
  }
  return (
    current.finalizationId === attempted.finalizationId &&
    current.upstreamOperationId === attempted.upstreamOperationId &&
    current.upstreamHash === attempted.upstreamHash
  );
}

/**
 * Reproduces the exact operational endpoint fingerprint at reservation time.
 * The server-generated operation key is never accepted from the browser, so a
 * later finalization can only point at the API request reserved for this
 * approved action and payload.
 */
export function buildAgentAuthoritativeOperationBinding(
  actionType: AgentActionType,
  payload: AgentActionPayload,
  operationKey: string,
): AgentAuthoritativeOperationBinding | null {
  if (!isAgentAuthoritativeActionType(actionType)) return null;
  const parsed = parseAgentActionPayload(actionType, payload);
  if (!parsed.ok) return null;
  const rawItems = parsed.payload["items"];
  if (!Array.isArray(rawItems)) return null;
  const items = rawItems
    .map((value) => exactRecord(value))
    .filter((value): value is Record<string, unknown> => value !== null)
    .map((value) => ({
      id: String(value["id"]),
      expectedVersion: String(value["expectedVersion"]),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (items.length !== rawItems.length || items.length === 0) return null;

  const route =
    actionType === "google_ads_recommendations_bulk_update"
      ? "/api/admin/google/ads/analyst/recommendations/bulk"
      : "/api/admin/google/ads/analyst/recommendations/apply/bulk";
  const entityType = "google_ads_analyst_recommendation_batch";
  const entityId =
    actionType === "google_ads_recommendations_bulk_update"
      ? `count:${items.length}`
      : sha256(items.map((item) => item.id).join(":")).slice(0, 24);
  const operationalPayload = { ...parsed.payload, items };
  const scope = { route, entityType, entityId };

  return {
    auditAction: AGENT_AUTHORITATIVE_OPERATION_ACTIONS[actionType],
    route,
    entityType,
    entityId,
    keyHash: sha256(operationKey),
    scopeHash: sha256(canonicalAgentActionJson(scope)),
    requestHash: sha256(
      canonicalAgentActionJson({
        scope,
        payload: operationalPayload,
        expectedVersion: null,
      }),
    ),
  };
}

function auditEntityMatches(
  actionType: AgentAuthoritativeActionType,
  upstream: Extract<AgentOperationalMutationResult, { ok: true }>,
  audit: AgentAuthoritativeAuditEvidence,
): boolean {
  if (actionType === "google_ads_recommendations_bulk_update") {
    return (
      audit.entityType === upstream.receipt.entityType &&
      audit.entityId === upstream.receipt.entityId
    );
  }
  const items = upstream.data["items"];
  return (
    audit.entityType === "google_ads_analyst_recommendation" &&
    typeof audit.entityId === "string" &&
    Array.isArray(items) &&
    items.some((item) => exactRecord(item)?.["id"] === audit.entityId)
  );
}

/** Pure verifier used by the route and adversarial tests. */
export function verifyAgentAuthoritativeOperationEvidence(input: {
  actionType: AgentActionType;
  actorId: string;
  sessionId: string;
  authMethod: string;
  correlationId: string;
  upstreamStatus: number;
  upstreamRaw: unknown;
  upstream: AgentOperationalMutationResult;
  binding: AgentAuthoritativeOperationBinding;
  idempotency: AgentAuthoritativeIdempotencyEvidence;
  audit: AgentAuthoritativeAuditEvidence | null;
}): AgentAuthoritativeEvidenceResult {
  if (!isAgentAuthoritativeActionType(input.actionType)) {
    return { ok: false, reason: "unsupported_action" };
  }
  const expectedAction =
    AGENT_AUTHORITATIVE_OPERATION_ACTIONS[input.actionType];
  const row = input.idempotency;
  if (
    input.binding.auditAction !== expectedAction ||
    row.action !== expectedAction ||
    row.keyHash !== input.binding.keyHash ||
    row.scopeHash !== input.binding.scopeHash ||
    row.requestHash !== input.binding.requestHash ||
    row.correlationId !== input.correlationId ||
    row.responseStatus !== input.upstreamStatus ||
    row.responseBody === null ||
    sha256(canonicalAgentActionJson(row.responseBody)) !==
      sha256(canonicalAgentActionJson(input.upstreamRaw))
  ) {
    return { ok: false, reason: "idempotency_evidence_mismatch" };
  }

  if (!input.upstream.ok) {
    return row.status === "failed"
      ? { ok: true }
      : { ok: false, reason: "failure_not_durable" };
  }

  const receipt = input.upstream.receipt;
  if (
    row.status !== "succeeded" ||
    row.operationId !== receipt.operationId ||
    row.correlationId !== receipt.correlationId
  ) {
    return { ok: false, reason: "operation_receipt_mismatch" };
  }
  const audit = input.audit;
  if (!audit || audit.id !== receipt.auditEventId) {
    return { ok: false, reason: "audit_event_missing" };
  }
  const requiredPermissions = AGENT_ACTION_PERMISSIONS[input.actionType];
  if (
    audit.actorId !== input.actorId ||
    audit.sessionId !== input.sessionId ||
    audit.authMethod !== input.authMethod ||
    audit.action !== expectedAction ||
    audit.outcome !== "succeeded" ||
    audit.correlationId !== receipt.correlationId ||
    audit.idempotencyKeyHash !== row.keyHash ||
    audit.createdAt.toISOString() !== receipt.committedAt ||
    !requiredPermissions.every((permission) =>
      audit.requiredPermissions?.includes(permission),
    ) ||
    !auditEntityMatches(input.actionType, input.upstream, audit) ||
    (receipt.providerOperationId !== undefined &&
      audit.providerOperationId !== receipt.providerOperationId)
  ) {
    return { ok: false, reason: "audit_evidence_mismatch" };
  }
  return { ok: true };
}
