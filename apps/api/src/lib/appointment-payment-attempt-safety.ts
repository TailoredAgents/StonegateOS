import {
  ACTIVE_PAYMENT_ATTEMPT_STATUSES,
  requiresSquareAttemptReconciliation,
} from "@/lib/payment-ledger";

export type PaymentCollectionAttemptRow = {
  id: string;
  status: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
};

export type PaymentCollectionAttemptSafety =
  | { kind: "safe"; retryableAttemptId: string | null }
  | { kind: "verification"; attemptId: string }
  | { kind: "reconciliation"; attemptId: string };

/**
 * Only a completed attempt backed by a financially completed payment is
 * settled. A provider reference on a failed/canceled/retryable attempt means
 * money may still exist, so collection must fail closed for reconciliation.
 */
export function classifyPaymentCollectionAttemptSafety(input: {
  attempts: readonly PaymentCollectionAttemptRow[];
  financiallyCompletedPaymentAttemptIds: ReadonlySet<string>;
}): PaymentCollectionAttemptSafety {
  for (const attempt of input.attempts) {
    if (
      ACTIVE_PAYMENT_ATTEMPT_STATUSES.includes(
        attempt.status as (typeof ACTIVE_PAYMENT_ATTEMPT_STATUSES)[number],
      )
    ) {
      return { kind: "verification", attemptId: attempt.id };
    }
  }
  for (const attempt of input.attempts) {
    if (
      requiresSquareAttemptReconciliation(attempt.status) ||
      !["completed", "canceled", "failed", "retryable"].includes(
        attempt.status,
      ) ||
      ((attempt.status === "canceled" ||
        attempt.status === "failed" ||
        attempt.status === "retryable") &&
        (attempt.providerOrderId !== null ||
          attempt.providerPaymentId !== null)) ||
      (attempt.status === "completed" &&
        !input.financiallyCompletedPaymentAttemptIds.has(attempt.id))
    ) {
      return { kind: "reconciliation", attemptId: attempt.id };
    }
  }
  const retryable = input.attempts.filter(
    (attempt) => attempt.status === "retryable",
  );
  if (retryable.length > 1) {
    return { kind: "reconciliation", attemptId: retryable[0]!.id };
  }
  return {
    kind: "safe",
    retryableAttemptId: retryable[0]?.id ?? null,
  };
}
