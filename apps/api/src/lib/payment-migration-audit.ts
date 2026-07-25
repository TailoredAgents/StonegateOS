export const HISTORICAL_SUCCESSFUL_PAYMENT_STATUSES = new Set([
  "succeeded",
  "paid",
  "completed",
]);

export type HistoricalStripePaymentForAudit = {
  id: string;
  stripeChargeId: string | null;
  amountCents: number;
  status: string;
};

export type HistoricalAppointmentForAudit = {
  id: string;
  finalTotalCents: number | null;
  cardTipCents: number | null;
  stripePayments: HistoricalStripePaymentForAudit[];
};

export type PaymentMigrationAuditIssue =
  | "missing_final_total"
  | "negative_final_total"
  | "negative_card_tip"
  | "successful_stripe_amount_not_positive"
  | "multiple_successful_stripe_payments"
  | "conflicting_tip_across_multiple_stripe_payments"
  | "card_tip_outside_single_stripe_payment"
  | "stripe_job_amount_over_final_total";

export type HistoricalAppointmentMigrationAudit = {
  appointmentId: string;
  disposition:
    | "ineligible_missing_final_total"
    | "ineligible_negative_final_total"
    | "covered_by_stripe"
    | "legacy_completion"
    | "needs_review";
  finalTotalCents: number | null;
  cardTipCents: number;
  successfulStripePaymentCount: number;
  successfulStripeGrossCents: number;
  predictedStripeJobCoverageCents: number;
  predictedLegacyJobCents: number;
  predictedLegacyTipCents: number;
  migrationWouldMarkNeedsReview: boolean;
  requiresManualReview: boolean;
  issues: PaymentMigrationAuditIssue[];
};

export type HistoricalPaymentMigrationAuditSummary = {
  completedAppointments: number;
  eligibleCompletedAppointments: number;
  missingFinalTotalAppointments: number;
  negativeFinalTotalAppointments: number;
  appointmentsWithSuccessfulStripe: number;
  matchedSuccessfulStripePayments: number;
  matchedSuccessfulStripeGrossCents: number;
  predictedStripeJobCoverageCents: number;
  predictedLegacyCompletionRows: number;
  predictedLegacyJobCents: number;
  predictedLegacyTipCents: number;
  predictedMigrationNeedsReviewAppointments: number;
  manualReviewAppointments: number;
  overpaymentAppointments: number;
  conflictingTipAppointments: number;
  multipleSuccessfulStripeAppointments: number;
  invalidSuccessfulStripeAmountAppointments: number;
};

function normalizedStatus(value: string): string {
  return value.trim().toLowerCase();
}

function isSuccessfulStripePayment(
  payment: HistoricalStripePaymentForAudit,
): boolean {
  return HISTORICAL_SUCCESSFUL_PAYMENT_STATUSES.has(
    normalizedStatus(payment.status),
  );
}

function addIssue(
  issues: PaymentMigrationAuditIssue[],
  issue: PaymentMigrationAuditIssue,
): void {
  if (!issues.includes(issue)) issues.push(issue);
}

/**
 * Mirrors the historical classification performed by migration 0059 without
 * mutating any rows. Additional data-quality issues are retained separately so
 * a release lead can stop for review even where the SQL migration has a
 * deterministic fallback.
 */
export function classifyHistoricalAppointmentForPaymentMigration(
  appointment: HistoricalAppointmentForAudit,
): HistoricalAppointmentMigrationAudit {
  const issues: PaymentMigrationAuditIssue[] = [];
  const cardTipCents = appointment.cardTipCents ?? 0;
  const successful = appointment.stripePayments.filter(
    isSuccessfulStripePayment,
  );
  const successfulStripeGrossCents = successful.reduce(
    (sum, payment) => sum + payment.amountCents,
    0,
  );

  if (appointment.finalTotalCents == null) {
    addIssue(issues, "missing_final_total");
  } else if (appointment.finalTotalCents < 0) {
    addIssue(issues, "negative_final_total");
  }
  if (cardTipCents < 0) addIssue(issues, "negative_card_tip");
  if (successful.some((payment) => payment.amountCents <= 0)) {
    addIssue(issues, "successful_stripe_amount_not_positive");
  }
  if (successful.length > 1) {
    addIssue(issues, "multiple_successful_stripe_payments");
  }

  const tipOutsideStripePayment =
    successful.length > 0 &&
    (cardTipCents < 0 ||
      successful.some((payment) => cardTipCents > payment.amountCents));
  if (tipOutsideStripePayment) {
    addIssue(issues, "card_tip_outside_single_stripe_payment");
  }
  const conflictingTip =
    successful.length > 1 && cardTipCents > 0;
  if (conflictingTip) {
    addIssue(issues, "conflicting_tip_across_multiple_stripe_payments");
  }

  let migrationWouldMarkNeedsReview =
    tipOutsideStripePayment || conflictingTip;
  let predictedStripeJobCoverageCents = 0;
  if (!migrationWouldMarkNeedsReview) {
    if (successful.length === 1) {
      predictedStripeJobCoverageCents =
        successful[0]!.amountCents - cardTipCents;
    } else if (successful.length > 1 && cardTipCents === 0) {
      predictedStripeJobCoverageCents = successfulStripeGrossCents;
    }
  }

  if (
    appointment.finalTotalCents != null &&
    appointment.finalTotalCents >= 0 &&
    predictedStripeJobCoverageCents > appointment.finalTotalCents
  ) {
    addIssue(issues, "stripe_job_amount_over_final_total");
    migrationWouldMarkNeedsReview = true;
    // The migration changes these Stripe rows to needs_review before it
    // calculates legacy completion coverage.
    predictedStripeJobCoverageCents = 0;
  }

  let disposition: HistoricalAppointmentMigrationAudit["disposition"];
  let predictedLegacyJobCents = 0;
  let predictedLegacyTipCents = 0;
  if (appointment.finalTotalCents == null) {
    disposition = "ineligible_missing_final_total";
  } else if (appointment.finalTotalCents < 0) {
    disposition = "ineligible_negative_final_total";
  } else if (migrationWouldMarkNeedsReview) {
    disposition = "needs_review";
  } else {
    const uncoveredCents =
      appointment.finalTotalCents - predictedStripeJobCoverageCents;
    if (uncoveredCents > 0) {
      disposition = "legacy_completion";
      predictedLegacyJobCents = uncoveredCents;
      predictedLegacyTipCents =
        successful.length === 0 && cardTipCents > 0 ? cardTipCents : 0;
    } else {
      disposition = "covered_by_stripe";
    }
  }

  return {
    appointmentId: appointment.id,
    disposition,
    finalTotalCents: appointment.finalTotalCents,
    cardTipCents,
    successfulStripePaymentCount: successful.length,
    successfulStripeGrossCents,
    predictedStripeJobCoverageCents,
    predictedLegacyJobCents,
    predictedLegacyTipCents,
    migrationWouldMarkNeedsReview,
    requiresManualReview: issues.length > 0,
    issues,
  };
}

export function summarizeHistoricalPaymentMigrationAudit(
  appointments: HistoricalAppointmentForAudit[],
): {
  appointments: HistoricalAppointmentMigrationAudit[];
  summary: HistoricalPaymentMigrationAuditSummary;
} {
  const classified = appointments.map(
    classifyHistoricalAppointmentForPaymentMigration,
  );
  const hasIssue = (
    row: HistoricalAppointmentMigrationAudit,
    issue: PaymentMigrationAuditIssue,
  ) => row.issues.includes(issue);
  const sum = (
    selector: (row: HistoricalAppointmentMigrationAudit) => number,
  ) => classified.reduce((total, row) => total + selector(row), 0);

  return {
    appointments: classified,
    summary: {
      completedAppointments: classified.length,
      eligibleCompletedAppointments: classified.filter(
        (row) =>
          row.finalTotalCents != null && row.finalTotalCents >= 0,
      ).length,
      missingFinalTotalAppointments: classified.filter((row) =>
        hasIssue(row, "missing_final_total"),
      ).length,
      negativeFinalTotalAppointments: classified.filter((row) =>
        hasIssue(row, "negative_final_total"),
      ).length,
      appointmentsWithSuccessfulStripe: classified.filter(
        (row) => row.successfulStripePaymentCount > 0,
      ).length,
      matchedSuccessfulStripePayments: sum(
        (row) => row.successfulStripePaymentCount,
      ),
      matchedSuccessfulStripeGrossCents: sum(
        (row) => row.successfulStripeGrossCents,
      ),
      predictedStripeJobCoverageCents: sum(
        (row) => row.predictedStripeJobCoverageCents,
      ),
      predictedLegacyCompletionRows: classified.filter(
        (row) => row.disposition === "legacy_completion",
      ).length,
      predictedLegacyJobCents: sum(
        (row) => row.predictedLegacyJobCents,
      ),
      predictedLegacyTipCents: sum(
        (row) => row.predictedLegacyTipCents,
      ),
      predictedMigrationNeedsReviewAppointments: classified.filter(
        (row) => row.migrationWouldMarkNeedsReview,
      ).length,
      manualReviewAppointments: classified.filter(
        (row) => row.requiresManualReview,
      ).length,
      overpaymentAppointments: classified.filter((row) =>
        hasIssue(row, "stripe_job_amount_over_final_total"),
      ).length,
      conflictingTipAppointments: classified.filter(
        (row) =>
          hasIssue(
            row,
            "conflicting_tip_across_multiple_stripe_payments",
          ) ||
          hasIssue(row, "card_tip_outside_single_stripe_payment") ||
          hasIssue(row, "negative_card_tip"),
      ).length,
      multipleSuccessfulStripeAppointments: classified.filter((row) =>
        hasIssue(row, "multiple_successful_stripe_payments"),
      ).length,
      invalidSuccessfulStripeAmountAppointments: classified.filter(
        (row) =>
          hasIssue(row, "successful_stripe_amount_not_positive"),
      ).length,
    },
  };
}
