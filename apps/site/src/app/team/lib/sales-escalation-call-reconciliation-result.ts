import {
  isTeamMutationSuccessEnvelope,
  type TeamMutationSuccessEnvelope,
} from "./mutation-feedback";

export type SalesEscalationCallReconciliationOutcome =
  | "confirmed_dispatched"
  | "confirmed_connected"
  | "confirmed_not_dispatched";

export type SalesEscalationCallReconciliationEvidenceType =
  | "provider_call_record"
  | "provider_no_matching_call"
  | "provider_support_response";

export type SalesEscalationCallReconciliationSuccessData = {
  reconciliationId: string;
  salesEscalationOperationId: string;
  operationState: "reconciliation_required";
  outcome: SalesEscalationCallReconciliationOutcome;
  evidenceType: SalesEscalationCallReconciliationEvidenceType;
  providerEvidenceSource: "operator_supplied";
  originalProviderOutcomePreserved: true;
  providerReplayAttempted: false;
  contactCallBlockCleared: boolean;
  taskEffect:
    | "pending"
    | "completed"
    | "stale"
    | "already_terminal"
    | "not_dispatched";
  callRecordId: string | null;
  operationVersion: number;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isSalesEscalationCallReconciliationSuccess(
  value: unknown,
  expected: {
    operationId: string;
    outcome: SalesEscalationCallReconciliationOutcome;
    evidenceType: SalesEscalationCallReconciliationEvidenceType;
    previousVersion: number;
    providerOperationId: string | null;
  },
): value is TeamMutationSuccessEnvelope<SalesEscalationCallReconciliationSuccessData> {
  if (
    !isTeamMutationSuccessEnvelope<SalesEscalationCallReconciliationSuccessData>(
      value,
    )
  ) {
    return false;
  }
  const data = value.data;
  const receipt = value.receipt;
  const decisive = expected.outcome !== "confirmed_dispatched";
  const expectedTaskEffects =
    expected.outcome === "confirmed_dispatched"
      ? ["pending"]
      : expected.outcome === "confirmed_not_dispatched"
        ? ["not_dispatched"]
        : ["completed", "stale", "already_terminal"];
  const expectedVersion = expected.previousVersion + 1;
  return (
    isRecord(data) &&
    typeof data["reconciliationId"] === "string" &&
    UUID_PATTERN.test(data["reconciliationId"]) &&
    data["salesEscalationOperationId"] === expected.operationId &&
    data["operationState"] === "reconciliation_required" &&
    data["outcome"] === expected.outcome &&
    data["evidenceType"] === expected.evidenceType &&
    data["providerEvidenceSource"] === "operator_supplied" &&
    data["originalProviderOutcomePreserved"] === true &&
    data["providerReplayAttempted"] === false &&
    data["contactCallBlockCleared"] === decisive &&
    expectedTaskEffects.includes(String(data["taskEffect"])) &&
    (data["callRecordId"] === null ||
      (typeof data["callRecordId"] === "string" &&
        UUID_PATTERN.test(data["callRecordId"]))) &&
    (expected.outcome !== "confirmed_connected" ||
      (typeof data["callRecordId"] === "string" &&
        UUID_PATTERN.test(data["callRecordId"]))) &&
    data["operationVersion"] === expectedVersion &&
    typeof receipt.auditEventId === "string" &&
    UUID_PATTERN.test(receipt.auditEventId) &&
    receipt.entityType === "sales_escalation_call_operation" &&
    receipt.entityId === expected.operationId &&
    receipt.version === expectedVersion &&
    (expected.providerOperationId
      ? receipt.providerOperationId === expected.providerOperationId &&
        CALL_SID_PATTERN.test(receipt.providerOperationId)
      : receipt.providerOperationId === undefined)
  );
}
