import { and, eq, inArray, ne } from "drizzle-orm";
import {
  appointments,
  type DatabaseClient,
  paymentRefunds,
  payments,
} from "@/db";
import { syncAppointmentCardTipCents } from "@/lib/payment-ledger";

export type LegacyStripeResolutionError =
  | "payment_not_found"
  | "appointment_not_found"
  | "stripe_payment_required"
  | "stripe_payment_not_in_review"
  | "stripe_payment_not_completed"
  | "stripe_payment_already_attached_elsewhere"
  | "owner_review_note_required"
  | "stripe_allocation_invalid"
  | "stripe_allocation_mismatch"
  | "appointment_final_total_required"
  | "appointment_has_other_payment_review"
  | "stripe_job_amount_exceeds_balance";

export type LegacyStripeResolutionDecision =
  | {
      ok: true;
      jobAmountCents: number;
      tipCents: number;
      netJobAmountCents: number;
    }
  | { ok: false; code: LegacyStripeResolutionError };

function nonnegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function completedLegacyStripeStatus(value: string): boolean {
  return ["succeeded", "paid", "completed"].includes(
    value.trim().toLowerCase(),
  );
}

export function evaluateLegacyStripeResolution(input: {
  provider: string;
  providerStatus: string;
  canonicalStatus: string | null;
  totalAmountCents: number;
  refundedAmountCents: number;
  jobAmountCents: number;
  tipCents: number;
  appointmentFinalTotalCents: number | null;
  otherPaidTowardJobCents: number;
  hasOtherReviewItems: boolean;
  reviewNote: string;
}): LegacyStripeResolutionDecision {
  if (input.provider.trim().toLowerCase() !== "stripe") {
    return { ok: false, code: "stripe_payment_required" };
  }
  if (input.canonicalStatus !== "needs_review") {
    return { ok: false, code: "stripe_payment_not_in_review" };
  }
  if (!completedLegacyStripeStatus(input.providerStatus)) {
    return { ok: false, code: "stripe_payment_not_completed" };
  }
  if (!input.reviewNote.trim()) {
    return { ok: false, code: "owner_review_note_required" };
  }
  if (
    !nonnegativeInteger(input.totalAmountCents) ||
    !nonnegativeInteger(input.refundedAmountCents) ||
    !nonnegativeInteger(input.jobAmountCents) ||
    !nonnegativeInteger(input.tipCents) ||
    !nonnegativeInteger(input.otherPaidTowardJobCents)
  ) {
    return { ok: false, code: "stripe_allocation_invalid" };
  }
  if (input.jobAmountCents + input.tipCents !== input.totalAmountCents) {
    return { ok: false, code: "stripe_allocation_mismatch" };
  }
  if (
    input.appointmentFinalTotalCents == null ||
    !nonnegativeInteger(input.appointmentFinalTotalCents)
  ) {
    return { ok: false, code: "appointment_final_total_required" };
  }
  if (input.hasOtherReviewItems) {
    return {
      ok: false,
      code: "appointment_has_other_payment_review",
    };
  }

  const refundedFromJobCents = Math.min(
    input.refundedAmountCents,
    input.jobAmountCents,
  );
  const netJobAmountCents = Math.max(
    input.jobAmountCents - refundedFromJobCents,
    0,
  );
  if (
    input.otherPaidTowardJobCents + netJobAmountCents >
    input.appointmentFinalTotalCents
  ) {
    return {
      ok: false,
      code: "stripe_job_amount_exceeds_balance",
    };
  }

  return {
    ok: true,
    jobAmountCents: input.jobAmountCents,
    tipCents: input.tipCents,
    netJobAmountCents,
  };
}

function financiallyCompletedPayment(row: {
  canonicalStatus: string | null;
  providerStatus: string | null;
  status: string;
}): boolean {
  if (row.canonicalStatus === "completed") return true;
  if (row.canonicalStatus === "needs_review") return false;
  return completedLegacyStripeStatus(row.providerStatus ?? row.status);
}

function resolvedJobAmount(row: {
  amount: number;
  jobAmountCents: number | null;
  tipCents: number;
}): number {
  return Math.max(
    row.jobAmountCents ?? row.amount - Math.max(row.tipCents, 0),
    0,
  );
}

export type ResolveLegacyStripePaymentResult =
  | {
      ok: true;
      paymentId: string;
      appointmentId: string;
      previousAppointmentId: string | null;
      previousCanonicalStatus: string | null;
      jobAmountCents: number;
      tipCents: number;
      netJobAmountCents: number;
    }
  | { ok: false; code: LegacyStripeResolutionError };

export async function resolveLegacyStripePayment(input: {
  db: DatabaseClient;
  paymentId: string;
  appointmentId: string;
  jobAmountCents: number;
  tipCents: number;
  reviewNote: string;
  actorId: string | null;
  actorLabel: string | null;
  now?: Date;
}): Promise<ResolveLegacyStripePaymentResult> {
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    const [appointment] = await tx
      .select({
        id: appointments.id,
        finalTotalCents: appointments.finalTotalCents,
      })
      .from(appointments)
      .where(eq(appointments.id, input.appointmentId))
      .limit(1)
      .for("update");
    if (!appointment) {
      return { ok: false, code: "appointment_not_found" as const };
    }

    const [payment] = await tx
      .select({
        id: payments.id,
        provider: payments.provider,
        appointmentId: payments.appointmentId,
        amount: payments.amount,
        totalAmountCents: payments.totalAmountCents,
        refundedAmountCents: payments.refundedAmountCents,
        status: payments.status,
        canonicalStatus: payments.canonicalStatus,
        providerStatus: payments.providerStatus,
        metadata: payments.metadata,
      })
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1)
      .for("update");
    if (!payment) return { ok: false, code: "payment_not_found" as const };
    if (payment.appointmentId && payment.appointmentId !== appointment.id) {
      return {
        ok: false,
        code: "stripe_payment_already_attached_elsewhere" as const,
      };
    }

    const otherPayments = await tx
      .select({
        id: payments.id,
        amount: payments.amount,
        jobAmountCents: payments.jobAmountCents,
        tipCents: payments.tipCents,
        refundedAmountCents: payments.refundedAmountCents,
        status: payments.status,
        canonicalStatus: payments.canonicalStatus,
        providerStatus: payments.providerStatus,
      })
      .from(payments)
      .where(
        and(
          eq(payments.appointmentId, input.appointmentId),
          ne(payments.id, payment.id),
        ),
      );

    const reviewablePaymentIds = [
      payment.id,
      ...otherPayments.map((row) => row.id),
    ];
    const reviewRefunds =
      reviewablePaymentIds.length === 0
        ? []
        : await tx
            .select({ id: paymentRefunds.id })
            .from(paymentRefunds)
            .where(
              and(
                inArray(paymentRefunds.paymentId, reviewablePaymentIds),
                eq(paymentRefunds.canonicalStatus, "needs_review"),
              ),
            )
            .limit(1);
    const hasOtherReviewItems =
      reviewRefunds.length > 0 ||
      otherPayments.some((row) => row.canonicalStatus === "needs_review");
    const otherPaidTowardJobCents = otherPayments.reduce((total, row) => {
      if (!financiallyCompletedPayment(row)) return total;
      const jobAmountCents = resolvedJobAmount(row);
      const refundedFromJobCents = Math.min(
        Math.max(row.refundedAmountCents, 0),
        jobAmountCents,
      );
      return total + Math.max(jobAmountCents - refundedFromJobCents, 0);
    }, 0);
    const totalAmountCents = Math.max(
      payment.totalAmountCents ?? payment.amount,
      0,
    );
    const decision = evaluateLegacyStripeResolution({
      provider: payment.provider,
      providerStatus: payment.providerStatus ?? payment.status,
      canonicalStatus: payment.canonicalStatus,
      totalAmountCents,
      refundedAmountCents: Math.max(payment.refundedAmountCents, 0),
      jobAmountCents: input.jobAmountCents,
      tipCents: input.tipCents,
      appointmentFinalTotalCents: appointment.finalTotalCents,
      otherPaidTowardJobCents,
      hasOtherReviewItems,
      reviewNote: input.reviewNote,
    });
    if (!decision.ok) return decision;

    await tx
      .update(payments)
      .set({
        appointmentId: appointment.id,
        jobAmountCents: decision.jobAmountCents,
        tipCents: decision.tipCents,
        totalAmountCents,
        canonicalStatus: "completed",
        metadata: {
          ...(payment.metadata ?? {}),
          ownerReconciliation: {
            resolvedAt: now.toISOString(),
            resolvedBy: input.actorId ?? input.actorLabel ?? "owner",
            reviewNote: input.reviewNote.trim(),
            previousAppointmentId: payment.appointmentId,
            previousCanonicalStatus: payment.canonicalStatus,
            jobAmountCents: decision.jobAmountCents,
            tipCents: decision.tipCents,
          },
        },
        updatedAt: now,
      })
      .where(eq(payments.id, payment.id));

    await syncAppointmentCardTipCents(tx, appointment.id);

    return {
      ok: true,
      paymentId: payment.id,
      appointmentId: appointment.id,
      previousAppointmentId: payment.appointmentId,
      previousCanonicalStatus: payment.canonicalStatus,
      jobAmountCents: decision.jobAmountCents,
      tipCents: decision.tipCents,
      netJobAmountCents: decision.netJobAmountCents,
    };
  });
}
