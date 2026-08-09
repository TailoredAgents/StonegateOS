export const PAYMENT_RECONCILIATION_CONFIRMATIONS = {
  run_square_reconciliation_sweep: "RUN SQUARE CHECK",
  retry_square_attempt: "RETRY SQUARE ATTEMPT",
  dismiss_square_attempt: "NO SQUARE CHARGE",
  retry_square_event: "RETRY SQUARE EVENT",
  retry_square_payment: "RETRY SQUARE PAYMENT",
  retry_square_refund: "RETRY SQUARE REFUND",
  resolve_stripe_payment: "ATTACH STRIPE PAYMENT",
  acknowledge_refund_impact: "ACKNOWLEDGE REFUND IMPACT",
} as const;

export type PaymentReconciliationOperation =
  keyof typeof PAYMENT_RECONCILIATION_CONFIRMATIONS;

export type PaymentReconciliationOutcome =
  | "verified"
  | "resolved"
  | "pending"
  | "needs_review"
  | "completed_with_review";

export type PaymentReconciliationSummary = {
  outcome: PaymentReconciliationOutcome;
  message: string;
};

export type SquareSweepResult = {
  pending: number;
  needsReview: number;
  unmatched: number;
  refundsNeedsReview: number;
};

export function squareProviderEventVersion(input: {
  processingStatus: string;
  receivedAt: Date | string;
  processedAt: Date | string | null;
}): string {
  const timestamp = input.processedAt ?? input.receivedAt;
  const iso = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  return `${input.processingStatus}:${iso}`;
}

export function nextPaymentReconciliationVersion(
  previous: Date,
  candidate = new Date(),
): Date {
  return new Date(Math.max(candidate.getTime(), previous.getTime() + 1));
}

export function summarizeSquareSweep(
  result: SquareSweepResult,
): PaymentReconciliationSummary {
  if (
    result.pending > 0 ||
    result.needsReview > 0 ||
    result.unmatched > 0 ||
    result.refundsNeedsReview > 0
  ) {
    return {
      outcome: "completed_with_review",
      message:
        "Square check finished, but one or more payment records still need review. No charge or refund was initiated by this check.",
    };
  }
  return {
    outcome: "verified",
    message:
      "Square check finished and found no unresolved payment items. No charge or refund was initiated by this check.",
  };
}

export function summarizeSquareRecordResult(input: {
  kind: "attempt" | "event" | "payment" | "refund";
  status: string;
}): PaymentReconciliationSummary {
  if (input.status === "verified" || input.status === "processed") {
    return {
      outcome: "verified",
      message: `Square verified the ${input.kind} and refreshed its local reconciliation records. No charge or refund was initiated by this check.`,
    };
  }
  if (input.status === "pending_verification") {
    return {
      outcome: "pending",
      message:
        "Square check finished, but the payment is still pending verification. No charge or refund was initiated by this check.",
    };
  }
  if (input.status === "failed") {
    return {
      outcome: "needs_review",
      message:
        "Square could not verify the provider event. It remains in owner review, and no charge or refund was initiated by this check.",
    };
  }
  return {
    outcome: "needs_review",
    message: `Square refreshed the ${input.kind}, but it still needs owner review. No charge or refund was initiated by this check.`,
  };
}
