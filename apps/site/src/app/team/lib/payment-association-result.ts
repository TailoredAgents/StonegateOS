export type PaymentAssociationAction = "attach" | "detach";

type ExpectedPaymentAssociationResult = {
  action: PaymentAssociationAction;
  paymentId: string;
  appointmentId: string | null;
  previousAppointmentId?: string;
};

export type PaymentAssociationFeedback = {
  action: PaymentAssociationAction;
  paymentId: string;
  appointmentId: string | null;
  version: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A 2xx status is not success by itself. The Site only announces a changed
 * payment link after the API returns the expected entity, link, version, and
 * transaction-bound audit receipt.
 */
export function parsePaymentAssociationSuccess(
  value: unknown,
  expected: ExpectedPaymentAssociationResult,
): PaymentAssociationFeedback | null {
  if (!isRecord(value) || value["ok"] !== true) return null;
  const data = value["data"];
  const receipt = value["receipt"];
  if (!isRecord(data) || !isRecord(receipt)) return null;

  const version = data["version"];
  const receiptVersion = receipt["version"];
  const expectedStatus =
    expected.action === "attach" ? "completed" : "needs_review";
  const previousAppointmentMatches =
    expected.action === "attach" ||
    data["previousAppointmentId"] === expected.previousAppointmentId;
  if (
    data["action"] !== expected.action ||
    data["paymentId"] !== expected.paymentId ||
    data["appointmentId"] !== expected.appointmentId ||
    !previousAppointmentMatches ||
    !nonemptyString(data["provider"]) ||
    data["canonicalStatus"] !== expectedStatus ||
    data["providerEffect"] !== "none" ||
    !nonemptyString(version) ||
    !Number.isFinite(Date.parse(version)) ||
    receiptVersion !== version ||
    !nonemptyString(receipt["operationId"]) ||
    !nonemptyString(receipt["correlationId"]) ||
    !nonemptyString(receipt["actorId"]) ||
    !nonemptyString(receipt["auditEventId"]) ||
    receipt["entityType"] !== "payment" ||
    receipt["entityId"] !== expected.paymentId ||
    !nonemptyString(receipt["committedAt"]) ||
    !Number.isFinite(Date.parse(receipt["committedAt"]))
  ) {
    return null;
  }

  const linkedIntegrity =
    expected.action === "attach"
      ? data["appointmentTipSynchronized"] === true
      : data["previousAppointmentTipSynchronized"] === true;
  if (!linkedIntegrity) return null;

  return {
    action: expected.action,
    paymentId: expected.paymentId,
    appointmentId: expected.appointmentId,
    version,
  };
}
