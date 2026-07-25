import crypto from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import {
  getDb,
  paymentAttempts,
  paymentProviderEvents,
  paymentRefunds,
  payments,
} from "@/db";
import {
  getSquareOrder,
  getSquarePayment,
  getSquareRefund,
  listSquarePayments,
  listSquareRefunds,
  parseSquareMoneyAmount,
  retrieveAndVerifySquarePayment,
  SquareApiError,
  type SquareRefund,
  type VerifiedSquarePayment,
  type SquarePayment,
} from "@/lib/square-client";
import { allocateRefund } from "@/lib/payment-summary";
import { extractSquareAttemptIdFromOrder } from "@/lib/square-pos";
import {
  expireStalePaymentAttempts,
  syncAppointmentCardTipCents,
} from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/provider-health";

export type SquareAttemptReconciliationResult =
  | {
      status: "verified";
      appointmentId: string;
      attemptId: string;
      paymentId: string;
      providerPaymentId: string;
    }
  | {
      status: "pending_verification" | "needs_review";
      appointmentId: string;
      attemptId: string;
      errorCode: string;
      paymentId?: string;
    };

export function squareProviderReferenceConflicts(input: {
  storedOrderId?: string | null;
  storedPaymentId?: string | null;
  incomingOrderId?: string | null;
  incomingPaymentId?: string | null;
}): boolean {
  const storedOrderId = input.storedOrderId?.trim() || null;
  const storedPaymentId = input.storedPaymentId?.trim() || null;
  const incomingOrderId = input.incomingOrderId?.trim() || null;
  const incomingPaymentId = input.incomingPaymentId?.trim() || null;
  return Boolean(
    (storedOrderId && incomingOrderId && storedOrderId !== incomingOrderId) ||
      (storedPaymentId &&
        incomingPaymentId &&
        storedPaymentId !== incomingPaymentId),
  );
}

export function canSkipFinalSquareProviderRecord(input: {
  canonicalStatus?: string | null;
  localProviderStatus?: string | null;
  incomingProviderStatus?: string | null;
}): boolean {
  const canonicalStatus = input.canonicalStatus?.trim().toLowerCase() ?? "";
  const localProviderStatus =
    input.localProviderStatus?.trim().toUpperCase() ?? "";
  const incomingProviderStatus =
    input.incomingProviderStatus?.trim().toUpperCase() ?? "";
  return (
    ["completed", "needs_review", "failed", "canceled"].includes(
      canonicalStatus,
    ) &&
    localProviderStatus.length > 0 &&
    localProviderStatus === incomingProviderStatus
  );
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 200);
  }
  return "square_verification_failed";
}

function databaseErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record["code"] === "string") return record["code"];
  const cause = record["cause"];
  if (cause && typeof cause === "object") {
    const code = (cause as Record<string, unknown>)["code"];
    return typeof code === "string" ? code : null;
  }
  return null;
}

export function isRetryableSquareError(error: unknown): boolean {
  if (error instanceof SquareApiError) {
    return (
      error.status === 404 ||
      error.status === 408 ||
      error.status === 409 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return error instanceof TypeError || errorCode(error) === "fetch failed";
}

function canonicalRefundStatus(providerStatus: string | undefined): string {
  switch (providerStatus?.trim().toUpperCase()) {
    case "COMPLETED":
      return "completed";
    case "PENDING":
      return "pending";
    case "FAILED":
    case "REJECTED":
      return "failed";
    default:
      return "needs_review";
  }
}

function dateOrNull(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeSquarePaymentForReview(payment: SquarePayment) {
  const jobAmountCents = parseSquareMoneyAmount(payment.amount_money);
  const tipCents = parseSquareMoneyAmount(payment.tip_money) ?? 0;
  const totalAmountCents = parseSquareMoneyAmount(payment.total_money);
  const refundedAmountCents =
    parseSquareMoneyAmount(payment.refunded_money) ?? 0;
  const currency =
    payment.amount_money?.currency?.toUpperCase() ??
    payment.total_money?.currency?.toUpperCase();
  if (
    !payment.id ||
    jobAmountCents == null ||
    jobAmountCents <= 0 ||
    tipCents < 0 ||
    totalAmountCents == null ||
    totalAmountCents <= 0 ||
    totalAmountCents !== jobAmountCents + tipCents ||
    refundedAmountCents < 0 ||
    refundedAmountCents > totalAmountCents ||
    currency !== "USD"
  ) {
    throw new Error("square_payment_payload_invalid");
  }
  return {
    providerPaymentId: payment.id,
    providerOrderId: payment.order_id ?? null,
    providerStatus: payment.status ?? "UNKNOWN",
    jobAmountCents,
    tipCents,
    totalAmountCents,
    refundedAmountCents,
    currency: "USD",
    tenderType: payment.source_type?.trim().toLowerCase() ?? "unknown",
    entryMethod: payment.card_details?.entry_method ?? null,
    cardBrand: payment.card_details?.card?.card_brand ?? null,
    last4: payment.card_details?.card?.last_4 ?? null,
    receiptUrl: payment.receipt_url ?? null,
    locationId: payment.location_id ?? null,
    providerCreatedAt: dateOrNull(payment.created_at),
    providerUpdatedAt: dateOrNull(payment.updated_at),
  };
}

async function safelyRecordSquareHealth(
  outcome: "success" | "failure",
  detail?: string,
): Promise<void> {
  try {
    if (outcome === "success") {
      await recordProviderSuccess("square");
    } else {
      await recordProviderFailure("square", detail?.slice(0, 500) ?? null);
    }
  } catch (error) {
    console.warn("[square] provider health update failed", {
      error: String(error),
    });
  }
}

export async function reconcileSquareAttempt(input: {
  attemptId: string;
  orderId?: string | null;
}): Promise<SquareAttemptReconciliationResult> {
  const db = getDb();
  const [attempt] = await db
    .select({
      id: paymentAttempts.id,
      appointmentId: paymentAttempts.appointmentId,
      status: paymentAttempts.status,
      requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
      currency: paymentAttempts.currency,
      providerOrderId: paymentAttempts.providerOrderId,
      squareLocationId: paymentAttempts.squareLocationId,
      initiatedByMemberId: paymentAttempts.initiatedByMemberId,
    })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.id, input.attemptId),
        eq(paymentAttempts.provider, "square"),
      ),
    )
    .limit(1);
  if (!attempt) throw new Error("payment_attempt_not_found");

  if (attempt.status === "completed") {
    const [existing] = await db
      .select({
        id: payments.id,
        providerPaymentId: payments.providerPaymentId,
        providerOrderId: payments.providerOrderId,
      })
      .from(payments)
      .where(eq(payments.paymentAttemptId, attempt.id))
      .limit(1);
    if (existing?.providerPaymentId) {
      const incomingOrderId = input.orderId?.trim() || null;
      if (
        squareProviderReferenceConflicts({
          storedOrderId: existing.providerOrderId ?? attempt.providerOrderId,
          storedPaymentId: existing.providerPaymentId,
          incomingOrderId,
        })
      ) {
        try {
          const expectedLocationId =
            attempt.squareLocationId?.trim() ??
            process.env["SQUARE_LOCATION_ID"]?.trim();
          if (!expectedLocationId) {
            throw new Error("SQUARE_LOCATION_ID is not set");
          }
          const verifiedAdditional = await retrieveAndVerifySquarePayment({
            orderId: incomingOrderId!,
            expectedAttemptId: attempt.id,
            expectedJobAmountCents: attempt.requestedJobAmountCents,
            expectedLocationId,
          });
          const reviewPaymentId = await upsertSquarePaymentForReview(
            verifiedAdditional.rawPayment,
            {
              reconciliation: "additional_payment_for_completed_attempt",
              suspectedAttemptId: attempt.id,
              storedProviderOrderId:
                existing.providerOrderId ?? attempt.providerOrderId,
            },
          );
          await safelyRecordSquareHealth(
            "failure",
            "square_additional_payment_for_completed_attempt",
          );
          return {
            status: "needs_review",
            appointmentId: attempt.appointmentId,
            attemptId: attempt.id,
            paymentId: reviewPaymentId,
            errorCode: "square_additional_payment_for_completed_attempt",
          };
        } catch (error) {
          const code = errorCode(error);
          await safelyRecordSquareHealth("failure", code);
          return {
            status: "needs_review",
            appointmentId: attempt.appointmentId,
            attemptId: attempt.id,
            errorCode: code,
          };
        }
      }
      return {
        status: "verified",
        appointmentId: attempt.appointmentId,
        attemptId: attempt.id,
        paymentId: existing.id,
        providerPaymentId: existing.providerPaymentId,
      };
    }
  }

  const orderId = input.orderId?.trim() || attempt.providerOrderId?.trim();
  if (!orderId) {
    return {
      status: "pending_verification",
      appointmentId: attempt.appointmentId,
      attemptId: attempt.id,
      errorCode: "square_order_id_missing",
    };
  }
  const expectedLocationId =
    attempt.squareLocationId?.trim() ??
    process.env["SQUARE_LOCATION_ID"]?.trim();
  if (!expectedLocationId) throw new Error("SQUARE_LOCATION_ID is not set");

  let verifiedPayment: VerifiedSquarePayment | null = null;
  try {
    verifiedPayment = await retrieveAndVerifySquarePayment({
      orderId,
      expectedAttemptId: attempt.id,
      expectedJobAmountCents: attempt.requestedJobAmountCents,
      expectedLocationId,
    });
    const verified = verifiedPayment;
    const result = await db.transaction(async (tx) => {
      const [conflict] = await tx
        .select({
          id: payments.id,
          appointmentId: payments.appointmentId,
          paymentAttemptId: payments.paymentAttemptId,
        })
        .from(payments)
        .where(
          and(
            eq(payments.provider, "square"),
            eq(payments.providerPaymentId, verified.providerPaymentId),
          ),
        )
        .limit(1);

      if (
        conflict &&
        ((conflict.appointmentId != null &&
          conflict.appointmentId !== attempt.appointmentId) ||
          (conflict.paymentAttemptId &&
            conflict.paymentAttemptId !== attempt.id))
      ) {
        await tx
          .update(paymentAttempts)
          .set({
            status: "needs_review",
            providerOrderId: orderId,
            providerPaymentId: verified.providerPaymentId,
            errorCode: "square_payment_already_linked",
            errorMessage:
              "Square payment is already linked to a different appointment or attempt.",
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(paymentAttempts.id, attempt.id));
        return null;
      }

      const now = new Date();
      const [payment] = await tx
        .insert(payments)
        .values({
          provider: "square",
          providerPaymentId: verified.providerPaymentId,
          providerOrderId: verified.providerOrderId,
          paymentAttemptId: attempt.id,
          amount: verified.totalAmountCents,
          jobAmountCents: verified.jobAmountCents,
          tipCents: verified.tipCents,
          totalAmountCents: verified.totalAmountCents,
          refundedAmountCents: verified.refundedAmountCents,
          currency: verified.currency,
          status: verified.providerStatus.toLowerCase(),
          canonicalStatus: "completed",
          providerStatus: verified.providerStatus,
          method: "card",
          tenderType: verified.tenderType,
          entryMethod: verified.entryMethod,
          cardBrand: verified.cardBrand,
          last4: verified.last4,
          receiptUrl: verified.receiptUrl,
          squareLocationId: verified.locationId,
          initiatedByMemberId: attempt.initiatedByMemberId,
          appointmentId: attempt.appointmentId,
          metadata: {
            reconciliation: "verified_from_square",
            apiVersion: "2026-07-15",
          },
          providerCreatedAt: verified.providerCreatedAt,
          paidAt: verified.providerUpdatedAt ?? now,
          capturedAt: verified.providerUpdatedAt ?? now,
          createdAt: verified.providerCreatedAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [payments.provider, payments.providerPaymentId],
          set: {
            providerOrderId: verified.providerOrderId,
            paymentAttemptId: attempt.id,
            amount: verified.totalAmountCents,
            jobAmountCents: verified.jobAmountCents,
            tipCents: verified.tipCents,
            totalAmountCents: verified.totalAmountCents,
            refundedAmountCents: verified.refundedAmountCents,
            status: verified.providerStatus.toLowerCase(),
            canonicalStatus: "completed",
            providerStatus: verified.providerStatus,
            method: "card",
            tenderType: verified.tenderType,
            entryMethod: verified.entryMethod,
            cardBrand: verified.cardBrand,
            last4: verified.last4,
            receiptUrl: verified.receiptUrl,
            squareLocationId: verified.locationId,
            appointmentId: attempt.appointmentId,
            paidAt: verified.providerUpdatedAt ?? now,
            capturedAt: verified.providerUpdatedAt ?? now,
            updatedAt: now,
          },
        })
        .returning({ id: payments.id });
      if (!payment) throw new Error("square_payment_upsert_failed");

      await tx
        .update(paymentAttempts)
        .set({
          status: "completed",
          providerOrderId: verified.providerOrderId,
          providerPaymentId: verified.providerPaymentId,
          squareLocationId: verified.locationId,
          resolvedAt: now,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(paymentAttempts.id, attempt.id));

      await syncAppointmentCardTipCents(tx, attempt.appointmentId);
      return payment;
    });

    if (!result) {
      await safelyRecordSquareHealth(
        "failure",
        "square_payment_already_linked",
      );
      return {
        status: "needs_review",
        appointmentId: attempt.appointmentId,
        attemptId: attempt.id,
        errorCode: "square_payment_already_linked",
      };
    }
    await safelyRecordSquareHealth("success");
    return {
      status: "verified",
      appointmentId: attempt.appointmentId,
      attemptId: attempt.id,
      paymentId: result.id,
      providerPaymentId: verified.providerPaymentId,
    };
  } catch (error) {
    if (verifiedPayment && databaseErrorCode(error) === "23505") {
      const [linkedPayment] = await db
        .select({
          id: payments.id,
          providerOrderId: payments.providerOrderId,
          providerPaymentId: payments.providerPaymentId,
        })
        .from(payments)
        .where(eq(payments.paymentAttemptId, attempt.id))
        .limit(1);
      if (
        linkedPayment?.providerPaymentId ===
          verifiedPayment.providerPaymentId &&
        linkedPayment.providerOrderId === verifiedPayment.providerOrderId
      ) {
        return {
          status: "verified",
          appointmentId: attempt.appointmentId,
          attemptId: attempt.id,
          paymentId: linkedPayment.id,
          providerPaymentId: linkedPayment.providerPaymentId,
        };
      }
      const reviewPaymentId = await upsertSquarePaymentForReview(
        verifiedPayment.rawPayment,
        {
          reconciliation: "concurrent_additional_payment_for_attempt",
          suspectedAttemptId: attempt.id,
          storedProviderOrderId: linkedPayment?.providerOrderId ?? null,
          storedProviderPaymentId: linkedPayment?.providerPaymentId ?? null,
        },
      );
      await safelyRecordSquareHealth(
        "failure",
        "square_additional_payment_for_completed_attempt",
      );
      return {
        status: "needs_review",
        appointmentId: attempt.appointmentId,
        attemptId: attempt.id,
        paymentId: reviewPaymentId,
        errorCode: "square_additional_payment_for_completed_attempt",
      };
    }
    const code = errorCode(error);
    const pending = isRetryableSquareError(error);
    await db
      .update(paymentAttempts)
      .set({
        status: pending ? "pending_verification" : "needs_review",
        providerOrderId: orderId,
        errorCode: code,
        errorMessage: code,
        ...(pending ? {} : { resolvedAt: new Date() }),
        updatedAt: new Date(),
      })
      .where(eq(paymentAttempts.id, attempt.id));
    await safelyRecordSquareHealth("failure", code);
    return {
      status: pending ? "pending_verification" : "needs_review",
      appointmentId: attempt.appointmentId,
      attemptId: attempt.id,
      errorCode: code,
    };
  }
}

async function upsertSquarePaymentForReview(
  payment: SquarePayment,
  metadata?: Record<string, unknown>,
): Promise<string> {
  const normalized = normalizeSquarePaymentForReview(payment);
  const now = new Date();
  const db = getDb();
  const [row] = await db
    .insert(payments)
    .values({
      provider: "square",
      providerPaymentId: normalized.providerPaymentId,
      providerOrderId: normalized.providerOrderId,
      amount: normalized.totalAmountCents,
      jobAmountCents: normalized.jobAmountCents,
      tipCents: normalized.tipCents,
      totalAmountCents: normalized.totalAmountCents,
      refundedAmountCents: normalized.refundedAmountCents,
      currency: normalized.currency,
      status: normalized.providerStatus.toLowerCase(),
      canonicalStatus: "needs_review",
      providerStatus: normalized.providerStatus,
      method: normalized.tenderType,
      tenderType: normalized.tenderType,
      entryMethod: normalized.entryMethod,
      cardBrand: normalized.cardBrand,
      last4: normalized.last4,
      receiptUrl: normalized.receiptUrl,
      squareLocationId: normalized.locationId,
      metadata: {
        reconciliation: "unmatched_square_webhook",
        ...(metadata ?? {}),
      },
      providerCreatedAt: normalized.providerCreatedAt,
      paidAt:
        normalized.providerStatus.toUpperCase() === "COMPLETED"
          ? (normalized.providerUpdatedAt ?? now)
          : null,
      createdAt: normalized.providerCreatedAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [payments.provider, payments.providerPaymentId],
      set: {
        providerOrderId: normalized.providerOrderId,
        amount: normalized.totalAmountCents,
        jobAmountCents: normalized.jobAmountCents,
        tipCents: normalized.tipCents,
        totalAmountCents: normalized.totalAmountCents,
        refundedAmountCents: normalized.refundedAmountCents,
        status: normalized.providerStatus.toLowerCase(),
        providerStatus: normalized.providerStatus,
        updatedAt: now,
      },
    })
    .returning({ id: payments.id });
  if (!row) throw new Error("square_unmatched_payment_upsert_failed");
  return row.id;
}

export async function upsertUnmatchedSquarePayment(
  providerPaymentId: string,
): Promise<string> {
  const payment = await getSquarePayment(providerPaymentId);
  return upsertSquarePaymentForReview(payment);
}

async function resolveAttemptForSquarePayment(
  payment: SquarePayment,
): Promise<string | null> {
  const db = getDb();
  if (payment.id) {
    const [byPayment] = await db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, "square"),
          eq(paymentAttempts.providerPaymentId, payment.id),
        ),
      )
      .limit(1);
    if (byPayment) return byPayment.id;
  }
  const noteAttemptId = extractSquareAttemptIdFromOrder(payment);
  if (noteAttemptId) {
    const [byExactNote] = await db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.id, noteAttemptId),
          eq(paymentAttempts.provider, "square"),
        ),
      )
      .limit(1);
    if (byExactNote) return byExactNote.id;
  }
  if (!payment.order_id) return null;
  const [byOrder] = await db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, "square"),
        eq(paymentAttempts.providerOrderId, payment.order_id),
      ),
    )
    .limit(1);
  if (byOrder) return byOrder.id;

  const order = await getSquareOrder(payment.order_id);
  const extractedAttemptId = extractSquareAttemptIdFromOrder(order);
  if (!extractedAttemptId) return null;
  const [exactAttempt] = await db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.id, extractedAttemptId),
        eq(paymentAttempts.provider, "square"),
      ),
    )
    .limit(1);
  return exactAttempt?.id ?? null;
}

async function reconcileSquarePayment(payment: SquarePayment): Promise<{
  paymentId: string | null;
  paymentAttemptId: string | null;
  status: "processed" | "needs_review";
}> {
  const providerPaymentId = payment.id?.trim();
  if (!providerPaymentId) {
    throw new Error("square_payment_id_missing");
  }
  const attemptId = await resolveAttemptForSquarePayment(payment);
  if (!attemptId || !payment.order_id) {
    const paymentId = await upsertSquarePaymentForReview(payment, {
      reconciliation: "unmatched_square_reconciliation",
    });
    return { paymentId, paymentAttemptId: null, status: "needs_review" };
  }
  const db = getDb();
  const [completedAttempt] = await db
    .select({
      status: paymentAttempts.status,
      providerOrderId: paymentAttempts.providerOrderId,
      providerPaymentId: paymentAttempts.providerPaymentId,
    })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId))
    .limit(1);
  if (completedAttempt?.status === "completed") {
    const [linkedPayment] = await db
      .select({
        providerOrderId: payments.providerOrderId,
        providerPaymentId: payments.providerPaymentId,
      })
      .from(payments)
      .where(eq(payments.paymentAttemptId, attemptId))
      .limit(1);
    if (
      squareProviderReferenceConflicts({
        storedOrderId:
          linkedPayment?.providerOrderId ?? completedAttempt.providerOrderId,
        storedPaymentId:
          linkedPayment?.providerPaymentId ??
          completedAttempt.providerPaymentId,
        incomingOrderId: payment.order_id,
        incomingPaymentId: payment.id,
      })
    ) {
      const reviewPaymentId = await upsertSquarePaymentForReview(payment, {
        reconciliation: "additional_payment_for_completed_attempt",
        suspectedAttemptId: attemptId,
        storedProviderOrderId:
          linkedPayment?.providerOrderId ?? completedAttempt.providerOrderId,
        storedProviderPaymentId:
          linkedPayment?.providerPaymentId ??
          completedAttempt.providerPaymentId,
      });
      await safelyRecordSquareHealth(
        "failure",
        "square_additional_payment_for_completed_attempt",
      );
      return {
        paymentId: reviewPaymentId,
        paymentAttemptId: attemptId,
        status: "needs_review",
      };
    }
  }
  const reconciled = await reconcileSquareAttempt({
    attemptId,
    orderId: payment.order_id,
  });
  if (reconciled.status === "verified") {
    return {
      paymentId: reconciled.paymentId,
      paymentAttemptId: attemptId,
      status: "processed",
    };
  }
  return {
    paymentId: reconciled.paymentId ?? null,
    paymentAttemptId: attemptId,
    status: "needs_review",
  };
}

export async function reconcileSquarePaymentEvent(
  providerPaymentId: string,
): Promise<{
  paymentId: string | null;
  paymentAttemptId: string | null;
  status: "processed" | "needs_review";
}> {
  const payment = await getSquarePayment(providerPaymentId);
  if (payment.id !== providerPaymentId) {
    throw new Error("square_payment_id_mismatch");
  }
  return reconcileSquarePayment(payment);
}

async function reconcileSquareRefund(refund: SquareRefund): Promise<{
  paymentId: string | null;
  paymentAttemptId: string | null;
  status: "processed" | "needs_review";
}> {
  const providerRefundId = refund.id?.trim();
  if (!providerRefundId) throw new Error("square_refund_id_missing");
  if (!refund.payment_id) throw new Error("square_refund_payment_id_missing");
  const db = getDb();
  let [paymentRow] = await db
    .select({
      id: payments.id,
      appointmentId: payments.appointmentId,
      paymentAttemptId: payments.paymentAttemptId,
      jobAmountCents: payments.jobAmountCents,
      amount: payments.amount,
      tipCents: payments.tipCents,
      totalAmountCents: payments.totalAmountCents,
    })
    .from(payments)
    .where(
      and(
        eq(payments.provider, "square"),
        eq(payments.providerPaymentId, refund.payment_id),
      ),
    )
    .limit(1);
  const squarePayment = await getSquarePayment(refund.payment_id);
  if (squarePayment.id !== refund.payment_id) {
    throw new Error("square_refund_payment_id_mismatch");
  }
  if (!paymentRow) {
    const normalized = normalizeSquarePaymentForReview(squarePayment);
    const unmatchedPaymentId = await upsertSquarePaymentForReview(
      squarePayment,
      {
        reconciliation: "refund_for_unmatched_square_payment",
        providerRefundId,
      },
    );
    paymentRow = {
      id: unmatchedPaymentId,
      appointmentId: null,
      paymentAttemptId: null,
      jobAmountCents: normalized.jobAmountCents,
      amount: normalized.totalAmountCents,
      tipCents: normalized.tipCents,
      totalAmountCents: normalized.totalAmountCents,
    };
  }

  const amountCents = parseSquareMoneyAmount(refund.amount_money);
  const currency = refund.amount_money?.currency?.toUpperCase();
  if (amountCents == null || amountCents <= 0 || currency !== "USD") {
    throw new Error("square_refund_payload_invalid");
  }
  const providerRefundedAmountCents =
    parseSquareMoneyAmount(squarePayment.refunded_money) ?? 0;
  const paymentTotal =
    paymentRow.totalAmountCents ?? Math.max(paymentRow.amount, 0);
  const jobTotal =
    paymentRow.jobAmountCents ??
    Math.max(paymentTotal - Math.max(paymentRow.tipCents, 0), 0);
  const isCompleted = refund.status?.trim().toUpperCase() === "COMPLETED";
  const isPartial = isCompleted && providerRefundedAmountCents < paymentTotal;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .insert(paymentRefunds)
      .values({
        paymentId: paymentRow.id,
        provider: "square",
        providerRefundId,
        amountCents,
        jobAmountCents: 0,
        tipCents: 0,
        currency: "USD",
        canonicalStatus: canonicalRefundStatus(refund.status),
        providerStatus: refund.status ?? "UNKNOWN",
        reason: refund.reason ?? null,
        metadata: {
          providerOrderId: refund.order_id ?? null,
          squareLocationId: refund.location_id ?? null,
          commissionReviewRequired: isCompleted,
        },
        providerCreatedAt: dateOrNull(refund.created_at),
        refundedAt: isCompleted ? (dateOrNull(refund.updated_at) ?? now) : null,
        createdAt: dateOrNull(refund.created_at) ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [paymentRefunds.provider, paymentRefunds.providerRefundId],
        set: {
          amountCents,
          canonicalStatus: canonicalRefundStatus(refund.status),
          providerStatus: refund.status ?? "UNKNOWN",
          reason: refund.reason ?? null,
          refundedAt: isCompleted
            ? (dateOrNull(refund.updated_at) ?? now)
            : null,
          updatedAt: now,
        },
      });

    if (isCompleted) {
      const [storedRefund] = await tx
        .select({
          id: paymentRefunds.id,
          metadata: paymentRefunds.metadata,
        })
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.provider, "square"),
            eq(paymentRefunds.providerRefundId, providerRefundId),
          ),
        )
        .limit(1);
      if (storedRefund) {
        await tx
          .update(paymentRefunds)
          .set({
            metadata: {
              ...(storedRefund.metadata ?? {}),
              providerOrderId: refund.order_id ?? null,
              squareLocationId: refund.location_id ?? null,
              commissionReviewRequired: true,
            },
            updatedAt: now,
          })
          .where(eq(paymentRefunds.id, storedRefund.id));
      }
    }

    const refunds = await tx
      .select({
        id: paymentRefunds.id,
        amountCents: paymentRefunds.amountCents,
        providerStatus: paymentRefunds.providerStatus,
      })
      .from(paymentRefunds)
      .where(eq(paymentRefunds.paymentId, paymentRow.id))
      .orderBy(asc(paymentRefunds.createdAt), asc(paymentRefunds.id));

    let remainingJob = jobTotal;
    let remainingTip = Math.max(paymentRow.tipCents, 0);
    for (const row of refunds) {
      const completed =
        row.providerStatus?.trim().toUpperCase() === "COMPLETED";
      if (!completed) continue;
      const allocation = allocateRefund({
        jobAmountCents: remainingJob,
        tipCents: remainingTip,
        refundedAmountCents: row.amountCents,
      });
      remainingJob -= allocation.refundedJobCents;
      remainingTip -= allocation.refundedTipCents;
      await tx
        .update(paymentRefunds)
        .set({
          jobAmountCents: allocation.refundedJobCents,
          tipCents: allocation.refundedTipCents,
          canonicalStatus:
            providerRefundedAmountCents < paymentTotal
              ? "needs_review"
              : "completed",
          updatedAt: now,
        })
        .where(eq(paymentRefunds.id, row.id));
    }

    await tx
      .update(payments)
      .set({
        refundedAmountCents: providerRefundedAmountCents,
        updatedAt: now,
      })
      .where(eq(payments.id, paymentRow.id));
    if (paymentRow.appointmentId) {
      await syncAppointmentCardTipCents(tx, paymentRow.appointmentId);
    }
  });

  await safelyRecordSquareHealth("success");
  return {
    paymentId: paymentRow.id,
    paymentAttemptId: paymentRow.paymentAttemptId,
    status:
      isPartial || !paymentRow.appointmentId ? "needs_review" : "processed",
  };
}

export async function reconcileSquareRefundEvent(
  providerRefundId: string,
): Promise<{
  paymentId: string | null;
  paymentAttemptId: string | null;
  status: "processed" | "needs_review";
}> {
  const refund = await getSquareRefund(providerRefundId);
  if (refund.id !== providerRefundId) {
    throw new Error("square_refund_id_mismatch");
  }
  return reconcileSquareRefund(refund);
}

export type SquareWebhookEvent = {
  merchant_id?: string;
  type?: string;
  event_id?: string;
  created_at?: string;
  data?: {
    type?: string;
    id?: string;
    object?: {
      payment?: SquarePayment;
      refund?: {
        id?: string;
        payment_id?: string;
      };
    };
  };
};

export const SQUARE_PROVIDER_EVENT_LEASE_MS = 10 * 60 * 1_000;

export function canReclaimSquareProviderEvent(input: {
  processingStatus: string;
  receivedAt: Date;
  processedAt: Date | null;
  now?: Date;
}): boolean {
  if (input.processingStatus === "failed") return true;
  if (
    input.processingStatus !== "processing" &&
    input.processingStatus !== "received"
  ) {
    return false;
  }
  const leaseStartedAt = input.processedAt ?? input.receivedAt;
  const now = input.now ?? new Date();
  return (
    leaseStartedAt.getTime() <=
    now.getTime() - SQUARE_PROVIDER_EVENT_LEASE_MS
  );
}

export async function reserveSquareProviderEvent(
  event: SquareWebhookEvent,
): Promise<
  | { id: string; duplicate: false; leaseId: string }
  | { id: string; duplicate: true; leaseId: null }
> {
  if (!event.event_id?.trim() || !event.type?.trim()) {
    throw new Error("invalid_square_event");
  }
  const db = getDb();
  const now = new Date();
  const leaseId = crypto.randomUUID();
  const [created] = await db
    .insert(paymentProviderEvents)
    .values({
      provider: "square",
      providerEventId: event.event_id,
      eventType: event.type,
      processingStatus: "processing",
      payload: {
        merchantId: event.merchant_id ?? null,
        objectId: event.data?.id ?? null,
        dataType: event.data?.type ?? null,
        createdAt: event.created_at ?? null,
        processingLeaseId: leaseId,
      },
      receivedAt: now,
      processedAt: now,
    })
    .onConflictDoNothing({
      target: [
        paymentProviderEvents.provider,
        paymentProviderEvents.providerEventId,
      ],
    })
    .returning({ id: paymentProviderEvents.id });
  if (created) {
    return { id: created.id, duplicate: false, leaseId };
  }

  const [existing] = await db
    .select({
      id: paymentProviderEvents.id,
      processingStatus: paymentProviderEvents.processingStatus,
      payload: paymentProviderEvents.payload,
      receivedAt: paymentProviderEvents.receivedAt,
      processedAt: paymentProviderEvents.processedAt,
    })
    .from(paymentProviderEvents)
    .where(
      and(
        eq(paymentProviderEvents.provider, "square"),
        eq(paymentProviderEvents.providerEventId, event.event_id),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("square_event_reservation_failed");
  if (
    canReclaimSquareProviderEvent({
      processingStatus: existing.processingStatus,
      receivedAt: existing.receivedAt,
      processedAt: existing.processedAt,
      now,
    })
  ) {
    const staleCutoff = new Date(
      now.getTime() - SQUARE_PROVIDER_EVENT_LEASE_MS,
    );
    const leaseEligibility =
      existing.processingStatus === "failed"
        ? eq(paymentProviderEvents.processingStatus, "failed")
        : existing.processedAt
          ? and(
              eq(
                paymentProviderEvents.processingStatus,
                existing.processingStatus,
              ),
              lte(paymentProviderEvents.processedAt, staleCutoff),
            )
          : and(
              eq(
                paymentProviderEvents.processingStatus,
                existing.processingStatus,
              ),
              isNull(paymentProviderEvents.processedAt),
              lte(paymentProviderEvents.receivedAt, staleCutoff),
            );
    const [reclaimed] = await db
      .update(paymentProviderEvents)
      .set({
        processingStatus: "processing",
        paymentId: null,
        paymentAttemptId: null,
        payload: {
          ...(existing.payload ?? {}),
          processingLeaseId: leaseId,
        },
        processedAt: now,
        error: null,
      })
      .where(and(eq(paymentProviderEvents.id, existing.id), leaseEligibility))
      .returning({ id: paymentProviderEvents.id });
    if (reclaimed) {
      return { id: existing.id, duplicate: false, leaseId };
    }
  }
  return { id: existing.id, duplicate: true, leaseId: null };
}

export async function completeSquareProviderEvent(input: {
  eventId: string;
  leaseId: string;
  status: "processed" | "needs_review" | "failed";
  paymentId?: string | null;
  paymentAttemptId?: string | null;
  error?: string | null;
}): Promise<boolean> {
  const db = getDb();
  const [completed] = await db
    .update(paymentProviderEvents)
    .set({
      processingStatus: input.status,
      paymentId: input.paymentId ?? null,
      paymentAttemptId: input.paymentAttemptId ?? null,
      processedAt: new Date(),
      error: input.error?.slice(0, 1000) ?? null,
    })
    .where(
      and(
        eq(paymentProviderEvents.id, input.eventId),
        eq(paymentProviderEvents.processingStatus, "processing"),
        sql`${paymentProviderEvents.payload}->>'processingLeaseId' = ${input.leaseId}`,
      ),
    )
    .returning({ id: paymentProviderEvents.id });
  return Boolean(completed);
}

export async function processSquareWebhookEvent(
  event: SquareWebhookEvent,
): Promise<{
  status: "processed" | "needs_review" | "ignored";
  paymentId: string | null;
  paymentAttemptId: string | null;
}> {
  const eventType = event.type?.trim() ?? "";
  if (eventType === "payment.created" || eventType === "payment.updated") {
    const providerPaymentId = event.data?.object?.payment?.id ?? event.data?.id;
    if (!providerPaymentId) throw new Error("square_event_payment_id_missing");
    return reconcileSquarePaymentEvent(providerPaymentId);
  }
  if (eventType === "refund.created" || eventType === "refund.updated") {
    const providerRefundId = event.data?.object?.refund?.id ?? event.data?.id;
    if (!providerRefundId) throw new Error("square_event_refund_id_missing");
    return reconcileSquareRefundEvent(providerRefundId);
  }
  return {
    status: "ignored",
    paymentId: null,
    paymentAttemptId: null,
  };
}

export function hashSquareReturnNonce(nonce: string): string {
  return crypto.createHash("sha256").update(nonce).digest("base64url");
}

export async function reconcilePendingSquareAttempts(input?: {
  now?: Date;
  lookbackHours?: number;
}): Promise<{
  inspected: number;
  verified: number;
  pending: number;
  needsReview: number;
  unmatched: number;
  paymentsInspected: number;
  paymentsSkipped: number;
  unmatchedPayments: number;
  refundsInspected: number;
  refundsReconciled: number;
  refundsSkipped: number;
  refundsNeedsReview: number;
}> {
  // Release A deliberately runs without the 0059 payment tables. Probe before
  // constructing or querying any ledger work so the production worker is a
  // strict no-op until the additive payment migration exists.
  if (!(await isPaymentLedgerSchemaAvailable())) {
    return {
      inspected: 0,
      verified: 0,
      pending: 0,
      needsReview: 0,
      unmatched: 0,
      paymentsInspected: 0,
      paymentsSkipped: 0,
      unmatchedPayments: 0,
      refundsInspected: 0,
      refundsReconciled: 0,
      refundsSkipped: 0,
      refundsNeedsReview: 0,
    };
  }
  const db = getDb();
  const now = input?.now ?? new Date();
  const lookbackHours = Math.min(Math.max(input?.lookbackHours ?? 48, 1), 168);
  const since = new Date(now.getTime() - lookbackHours * 60 * 60 * 1_000);
  await expireStalePaymentAttempts(db, now);
  const attempts = await db
    .select({
      id: paymentAttempts.id,
      providerOrderId: paymentAttempts.providerOrderId,
      createdAt: paymentAttempts.createdAt,
    })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.provider, "square"),
        inArray(paymentAttempts.status, [
          "created",
          "launched",
          "pending_verification",
          "expired",
        ]),
        gte(paymentAttempts.createdAt, since),
      ),
    )
    .orderBy(desc(paymentAttempts.createdAt));

  let verified = 0;
  let pending = 0;
  let needsReview = 0;
  const withoutOrder = new Set<string>();
  for (const attempt of attempts) {
    if (!attempt.providerOrderId) {
      withoutOrder.add(attempt.id);
      continue;
    }
    const result = await reconcileSquareAttempt({
      attemptId: attempt.id,
      orderId: attempt.providerOrderId,
    });
    if (result.status === "verified") verified += 1;
    else if (result.status === "pending_verification") pending += 1;
    else needsReview += 1;
  }

  const locationId = process.env["SQUARE_LOCATION_ID"]?.trim();
  if (!locationId) throw new Error("SQUARE_LOCATION_ID is not set");
  let providerPayments: SquarePayment[];
  let providerRefunds: SquareRefund[];
  try {
    [providerPayments, providerRefunds] = await Promise.all([
      listSquarePayments({
        locationId,
        beginTime: since,
        endTime: now,
      }),
      listSquareRefunds({
        locationId,
        beginTime: since,
        endTime: now,
      }),
    ]);
  } catch (error) {
    await safelyRecordSquareHealth("failure", errorCode(error));
    throw error;
  }

  const seenProviderPaymentIds = new Set<string>();
  const completedProviderPayments = providerPayments.filter((payment) => {
    const providerPaymentId = payment.id?.trim();
    if (
      !providerPaymentId ||
      payment.status?.trim().toUpperCase() !== "COMPLETED" ||
      payment.location_id !== locationId ||
      seenProviderPaymentIds.has(providerPaymentId)
    ) {
      return false;
    }
    seenProviderPaymentIds.add(providerPaymentId);
    return true;
  });
  const providerPaymentIds = completedProviderPayments
    .map((payment) => payment.id)
    .filter((id): id is string => Boolean(id));
  const localPaymentRows =
    providerPaymentIds.length === 0
      ? []
      : await db
          .select({
            providerPaymentId: payments.providerPaymentId,
            canonicalStatus: payments.canonicalStatus,
            providerStatus: payments.providerStatus,
          })
          .from(payments)
          .where(
            and(
              eq(payments.provider, "square"),
              inArray(payments.providerPaymentId, providerPaymentIds),
            ),
          );
  const localPaymentsByProviderId = new Map(
    localPaymentRows
      .filter((row): row is typeof row & { providerPaymentId: string } =>
        Boolean(row.providerPaymentId),
      )
      .map((row) => [row.providerPaymentId, row]),
  );

  let paymentsSkipped = 0;
  let unmatchedPayments = 0;
  for (const providerPayment of completedProviderPayments) {
    const providerPaymentId = providerPayment.id!;
    const local = localPaymentsByProviderId.get(providerPaymentId);
    if (
      local &&
      canSkipFinalSquareProviderRecord({
        canonicalStatus: local.canonicalStatus,
        localProviderStatus: local.providerStatus,
        incomingProviderStatus: providerPayment.status,
      })
    ) {
      paymentsSkipped += 1;
      continue;
    }
    try {
      const result = await reconcileSquarePayment(providerPayment);
      if (result.paymentAttemptId) {
        withoutOrder.delete(result.paymentAttemptId);
      }
      if (result.status === "processed") {
        verified += 1;
      } else {
        needsReview += 1;
        if (!result.paymentAttemptId) unmatchedPayments += 1;
      }
    } catch (error) {
      needsReview += 1;
      await safelyRecordSquareHealth("failure", errorCode(error));
      console.warn("[square] payment sweep failed", {
        providerPaymentId,
        error: errorCode(error),
      });
    }
  }

  const seenProviderRefundIds = new Set<string>();
  const locationProviderRefunds = providerRefunds.filter((refund) => {
    const providerRefundId = refund.id?.trim();
    if (
      !providerRefundId ||
      refund.location_id !== locationId ||
      seenProviderRefundIds.has(providerRefundId)
    ) {
      return false;
    }
    seenProviderRefundIds.add(providerRefundId);
    return true;
  });
  const providerRefundIds = locationProviderRefunds.map((refund) => refund.id!);
  const localRefundRows =
    providerRefundIds.length === 0
      ? []
      : await db
          .select({
            providerRefundId: paymentRefunds.providerRefundId,
            canonicalStatus: paymentRefunds.canonicalStatus,
            providerStatus: paymentRefunds.providerStatus,
          })
          .from(paymentRefunds)
          .where(
            and(
              eq(paymentRefunds.provider, "square"),
              inArray(paymentRefunds.providerRefundId, providerRefundIds),
            ),
          );
  const localRefundsByProviderId = new Map(
    localRefundRows
      .filter((row): row is typeof row & { providerRefundId: string } =>
        Boolean(row.providerRefundId),
      )
      .map((row) => [row.providerRefundId, row]),
  );

  let refundsReconciled = 0;
  let refundsSkipped = 0;
  let refundsNeedsReview = 0;
  for (const providerRefund of locationProviderRefunds) {
    const providerRefundId = providerRefund.id!;
    const local = localRefundsByProviderId.get(providerRefundId);
    if (
      local &&
      canSkipFinalSquareProviderRecord({
        canonicalStatus: local.canonicalStatus,
        localProviderStatus: local.providerStatus,
        incomingProviderStatus: providerRefund.status,
      })
    ) {
      refundsSkipped += 1;
      continue;
    }
    try {
      const result = await reconcileSquareRefund(providerRefund);
      refundsReconciled += 1;
      if (result.status === "needs_review") {
        refundsNeedsReview += 1;
        needsReview += 1;
      }
    } catch (error) {
      refundsNeedsReview += 1;
      needsReview += 1;
      await safelyRecordSquareHealth("failure", errorCode(error));
      console.warn("[square] refund sweep failed", {
        providerRefundId,
        error: errorCode(error),
      });
    }
  }

  return {
    inspected: attempts.length,
    verified,
    pending,
    needsReview,
    unmatched: withoutOrder.size + unmatchedPayments,
    paymentsInspected: completedProviderPayments.length,
    paymentsSkipped,
    unmatchedPayments,
    refundsInspected: providerRefundIds.length,
    refundsReconciled,
    refundsSkipped,
    refundsNeedsReview,
  };
}
