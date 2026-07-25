import {
  classifyHistoricalAppointmentForPaymentMigration,
  summarizeHistoricalPaymentMigrationAudit,
  type HistoricalAppointmentForAudit,
} from "@/lib/payment-migration-audit";

function appointment(
  input: Partial<HistoricalAppointmentForAudit> = {},
): HistoricalAppointmentForAudit {
  return {
    id: input.id ?? "appointment-1",
    finalTotalCents:
      "finalTotalCents" in input
        ? (input.finalTotalCents ?? null)
        : 10_000,
    cardTipCents:
      "cardTipCents" in input ? (input.cardTipCents ?? null) : 0,
    stripePayments: input.stripePayments ?? [],
  };
}

function stripe(
  input: {
    id?: string;
    amountCents?: number;
    status?: string;
  } = {},
) {
  return {
    id: input.id ?? "payment-1",
    stripeChargeId: `ch_${input.id ?? "payment-1"}`,
    amountCents: input.amountCents ?? 10_000,
    status: input.status ?? "succeeded",
  };
}

describe("historical payment migration audit", () => {
  it("predicts a legacy completion row when no Stripe payment covers the job", () => {
    expect(
      classifyHistoricalAppointmentForPaymentMigration(
        appointment({ cardTipCents: 1_500 }),
      ),
    ).toMatchObject({
      disposition: "legacy_completion",
      predictedStripeJobCoverageCents: 0,
      predictedLegacyJobCents: 10_000,
      predictedLegacyTipCents: 1_500,
      migrationWouldMarkNeedsReview: false,
    });
  });

  it("separates an unambiguous card tip from one successful Stripe row", () => {
    expect(
      classifyHistoricalAppointmentForPaymentMigration(
        appointment({
          cardTipCents: 1_000,
          stripePayments: [stripe({ amountCents: 11_000 })],
        }),
      ),
    ).toMatchObject({
      disposition: "covered_by_stripe",
      successfulStripePaymentCount: 1,
      successfulStripeGrossCents: 11_000,
      predictedStripeJobCoverageCents: 10_000,
      predictedLegacyJobCents: 0,
      predictedLegacyTipCents: 0,
      migrationWouldMarkNeedsReview: false,
    });
  });

  it("predicts a legacy remainder after an unambiguous partial Stripe row", () => {
    expect(
      classifyHistoricalAppointmentForPaymentMigration(
        appointment({
          finalTotalCents: 15_000,
          stripePayments: [stripe({ amountCents: 9_000 })],
        }),
      ),
    ).toMatchObject({
      disposition: "legacy_completion",
      predictedStripeJobCoverageCents: 9_000,
      predictedLegacyJobCents: 6_000,
    });
  });

  it("routes an overpayment to review and does not predict a legacy row", () => {
    const result = classifyHistoricalAppointmentForPaymentMigration(
      appointment({
        cardTipCents: 1_000,
        stripePayments: [stripe({ amountCents: 12_000 })],
      }),
    );

    expect(result).toMatchObject({
      disposition: "needs_review",
      predictedStripeJobCoverageCents: 0,
      predictedLegacyJobCents: 0,
      migrationWouldMarkNeedsReview: true,
      requiresManualReview: true,
    });
    expect(result.issues).toContain(
      "stripe_job_amount_over_final_total",
    );
  });

  it("flags a positive tip across multiple successful Stripe rows as ambiguous", () => {
    const result = classifyHistoricalAppointmentForPaymentMigration(
      appointment({
        finalTotalCents: 20_000,
        cardTipCents: 1_000,
        stripePayments: [
          stripe({ id: "one", amountCents: 10_000 }),
          stripe({ id: "two", amountCents: 10_000 }),
        ],
      }),
    );

    expect(result).toMatchObject({
      disposition: "needs_review",
      successfulStripePaymentCount: 2,
      migrationWouldMarkNeedsReview: true,
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        "multiple_successful_stripe_payments",
        "conflicting_tip_across_multiple_stripe_payments",
      ]),
    );
  });

  it("allows deterministic zero-tip multi-row coverage but still surfaces it for review", () => {
    const result = classifyHistoricalAppointmentForPaymentMigration(
      appointment({
        finalTotalCents: 25_000,
        stripePayments: [
          stripe({ id: "one", amountCents: 10_000 }),
          stripe({ id: "two", amountCents: 10_000 }),
        ],
      }),
    );

    expect(result).toMatchObject({
      disposition: "legacy_completion",
      predictedStripeJobCoverageCents: 20_000,
      predictedLegacyJobCents: 5_000,
      migrationWouldMarkNeedsReview: false,
      requiresManualReview: true,
    });
    expect(result.issues).toContain(
      "multiple_successful_stripe_payments",
    );
  });

  it("flags tips outside the matched Stripe amount", () => {
    const result = classifyHistoricalAppointmentForPaymentMigration(
      appointment({
        cardTipCents: 10_001,
        stripePayments: [stripe({ amountCents: 10_000 })],
      }),
    );
    expect(result.disposition).toBe("needs_review");
    expect(result.issues).toContain(
      "card_tip_outside_single_stripe_payment",
    );
  });

  it("keeps missing and negative final totals out of legacy prediction", () => {
    expect(
      classifyHistoricalAppointmentForPaymentMigration(
        appointment({ finalTotalCents: null }),
      ).disposition,
    ).toBe("ineligible_missing_final_total");
    expect(
      classifyHistoricalAppointmentForPaymentMigration(
        appointment({ finalTotalCents: -1 }),
      ).disposition,
    ).toBe("ineligible_negative_final_total");
  });

  it("summarizes migration effects and review categories", () => {
    const result = summarizeHistoricalPaymentMigrationAudit([
      appointment({ id: "legacy" }),
      appointment({
        id: "stripe",
        cardTipCents: 1_000,
        stripePayments: [stripe({ amountCents: 11_000 })],
      }),
      appointment({
        id: "ambiguous",
        finalTotalCents: 20_000,
        cardTipCents: 500,
        stripePayments: [
          stripe({ id: "a", amountCents: 10_000 }),
          stripe({ id: "b", amountCents: 10_000 }),
        ],
      }),
    ]);

    expect(result.summary).toMatchObject({
      completedAppointments: 3,
      eligibleCompletedAppointments: 3,
      appointmentsWithSuccessfulStripe: 2,
      matchedSuccessfulStripePayments: 3,
      matchedSuccessfulStripeGrossCents: 31_000,
      predictedStripeJobCoverageCents: 10_000,
      predictedLegacyCompletionRows: 1,
      predictedLegacyJobCents: 10_000,
      predictedMigrationNeedsReviewAppointments: 1,
      manualReviewAppointments: 1,
      conflictingTipAppointments: 1,
      multipleSuccessfulStripeAppointments: 1,
    });
  });
});
