export const PAYMENT_CANONICAL_STATUSES = [
  "pending",
  "completed",
  "canceled",
  "failed",
  "needs_review",
] as const;

export type PaymentCanonicalStatus =
  (typeof PAYMENT_CANONICAL_STATUSES)[number];

export type AppointmentPaymentStatus =
  | "unknown"
  | "unpaid"
  | "partial"
  | "paid"
  | "refunded"
  | "needs_review";

export type PaymentSummaryEntry = {
  canonicalStatus: string;
  jobAmountCents: number;
  tipCents?: number | null;
  refundedAmountCents?: number | null;
  needsReview?: boolean;
  countTowardBalance?: boolean;
  receiptUrl?: string | null;
  capturedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

export type AppointmentPaymentSummary = {
  status: AppointmentPaymentStatus;
  jobTotalCents: number | null;
  paidTowardJobCents: number;
  tipCents: number;
  refundedCents: number;
  balanceCents: number | null;
  activeAttemptId: string | null;
  latestReceiptUrl: string | null;
};

function nonnegativeInteger(value: number | null | undefined): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : 0;
}

function eventTime(entry: PaymentSummaryEntry): number {
  const raw = entry.capturedAt ?? entry.createdAt;
  if (!raw) return 0;
  const date = raw instanceof Date ? raw : new Date(raw);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

export function allocateRefund(input: {
  jobAmountCents: number;
  tipCents: number;
  refundedAmountCents: number;
}): {
  refundedJobCents: number;
  refundedTipCents: number;
  netJobCents: number;
  netTipCents: number;
  overRefundedCents: number;
} {
  const jobAmountCents = nonnegativeInteger(input.jobAmountCents);
  const tipCents = nonnegativeInteger(input.tipCents);
  const refundedAmountCents = nonnegativeInteger(input.refundedAmountCents);
  const refundedJobCents = Math.min(refundedAmountCents, jobAmountCents);
  const refundedTipCents = Math.min(
    Math.max(refundedAmountCents - refundedJobCents, 0),
    tipCents,
  );
  const allocated = refundedJobCents + refundedTipCents;

  return {
    refundedJobCents,
    refundedTipCents,
    netJobCents: Math.max(jobAmountCents - refundedJobCents, 0),
    netTipCents: Math.max(tipCents - refundedTipCents, 0),
    overRefundedCents: Math.max(refundedAmountCents - allocated, 0),
  };
}

export function buildAppointmentPaymentSummary(input: {
  jobTotalCents: number | null;
  entries: PaymentSummaryEntry[];
  activeAttemptId?: string | null;
  needsReview?: boolean;
}): AppointmentPaymentSummary {
  const jobTotalCents =
    input.jobTotalCents == null
      ? null
      : nonnegativeInteger(input.jobTotalCents);
  let paidTowardJobCents = 0;
  let tipCents = 0;
  let refundedCents = 0;
  let hasCompletedPayment = false;
  let needsReview = input.needsReview === true;
  let latestReceiptUrl: string | null = null;
  let latestReceiptTime = -1;

  for (const entry of input.entries) {
    if (
      entry.canonicalStatus === "needs_review" ||
      entry.needsReview === true
    ) {
      needsReview = true;
    }
    if (
      entry.canonicalStatus !== "completed" &&
      entry.countTowardBalance !== true
    ) {
      continue;
    }

    hasCompletedPayment = true;
    const job = nonnegativeInteger(entry.jobAmountCents);
    const tip = nonnegativeInteger(entry.tipCents);
    const refunded = nonnegativeInteger(entry.refundedAmountCents);
    const allocation = allocateRefund({
      jobAmountCents: job,
      tipCents: tip,
      refundedAmountCents: refunded,
    });
    if (allocation.overRefundedCents > 0) {
      needsReview = true;
    }

    paidTowardJobCents += allocation.netJobCents;
    tipCents += allocation.netTipCents;
    refundedCents += Math.min(refunded, job + tip);

    if (entry.receiptUrl) {
      const time = eventTime(entry);
      if (time >= latestReceiptTime) {
        latestReceiptTime = time;
        latestReceiptUrl = entry.receiptUrl;
      }
    }
  }

  const balanceCents =
    jobTotalCents == null
      ? null
      : Math.max(jobTotalCents - paidTowardJobCents, 0);
  if (jobTotalCents != null && paidTowardJobCents > jobTotalCents) {
    needsReview = true;
  }

  let status: AppointmentPaymentStatus;
  if (needsReview) {
    status = "needs_review";
  } else if (jobTotalCents == null) {
    status = "unknown";
  } else if (
    hasCompletedPayment &&
    refundedCents > 0 &&
    paidTowardJobCents === 0
  ) {
    status = "refunded";
  } else if (paidTowardJobCents === 0) {
    status = "unpaid";
  } else if (balanceCents === 0) {
    status = "paid";
  } else {
    status = "partial";
  }

  return {
    status,
    jobTotalCents,
    paidTowardJobCents,
    tipCents,
    refundedCents,
    balanceCents,
    activeAttemptId: input.activeAttemptId ?? null,
    latestReceiptUrl,
  };
}

export function mapProviderPaymentStatus(
  provider: "square" | "stripe" | "manual" | "legacy",
  providerStatus: string,
): PaymentCanonicalStatus {
  const normalized = providerStatus.trim().toLowerCase();

  if (provider === "square") {
    if (normalized === "completed") return "completed";
    if (normalized === "canceled") return "canceled";
    if (normalized === "failed") return "failed";
    if (normalized === "approved" || normalized === "pending") return "pending";
    return "needs_review";
  }

  if (provider === "stripe") {
    if (normalized === "succeeded") return "completed";
    if (normalized === "failed" || normalized === "requires_payment_method") {
      return "failed";
    }
    if (normalized === "canceled") return "canceled";
    if (
      normalized === "pending" ||
      normalized === "processing" ||
      normalized === "requires_action"
    ) {
      return "pending";
    }
    return "needs_review";
  }

  if (provider === "manual" || provider === "legacy") {
    return normalized === "completed" ? "completed" : "needs_review";
  }

  return "needs_review";
}
