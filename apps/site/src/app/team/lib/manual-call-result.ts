import {
  isTeamMutationSuccessEnvelope,
  type TeamMutationSuccessEnvelope,
} from "./mutation-feedback";

export type ManualCallSuccessData = {
  callOperationId: string;
  state: "active" | "succeeded" | "failed";
  provider: "twilio";
  providerIdempotencySupported: false;
  agentMemberId: string;
  taskId: string | null;
  taskEffects: "pending" | "completed" | "not_connected";
  completedExplicitTaskId: string | null;
  completedFollowupTaskId: string | null;
  completedSpeedToLeadCount: number;
};

export type ManualCallMutationSuccess =
  TeamMutationSuccessEnvelope<ManualCallSuccessData>;

export type ManualCallReconciliationOutcome =
  | "confirmed_connected"
  | "confirmed_not_connected"
  | "confirmed_not_dispatched"
  | "confirmed_active"
  | "still_uncertain";

export type ManualCallReconciliationEvidenceType =
  | "provider_call_record"
  | "provider_no_matching_call"
  | "provider_support_response"
  | "operator_investigation";

export type ManualCallReconciliationSuccessData = {
  reconciliationId: string;
  callOperationId: string;
  outcome: ManualCallReconciliationOutcome;
  evidenceType: ManualCallReconciliationEvidenceType;
  providerEvidenceSource: "operator_supplied";
  originalProviderOutcomePreserved: true;
  contactCallBlockCleared: boolean;
  operationVersion: number;
};

export type ManualCallAttemptResponseMetadata = {
  state:
    | "succeeded"
    | "active"
    | "failed"
    | "confirmed_not_sent"
    | "reconciliation_required"
    | "unknown";
  newAttempt: "none" | "explicit" | "blocked";
  operationId: string | null;
  operationVersion: number | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUuidOrNull(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && UUID_PATTERN.test(value))
  );
}

export function readManualCallAttemptResponseMetadata(
  response: Response,
): ManualCallAttemptResponseMetadata | null {
  const state = response.headers.get("x-call-attempt-state");
  const newAttempt = response.headers.get("x-call-new-attempt");
  if (
    ![
      "succeeded",
      "active",
      "failed",
      "confirmed_not_sent",
      "reconciliation_required",
      "unknown",
    ].includes(state ?? "") ||
    !["none", "explicit", "blocked"].includes(newAttempt ?? "")
  ) {
    return null;
  }
  const operationId = response.headers.get("x-call-operation-id");
  const versionRaw = response.headers.get("x-call-operation-version");
  const operationVersion = versionRaw ? Number.parseInt(versionRaw, 10) : null;
  if (operationId !== null && !UUID_PATTERN.test(operationId)) return null;
  if (
    operationVersion !== null &&
    (!Number.isInteger(operationVersion) || operationVersion < 1)
  ) {
    return null;
  }
  return {
    state: state as ManualCallAttemptResponseMetadata["state"],
    newAttempt: newAttempt as ManualCallAttemptResponseMetadata["newAttempt"],
    operationId,
    operationVersion,
  };
}

/**
 * A 2xx is not call success by itself. Require the committed terminal data,
 * actor/audit receipt, matching contact, operation version, and Twilio SID.
 */
export function isManualCallMutationSuccess(
  value: unknown,
  expectedContactId: string,
): value is ManualCallMutationSuccess {
  if (!isTeamMutationSuccessEnvelope<ManualCallSuccessData>(value)) {
    return false;
  }
  const data = value.data;
  const receipt = value.receipt;
  return (
    isRecord(data) &&
    typeof data["callOperationId"] === "string" &&
    UUID_PATTERN.test(data["callOperationId"]) &&
    ["active", "succeeded", "failed"].includes(data["state"]) &&
    data["provider"] === "twilio" &&
    data["providerIdempotencySupported"] === false &&
    typeof data["agentMemberId"] === "string" &&
    UUID_PATTERN.test(data["agentMemberId"]) &&
    isUuidOrNull(data["taskId"]) &&
    ((data["state"] === "active" && data["taskEffects"] === "pending") ||
      (data["state"] === "succeeded" && data["taskEffects"] === "completed") ||
      (data["state"] === "failed" &&
        data["taskEffects"] === "not_connected")) &&
    isUuidOrNull(data["completedExplicitTaskId"]) &&
    isUuidOrNull(data["completedFollowupTaskId"]) &&
    Number.isInteger(data["completedSpeedToLeadCount"]) &&
    Number(data["completedSpeedToLeadCount"]) >= 0 &&
    (data["state"] === "succeeded" ||
      (data["completedExplicitTaskId"] === null &&
        data["completedFollowupTaskId"] === null &&
        data["completedSpeedToLeadCount"] === 0)) &&
    typeof receipt.auditEventId === "string" &&
    UUID_PATTERN.test(receipt.auditEventId) &&
    receipt.entityType === "contact" &&
    receipt.entityId === expectedContactId &&
    Number.isInteger(receipt.version) &&
    Number(receipt.version) >= 3 &&
    typeof receipt.providerOperationId === "string" &&
    CALL_SID_PATTERN.test(receipt.providerOperationId)
  );
}

export async function readManualCallMutationSuccess(
  response: Response,
  expectedContactId: string,
): Promise<ManualCallMutationSuccess | null> {
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as unknown;
  return isManualCallMutationSuccess(payload, expectedContactId)
    ? payload
    : null;
}

export function isManualCallReconciliationSuccess(
  value: unknown,
  expected: {
    callOperationId: string;
    outcome: ManualCallReconciliationOutcome;
    evidenceType: ManualCallReconciliationEvidenceType;
    previousVersion: number;
  },
): value is TeamMutationSuccessEnvelope<ManualCallReconciliationSuccessData> {
  if (
    !isTeamMutationSuccessEnvelope<ManualCallReconciliationSuccessData>(value)
  ) {
    return false;
  }
  const data = value.data;
  const receipt = value.receipt;
  const shouldClear = [
    "confirmed_connected",
    "confirmed_not_connected",
    "confirmed_not_dispatched",
  ].includes(expected.outcome);
  const expectedVersion = expected.previousVersion + (shouldClear ? 1 : 0);
  return (
    isRecord(data) &&
    typeof data["reconciliationId"] === "string" &&
    UUID_PATTERN.test(data["reconciliationId"]) &&
    data["callOperationId"] === expected.callOperationId &&
    data["outcome"] === expected.outcome &&
    data["evidenceType"] === expected.evidenceType &&
    data["providerEvidenceSource"] === "operator_supplied" &&
    data["originalProviderOutcomePreserved"] === true &&
    data["contactCallBlockCleared"] === shouldClear &&
    data["operationVersion"] === expectedVersion &&
    typeof receipt.auditEventId === "string" &&
    UUID_PATTERN.test(receipt.auditEventId) &&
    receipt.entityType === "team_call_operation" &&
    receipt.entityId === expected.callOperationId &&
    receipt.version === expectedVersion &&
    receipt.providerOperationId === undefined
  );
}
