import { allocateRefund } from "@/lib/payment-summary";

export type RevenuePaymentRow = {
  id: string;
  appointmentId: string | null;
  amountCents: number;
  jobAmountCents: number | null;
  tipCents: number;
  totalAmountCents: number | null;
  refundedAmountCents: number;
  status: string;
  canonicalStatus: string | null;
  providerStatus?: string | null;
};

export type RevenueAppointmentRow = {
  id: string;
  status: string;
  appointmentType: string;
  finalTotalCents: number | null;
};

export type RevenueReviewRefundRow = {
  id: string;
  paymentId: string;
  amountCents: number;
};

export type PaymentLedgerReportingSummary = {
  paymentsCollectedCents: number;
  paidTowardJobsCents: number;
  tipsCollectedCents: number;
  outstandingBalanceCents: number;
  refundedCents: number;
  needsReviewCents: number;
  needsReviewCount: number;
};

function nonnegativeCents(value: number | null | undefined): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : 0;
}

function canonicalStatus(row: RevenuePaymentRow): string {
  const canonical = row.canonicalStatus?.trim().toLowerCase();
  if (canonical) return canonical;
  const providerStatus = row.status.trim().toLowerCase();
  return providerStatus === "succeeded" ? "completed" : providerStatus;
}

function isFinanciallyCompleted(
  row: RevenuePaymentRow,
  status: string,
): boolean {
  const providerStatus = row.providerStatus?.trim().toLowerCase();
  return (
    status === "completed" ||
    providerStatus === "completed" ||
    providerStatus === "succeeded"
  );
}

function isBalanceEligible(appointment: RevenueAppointmentRow): boolean {
  const status = appointment.status.trim().toLowerCase();
  if (
    status === "canceled" ||
    status === "cancelled" ||
    status === "no_show"
  ) {
    return false;
  }

  const appointmentType = appointment.appointmentType.trim().toLowerCase();
  return (
    appointmentType !== "in_person_quote" &&
    appointmentType !== "in_person_estimate"
  );
}

export function buildPaymentLedgerReportingSummary(input: {
  appointments: RevenueAppointmentRow[];
  payments: RevenuePaymentRow[];
  reviewRefunds: RevenueReviewRefundRow[];
}): PaymentLedgerReportingSummary {
  let paymentsCollectedCents = 0;
  let paidTowardJobsCents = 0;
  let tipsCollectedCents = 0;
  let refundedCents = 0;
  let needsReviewCents = 0;
  let needsReviewCount = 0;
  const netJobByAppointmentId = new Map<string, number>();

  for (const payment of input.payments) {
    const status = canonicalStatus(payment);
    const amountCents = nonnegativeCents(payment.amountCents);
    const tipCents = nonnegativeCents(payment.tipCents);
    const jobAmountCents =
      payment.jobAmountCents == null
        ? Math.max(amountCents - tipCents, 0)
        : nonnegativeCents(payment.jobAmountCents);
    const totalAmountCents =
      payment.totalAmountCents == null
        ? amountCents
        : nonnegativeCents(payment.totalAmountCents);
    const paymentRefundedCents = nonnegativeCents(
      payment.refundedAmountCents,
    );

    if (status === "needs_review") {
      needsReviewCount += 1;
      needsReviewCents += totalAmountCents;
    }
    if (!isFinanciallyCompleted(payment, status)) continue;

    const allocation = allocateRefund({
      jobAmountCents,
      tipCents,
      refundedAmountCents: paymentRefundedCents,
    });
    paidTowardJobsCents += allocation.netJobCents;
    tipsCollectedCents += allocation.netTipCents;
    paymentsCollectedCents += allocation.netJobCents + allocation.netTipCents;
    refundedCents += paymentRefundedCents;

    if (payment.appointmentId) {
      netJobByAppointmentId.set(
        payment.appointmentId,
        (netJobByAppointmentId.get(payment.appointmentId) ?? 0) +
          allocation.netJobCents,
      );
    }

    if (allocation.overRefundedCents > 0) {
      needsReviewCount += 1;
      needsReviewCents += allocation.overRefundedCents;
    }
  }

  for (const refund of input.reviewRefunds) {
    needsReviewCount += 1;
    needsReviewCents += nonnegativeCents(refund.amountCents);
  }

  let outstandingBalanceCents = 0;
  for (const appointment of input.appointments) {
    if (!isBalanceEligible(appointment)) continue;
    if (appointment.finalTotalCents == null) continue;

    const finalTotalCents = nonnegativeCents(appointment.finalTotalCents);
    const paidCents = netJobByAppointmentId.get(appointment.id) ?? 0;
    outstandingBalanceCents += Math.max(finalTotalCents - paidCents, 0);

    if (paidCents > finalTotalCents) {
      needsReviewCount += 1;
      needsReviewCents += paidCents - finalTotalCents;
    }
  }

  return {
    paymentsCollectedCents,
    paidTowardJobsCents,
    tipsCollectedCents,
    outstandingBalanceCents,
    refundedCents,
    needsReviewCents,
    needsReviewCount,
  };
}
