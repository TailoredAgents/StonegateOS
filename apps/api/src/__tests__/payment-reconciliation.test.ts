import { evaluateLegacyStripeResolution } from "@/lib/payment-reconciliation";
import { buildAppointmentPaymentSummary } from "@/lib/payment-summary";

const validInput = {
  provider: "stripe",
  providerStatus: "succeeded",
  canonicalStatus: "needs_review",
  totalAmountCents: 12_000,
  refundedAmountCents: 0,
  jobAmountCents: 10_000,
  tipCents: 2_000,
  appointmentFinalTotalCents: 15_000,
  otherPaidTowardJobCents: 5_000,
  hasOtherReviewItems: false,
  reviewNote: "Matched the Stripe receipt and customer appointment.",
} as const;

describe("legacy Stripe owner resolution", () => {
  it("accepts an explicit allocation that fits the remaining job balance", () => {
    const decision = evaluateLegacyStripeResolution(validInput);
    expect(decision).toEqual({
      ok: true,
      jobAmountCents: 10_000,
      tipCents: 2_000,
      netJobAmountCents: 10_000,
    });
    expect(
      buildAppointmentPaymentSummary({
        jobTotalCents: 15_000,
        entries: [
          { canonicalStatus: "completed", jobAmountCents: 5_000 },
          {
            canonicalStatus: "completed",
            jobAmountCents: decision.ok ? decision.jobAmountCents : 0,
            tipCents: decision.ok ? decision.tipCents : 0,
          },
        ],
      }),
    ).toMatchObject({
      status: "paid",
      paidTowardJobCents: 15_000,
      tipCents: 2_000,
      balanceCents: 0,
    });
  });

  it("requires an explicit owner review reason", () => {
    expect(
      evaluateLegacyStripeResolution({
        ...validInput,
        reviewNote: "   ",
      }),
    ).toEqual({ ok: false, code: "owner_review_note_required" });
  });

  it("requires a completed Stripe provider status and a review row", () => {
    expect(
      evaluateLegacyStripeResolution({
        ...validInput,
        providerStatus: "processing",
      }),
    ).toEqual({ ok: false, code: "stripe_payment_not_completed" });
    expect(
      evaluateLegacyStripeResolution({
        ...validInput,
        canonicalStatus: "completed",
      }),
    ).toEqual({ ok: false, code: "stripe_payment_not_in_review" });
  });

  it("rejects allocation guesses and unresolved neighboring records", () => {
    expect(
      evaluateLegacyStripeResolution({
        ...validInput,
        jobAmountCents: 9_999,
      }),
    ).toEqual({ ok: false, code: "stripe_allocation_mismatch" });
    expect(
      evaluateLegacyStripeResolution({
        ...validInput,
        hasOtherReviewItems: true,
      }),
    ).toEqual({
      ok: false,
      code: "appointment_has_other_payment_review",
    });
  });

  it("keeps an over-allocation in owner review", () => {
    expect(
      evaluateLegacyStripeResolution({
        ...validInput,
        appointmentFinalTotalCents: 14_999,
      }),
    ).toEqual({
      ok: false,
      code: "stripe_job_amount_exceeds_balance",
    });
  });

  it("uses net job money after a recorded refund", () => {
    expect(
      evaluateLegacyStripeResolution({
        ...validInput,
        refundedAmountCents: 2_000,
        appointmentFinalTotalCents: 13_000,
      }),
    ).toEqual({
      ok: true,
      jobAmountCents: 10_000,
      tipCents: 2_000,
      netJobAmountCents: 8_000,
    });
  });
});
