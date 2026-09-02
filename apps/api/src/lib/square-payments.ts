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
  finalizePartnerPortalPaymentReconciliation,
  parsePartnerPaymentAttemptMetadata,
} from "@/lib/partner-portal-v2-payments";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/provider-health";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

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

export type SquareReturnOperationExpectation = {
  operationId: string;
  callbackHash: string;
  providerOrderId: string;
};

type SquareAttemptReconciliationFinalizer = (
  tx: TeamMutationTransaction,
  result: SquareAttemptReconciliationResult,
) => Promise<void>;

type StoredSquareReturnOperation = {
  phase?: unknown;
  operationId?: unknown;
  callbackHash?: unknown;
  providerOrderId?: unknown;
};

export function squareReturnOperationMatches(
  metadata: Record<string, unknown> | null | undefined,
  expected: SquareReturnOperationExpectation,
): boolean {
  const operation = metadata?.["squareReturnOperation"];
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return false;
  }
  const stored = operation as StoredSquareReturnOperation;
  return (
    stored.phase === "dispatched" &&
    stored.operationId === expected.operationId &&
    stored.callbackHash === expected.callbackHash &&
    stored.providerOrderId === expected.providerOrderId
  );
}

export function squarePaymentBindingMatches(input: {
  payment: {
    provider: string;
    appointmentId: string | null;
    paymentAttemptId: string | null;
    providerOrderId: string | null;
    providerPaymentId: string | null;
    jobAmountCents: number | null;
    tipCents: number;
    totalAmountCents: number | null;
    amount: number;
    currency: string;
    canonicalStatus: string | null;
  };
  appointmentId: string;
  attemptId: string;
  verified: Pick<
    VerifiedSquarePayment,
    | "providerOrderId"
    | "providerPaymentId"
    | "jobAmountCents"
    | "tipCents"
    | "totalAmountCents"
    | "currency"
  >;
}): boolean {
  const { payment, verified } = input;
  return (
    payment.provider === "square" &&
    payment.canonicalStatus === "completed" &&
    payment.appointmentId === input.appointmentId &&
    payment.paymentAttemptId === input.attemptId &&
    payment.providerOrderId === verified.providerOrderId &&
    payment.providerPaymentId === verified.providerPaymentId &&
    payment.jobAmountCents === verified.jobAmountCents &&
    payment.tipCents === verified.tipCents &&
    payment.totalAmountCents === verified.totalAmountCents &&
    payment.amount === verified.totalAmountCents &&
    payment.currency.toUpperCase() === verified.currency
  );
}

export function completedSquarePaymentMatchesAttempt(input: {
  payment: {
    provider: string;
    appointmentId: string | null;
    paymentAttemptId: string | null;
    providerOrderId: string | null;
    providerPaymentId: string | null;
    jobAmountCents: number | null;
    tipCents: number;
    totalAmountCents: number | null;
    amount: number;
    currency: string;
    canonicalStatus: string | null;
  };
  attempt: {
    id: string;
    appointmentId: string;
    requestedJobAmountCents: number;
    providerOrderId: string | null;
    providerPaymentId: string | null;
  };
  orderId: string;
}): boolean {
  const { payment, attempt } = input;
  return (
    payment.provider === "square" &&
    payment.canonicalStatus === "completed" &&
    payment.appointmentId === attempt.appointmentId &&
    payment.paymentAttemptId === attempt.id &&
    payment.providerOrderId === input.orderId &&
    attempt.providerOrderId === input.orderId &&
    payment.providerPaymentId !== null &&
    payment.providerPaymentId === attempt.providerPaymentId &&
    payment.jobAmountCents === attempt.requestedJobAmountCents &&
    payment.tipCents >= 0 &&
    payment.totalAmountCents ===
      attempt.requestedJobAmountCents + payment.tipCents &&
    payment.amount === payment.totalAmountCents &&
    payment.currency.toUpperCase() === "USD"
  );
}

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
  const code = errorCode(error);
  return (
    error instanceof TypeError ||
    code === "fetch failed" ||
    code === "square_order_not_completed" ||
    code === "square_payment_not_completed"
  );
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
  expectedReturnOperation?: SquareReturnOperationExpectation;
  finalize?: SquareAttemptReconciliationFinalizer;
}): Promise<SquareAttemptReconciliationResult> {
  const db = getDb();
  const selectAttempt = {
    id: paymentAttempts.id,
    // This reconciler is the appointment-POS path. Quote deposits have their
    // own exact-version/order verifier and may not have an appointment yet.
    appointmentId: sql<string>`${paymentAttempts.appointmentId}`,
    status: paymentAttempts.status,
    requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
    currency: paymentAttempts.currency,
    providerOrderId: paymentAttempts.providerOrderId,
    providerPaymentId: paymentAttempts.providerPaymentId,
    squareLocationId: paymentAttempts.squareLocationId,
    initiatedByMemberId: paymentAttempts.initiatedByMemberId,
    metadata: paymentAttempts.metadata,
  };
  const [attempt] = await db
    .select(selectAttempt)
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.id, input.attemptId),
        eq(paymentAttempts.provider, "square"),
      ),
    )
    .limit(1);
  if (!attempt) throw new Error("payment_attempt_not_found");
  if (!attempt.appointmentId) {
    throw new Error("quote_deposit_requires_quote_reconciliation");
  }

  const requestedOrderId = input.orderId?.trim() || null;
  const storedOrderId = attempt.providerOrderId?.trim() || null;
  if (requestedOrderId && storedOrderId && requestedOrderId !== storedOrderId) {
    return {
      status: "needs_review",
      appointmentId: attempt.appointmentId,
      attemptId: attempt.id,
      errorCode: "square_order_id_conflict",
    };
  }
  const orderId = requestedOrderId ?? storedOrderId;
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
  const partnerPaymentMetadata = parsePartnerPaymentAttemptMetadata(
    attempt.metadata,
  );
  const expectedSourceType =
    partnerPaymentMetadata?.paymentMethod === "ach" ? "BANK_ACCOUNT" : "CARD";

  const assertLockedAttempt = (locked: typeof attempt): void => {
    if (
      locked.appointmentId !== attempt.appointmentId ||
      locked.requestedJobAmountCents !== attempt.requestedJobAmountCents ||
      locked.currency !== attempt.currency ||
      locked.squareLocationId !== attempt.squareLocationId ||
      locked.initiatedByMemberId !== attempt.initiatedByMemberId ||
      (locked.providerOrderId !== null &&
        locked.providerOrderId.trim() !== orderId)
    ) {
      throw new Error("square_attempt_changed_during_reconciliation");
    }
    if (
      input.expectedReturnOperation &&
      !squareReturnOperationMatches(
        locked.metadata,
        input.expectedReturnOperation,
      )
    ) {
      throw new Error("square_return_operation_changed");
    }
  };

  const paymentProjection = {
    id: payments.id,
    provider: payments.provider,
    appointmentId: payments.appointmentId,
    paymentAttemptId: payments.paymentAttemptId,
    providerOrderId: payments.providerOrderId,
    providerPaymentId: payments.providerPaymentId,
    jobAmountCents: payments.jobAmountCents,
    tipCents: payments.tipCents,
    totalAmountCents: payments.totalAmountCents,
    amount: payments.amount,
    currency: payments.currency,
    canonicalStatus: payments.canonicalStatus,
  };

  if (attempt.status === "completed") {
    const [existing] = await db
      .select(paymentProjection)
      .from(payments)
      .where(eq(payments.paymentAttemptId, attempt.id))
      .limit(1);
    if (
      existing &&
      existing.providerPaymentId !== null &&
      completedSquarePaymentMatchesAttempt({
        payment: existing,
        attempt,
        orderId,
      })
    ) {
      const result: SquareAttemptReconciliationResult = {
        status: "verified",
        appointmentId: attempt.appointmentId,
        attemptId: attempt.id,
        paymentId: existing.id,
        providerPaymentId: existing.providerPaymentId,
      };
      if (input.finalize) {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('square_payment_attempt'), hashtext(${attempt.id}))`,
          );
          const [locked] = await tx
            .select(selectAttempt)
            .from(paymentAttempts)
            .where(
              and(
                eq(paymentAttempts.id, attempt.id),
                eq(paymentAttempts.provider, "square"),
              ),
            )
            .for("update")
            .limit(1);
          if (!locked || locked.status !== "completed") {
            throw new Error("square_attempt_changed_during_reconciliation");
          }
          assertLockedAttempt(locked);
          await input.finalize!(tx, result);
        });
      }
      return result;
    }
    return {
      status: "needs_review",
      appointmentId: attempt.appointmentId,
      attemptId: attempt.id,
      errorCode: "square_completed_attempt_binding_mismatch",
    };
  }

  let verified: VerifiedSquarePayment;
  try {
    // Provider I/O deliberately occurs outside every database transaction.
    verified = await retrieveAndVerifySquarePayment({
      orderId,
      expectedAttemptId: attempt.id,
      expectedJobAmountCents: attempt.requestedJobAmountCents,
      expectedLocationId,
      expectedSourceType,
    });
  } catch (error) {
    const code = errorCode(error);
    const pending = isRetryableSquareError(error);
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('square_payment_attempt'), hashtext(${attempt.id}))`,
      );
      const [locked] = await tx
        .select(selectAttempt)
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.id, attempt.id),
            eq(paymentAttempts.provider, "square"),
          ),
        )
        .for("update")
        .limit(1);
      if (!locked) throw new Error("payment_attempt_not_found");
      assertLockedAttempt(locked);
      if (locked.status === "completed") {
        const [completedPayment] = await tx
          .select(paymentProjection)
          .from(payments)
          .where(eq(payments.paymentAttemptId, locked.id))
          .for("update")
          .limit(1);
        const exactProviderPaymentId = completedPayment?.providerPaymentId;
        const exact =
          completedPayment !== undefined &&
          exactProviderPaymentId !== null &&
          exactProviderPaymentId !== undefined &&
          completedSquarePaymentMatchesAttempt({
            payment: completedPayment,
            attempt: locked,
            orderId,
          });
        const reconciliation: SquareAttemptReconciliationResult = exact
          ? {
              status: "verified",
              appointmentId: locked.appointmentId,
              attemptId: locked.id,
              paymentId: completedPayment.id,
              providerPaymentId: exactProviderPaymentId,
            }
          : {
              status: "needs_review",
              appointmentId: locked.appointmentId,
              attemptId: locked.id,
              errorCode: "square_completed_attempt_binding_mismatch",
            };
        await input.finalize?.(tx, reconciliation);
        return reconciliation;
      }
      const reconciliation: SquareAttemptReconciliationResult = {
        status: pending ? "pending_verification" : "needs_review",
        appointmentId: locked.appointmentId,
        attemptId: locked.id,
        errorCode: code,
      };
      const now = new Date();
      await tx
        .update(paymentAttempts)
        .set({
          status: pending ? "pending_verification" : "needs_review",
          providerOrderId: orderId,
          errorCode: code,
          errorMessage: code,
          ...(pending ? {} : { resolvedAt: now }),
          updatedAt: now,
        })
        .where(eq(paymentAttempts.id, locked.id));
      await input.finalize?.(tx, reconciliation);
      return reconciliation;
    });
    await safelyRecordSquareHealth(
      result.status === "verified" ? "success" : "failure",
      result.status === "verified" ? undefined : code,
    );
    return result;
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('square_payment_attempt'), hashtext(${attempt.id}))`,
    );
    const [locked] = await tx
      .select(selectAttempt)
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.id, attempt.id),
          eq(paymentAttempts.provider, "square"),
        ),
      )
      .for("update")
      .limit(1);
    if (!locked) throw new Error("payment_attempt_not_found");
    assertLockedAttempt(locked);

    const [byProviderPayment] = await tx
      .select(paymentProjection)
      .from(payments)
      .where(
        and(
          eq(payments.provider, "square"),
          eq(payments.providerPaymentId, verified.providerPaymentId),
        ),
      )
      .for("update")
      .limit(1);
    const [byAttempt] = await tx
      .select(paymentProjection)
      .from(payments)
      .where(eq(payments.paymentAttemptId, locked.id))
      .for("update")
      .limit(1);

    const existing = byProviderPayment ?? byAttempt ?? null;
    const existingIsExact =
      existing !== null &&
      squarePaymentBindingMatches({
        payment: existing,
        appointmentId: locked.appointmentId,
        attemptId: locked.id,
        verified,
      });
    if (
      (byProviderPayment &&
        byAttempt &&
        byProviderPayment.id !== byAttempt.id) ||
      (existing && !existingIsExact)
    ) {
      const reconciliation: SquareAttemptReconciliationResult = {
        status: "needs_review",
        appointmentId: locked.appointmentId,
        attemptId: locked.id,
        errorCode: "square_payment_already_linked",
      };
      const now = new Date();
      if (locked.status !== "completed") {
        await tx
          .update(paymentAttempts)
          .set({
            status: "needs_review",
            providerOrderId: orderId,
            errorCode: "square_payment_already_linked",
            errorMessage:
              "Square payment is already linked to a different appointment or attempt.",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(eq(paymentAttempts.id, locked.id));
      }
      await input.finalize?.(tx, reconciliation);
      return reconciliation;
    }

    const now = new Date();
    let paymentId = existing?.id ?? null;
    if (!paymentId) {
      const [inserted] = await tx
        .insert(payments)
        .values({
          provider: "square",
          providerPaymentId: verified.providerPaymentId,
          providerOrderId: verified.providerOrderId,
          paymentAttemptId: locked.id,
          amount: verified.totalAmountCents,
          jobAmountCents: verified.jobAmountCents,
          tipCents: verified.tipCents,
          totalAmountCents: verified.totalAmountCents,
          refundedAmountCents: verified.refundedAmountCents,
          currency: verified.currency,
          status: verified.providerStatus.toLowerCase(),
          canonicalStatus: "completed",
          providerStatus: verified.providerStatus,
          method: verified.tenderType,
          tenderType: verified.tenderType,
          entryMethod: verified.entryMethod,
          cardBrand: verified.cardBrand,
          last4: verified.last4,
          receiptUrl: verified.receiptUrl,
          squareLocationId: verified.locationId,
          initiatedByMemberId: locked.initiatedByMemberId,
          appointmentId: locked.appointmentId,
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
        // Never let a provider/payment or attempt uniqueness conflict rewrite
        // an existing financial relationship.
        .onConflictDoNothing()
        .returning({ id: payments.id });
      paymentId = inserted?.id ?? null;
      if (!paymentId) {
        const [concurrent] = await tx
          .select(paymentProjection)
          .from(payments)
          .where(
            and(
              eq(payments.provider, "square"),
              eq(payments.providerPaymentId, verified.providerPaymentId),
            ),
          )
          .for("update")
          .limit(1);
        if (
          !concurrent ||
          !squarePaymentBindingMatches({
            payment: concurrent,
            appointmentId: locked.appointmentId,
            attemptId: locked.id,
            verified,
          })
        ) {
          throw new Error("square_payment_concurrency_conflict");
        }
        paymentId = concurrent.id;
      }
    }

    const [attemptUpdated] = await tx
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
      .where(
        and(
          eq(paymentAttempts.id, locked.id),
          eq(paymentAttempts.provider, "square"),
          inArray(paymentAttempts.status, [
            "created",
            "launched",
            "pending_verification",
            "completed",
          ]),
        ),
      )
      .returning({ id: paymentAttempts.id });
    if (!attemptUpdated) {
      throw new Error("square_attempt_completion_conflict");
    }

    await syncAppointmentCardTipCents(tx, locked.appointmentId);
    const reconciliation: SquareAttemptReconciliationResult = {
      status: "verified",
      appointmentId: locked.appointmentId,
      attemptId: locked.id,
      paymentId,
      providerPaymentId: verified.providerPaymentId,
    };
    await input.finalize?.(tx, reconciliation);
    return reconciliation;
  });

  await safelyRecordSquareHealth(
    result.status === "verified" ? "success" : "failure",
    result.status === "verified" ? undefined : result.errorCode,
  );
  return result;
}

async function upsertSquarePaymentForReview(
  payment: SquarePayment,
  metadata?: Record<string, unknown>,
): Promise<string> {
  const normalized = normalizeSquarePaymentForReview(payment);
  const now = new Date();
  const db = getDb();
  const [inserted] = await db
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
    // A review import may discover an existing payment, but must never rewrite
    // or take over that payment's financial binding.
    .onConflictDoNothing()
    .returning({ id: payments.id });
  if (inserted) return inserted.id;
  const [existing] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.provider, "square"),
        eq(payments.providerPaymentId, normalized.providerPaymentId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("square_unmatched_payment_insert_conflict");
  return existing.id;
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
      quoteResponseId: paymentAttempts.quoteResponseId,
      providerOrderId: paymentAttempts.providerOrderId,
      providerPaymentId: paymentAttempts.providerPaymentId,
      metadata: paymentAttempts.metadata,
    })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attemptId))
    .limit(1);
  if (completedAttempt?.quoteResponseId) {
    const { reconcileQuoteV2DepositAttempt } = await import(
      "@/lib/quote-v2-deposit-service"
    );
    const quoteDeposit = await reconcileQuoteV2DepositAttempt({ attemptId });
    return {
      paymentId: quoteDeposit.paymentId,
      paymentAttemptId: attemptId,
      status:
        quoteDeposit.receipt.requiresRefundReview ||
        quoteDeposit.receipt.requiresSchedulingConfirmation
          ? "needs_review"
          : "processed",
    };
  }
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
    finalize: finalizePartnerPortalPaymentReconciliation,
  });
  if (reconciled.status === "verified") {
    return {
      paymentId: reconciled.paymentId,
      paymentAttemptId: attemptId,
      status: "processed",
    };
  }
  const partnerPaymentMetadata = parsePartnerPaymentAttemptMetadata(
    completedAttempt?.metadata,
  );
  if (
    partnerPaymentMetadata?.paymentMethod === "ach" &&
    reconciled.status === "pending_verification"
  ) {
    // A signed payment.updated webhook can arrive while the bank transfer is
    // still pending. Acknowledge it without creating a payment allocation or
    // changing the invoice balance; a later completed webhook reconciles it.
    return {
      paymentId: null,
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
    leaseStartedAt.getTime() <= now.getTime() - SQUARE_PROVIDER_EVENT_LEASE_MS
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
      finalize: finalizePartnerPortalPaymentReconciliation,
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
