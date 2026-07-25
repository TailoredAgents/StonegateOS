import { buildPaymentLedgerReportingSummary } from "@/lib/revenue-payment-ledger";

describe("payment ledger reporting summary", () => {
  it("separates completed job revenue from net payments and job balances", () => {
    const summary = buildPaymentLedgerReportingSummary({
      appointments: [
        {
          id: "paid-job",
          status: "completed",
          appointmentType: "job",
          finalTotalCents: 10_000,
        },
        {
          id: "open-job",
          status: "confirmed",
          appointmentType: "job",
          finalTotalCents: 7_500,
        },
      ],
      payments: [
        {
          id: "payment-1",
          appointmentId: "paid-job",
          amountCents: 12_000,
          jobAmountCents: 10_000,
          tipCents: 2_000,
          totalAmountCents: 12_000,
          refundedAmountCents: 0,
          status: "succeeded",
          canonicalStatus: "completed",
        },
      ],
      reviewRefunds: [],
    });

    expect(summary).toMatchObject({
      paymentsCollectedCents: 12_000,
      paidTowardJobsCents: 10_000,
      tipsCollectedCents: 2_000,
      outstandingBalanceCents: 7_500,
      refundedCents: 0,
      needsReviewCents: 0,
      needsReviewCount: 0,
    });
  });

  it("reports refunds without letting tips reduce the job balance", () => {
    const summary = buildPaymentLedgerReportingSummary({
      appointments: [
        {
          id: "job-1",
          status: "completed",
          appointmentType: "job",
          finalTotalCents: 10_000,
        },
      ],
      payments: [
        {
          id: "payment-1",
          appointmentId: "job-1",
          amountCents: 12_000,
          jobAmountCents: 10_000,
          tipCents: 2_000,
          totalAmountCents: 12_000,
          refundedAmountCents: 11_000,
          status: "succeeded",
          canonicalStatus: "completed",
        },
      ],
      reviewRefunds: [],
    });

    expect(summary.paymentsCollectedCents).toBe(1_000);
    expect(summary.paidTowardJobsCents).toBe(0);
    expect(summary.tipsCollectedCents).toBe(1_000);
    expect(summary.outstandingBalanceCents).toBe(10_000);
    expect(summary.refundedCents).toBe(11_000);
  });

  it("counts provider review rows, review refunds, and overpayments", () => {
    const summary = buildPaymentLedgerReportingSummary({
      appointments: [
        {
          id: "job-1",
          status: "completed",
          appointmentType: "job",
          finalTotalCents: 5_000,
        },
        {
          id: "quote-only",
          status: "completed",
          appointmentType: "in_person_quote",
          finalTotalCents: 99_000,
        },
        {
          id: "canceled-job",
          status: "canceled",
          appointmentType: "job",
          finalTotalCents: 99_000,
        },
      ],
      payments: [
        {
          id: "completed-overpayment",
          appointmentId: "job-1",
          amountCents: 6_000,
          jobAmountCents: 6_000,
          tipCents: 0,
          totalAmountCents: 6_000,
          refundedAmountCents: 0,
          status: "succeeded",
          canonicalStatus: "completed",
        },
        {
          id: "provider-review",
          appointmentId: null,
          amountCents: 2_500,
          jobAmountCents: 2_500,
          tipCents: 0,
          totalAmountCents: 2_500,
          refundedAmountCents: 0,
          status: "unknown",
          canonicalStatus: "needs_review",
          providerStatus: "succeeded",
        },
      ],
      reviewRefunds: [
        {
          id: "refund-review",
          paymentId: "completed-overpayment",
          amountCents: 500,
        },
      ],
    });

    expect(summary.outstandingBalanceCents).toBe(0);
    expect(summary.paymentsCollectedCents).toBe(8_500);
    expect(summary.needsReviewCount).toBe(3);
    expect(summary.needsReviewCents).toBe(4_000);
  });
});
