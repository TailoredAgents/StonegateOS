export type PaymentReconciliationOutcome =
  | "verified"
  | "resolved"
  | "pending"
  | "needs_review"
  | "completed_with_review";

export type PaymentReconciliationFeedback = {
  message: string;
  outcome: PaymentReconciliationOutcome;
  needsAttention: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOutcome(value: unknown): value is PaymentReconciliationOutcome {
  return (
    value === "verified" ||
    value === "resolved" ||
    value === "pending" ||
    value === "needs_review" ||
    value === "completed_with_review"
  );
}

export function parsePaymentReconciliationSuccess(
  value: unknown,
  expectedOperation: string,
): PaymentReconciliationFeedback | null {
  if (!isRecord(value) || value["ok"] !== true) return null;
  const data = value["data"];
  const receipt = value["receipt"];
  if (!isRecord(data) || !isRecord(receipt)) return null;

  const message = data["message"];
  const outcome = data["outcome"];
  const providerEffect = data["providerEffect"];
  const targetId = data["targetId"];
  const committedAt = receipt["committedAt"];
  if (
    data["operation"] !== expectedOperation ||
    !nonemptyString(message) ||
    !isOutcome(outcome) ||
    (providerEffect !== "none" && providerEffect !== "read_only") ||
    (targetId !== null && !nonemptyString(targetId)) ||
    !nonemptyString(receipt["operationId"]) ||
    !nonemptyString(receipt["correlationId"]) ||
    !nonemptyString(receipt["actorId"]) ||
    !nonemptyString(receipt["auditEventId"]) ||
    !nonemptyString(committedAt) ||
    !Number.isFinite(Date.parse(committedAt))
  ) {
    return null;
  }

  return {
    message: message.trim(),
    outcome,
    needsAttention:
      outcome === "pending" ||
      outcome === "needs_review" ||
      outcome === "completed_with_review",
  };
}
