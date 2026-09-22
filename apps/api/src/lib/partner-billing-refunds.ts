import { and, eq } from "drizzle-orm";
import {
  getDb,
  partnerBillingRefundRequests,
  partnerInvoices,
  partnerBookings,
  payments,
} from "@/db";
import { lockPartnerRequestFinancials } from "./partner-request-financials";
import { refundSquarePayment } from "@/lib/square-client";
import { reconcileSquareRefundEvent } from "@/lib/square-payments";
import { getTeamOperationKillSwitchForRisk } from "@/lib/team-operation-kill-switch";

/** Durable refund operation. Provider uncertainty never releases the reservation. */
export async function processPartnerBillingRefundOperation(
  operationId: string,
): Promise<void> {
  const db = getDb();
  const [operation] = await db
    .select({
      request: partnerBillingRefundRequests,
      appointmentId: partnerBookings.appointmentId,
      bookingId: partnerBookings.id,
      paymentBookingId: payments.partnerBookingId,
      paymentAccountId: payments.partnerAccountId,
      providerPaymentId: payments.providerPaymentId,
      provider: payments.provider,
      paymentAppointmentId: payments.appointmentId,
    })
    .from(partnerBillingRefundRequests)
    .innerJoin(
      partnerInvoices,
      and(
        eq(partnerInvoices.id, partnerBillingRefundRequests.partnerInvoiceId),
        eq(
          partnerInvoices.partnerAccountId,
          partnerBillingRefundRequests.partnerAccountId,
        ),
      ),
    )
    .innerJoin(
      partnerBookings,
      and(
        eq(partnerBookings.id, partnerInvoices.partnerBookingId),
        eq(partnerBookings.partnerAccountId, partnerInvoices.partnerAccountId),
      ),
    )
    .innerJoin(
      payments,
      eq(payments.id, partnerBillingRefundRequests.paymentId),
    )
    .where(eq(partnerBillingRefundRequests.id, operationId))
    .limit(1);
  if (!operation || ["settled", "failed"].includes(operation.request.status))
    return;
  if (
    operation.provider !== "square" ||
    !operation.providerPaymentId ||
    (operation.appointmentId
      ? operation.appointmentId !== operation.paymentAppointmentId
      : operation.paymentBookingId !== operation.bookingId ||
        operation.paymentAccountId !== operation.request.partnerAccountId)
  )
    throw new Error("partner_refund_binding_invalid");
  if (getTeamOperationKillSwitchForRisk("financial"))
    throw new Error("partner_refund_financial_writes_disabled");
  // No lock is held across network I/O. Stable provider idempotency protects two
  // workers, webhook races, and crashes after Square accepted the refund.
  const refund = operation.request.providerRefundId
    ? null
    : await refundSquarePayment({
        idempotencyKey: operation.request.id,
        paymentId: operation.providerPaymentId,
        amountCents: operation.request.amountCents,
        currency: "USD",
        reason: operation.request.reason,
      });
  const providerRefundId = operation.request.providerRefundId ?? refund!.id;
  if (!providerRefundId) throw new Error("partner_refund_provider_id_missing");
  await db.transaction(async (tx) => {
    await lockPartnerRequestFinancials(
      tx,
      operation.request.partnerAccountId,
      operation.bookingId,
    );
    const [current] = await tx
      .select()
      .from(partnerBillingRefundRequests)
      .where(eq(partnerBillingRefundRequests.id, operationId))
      .for("update")
      .limit(1);
    if (!current || ["settled", "failed"].includes(current.status)) return;
    if (
      current.providerRefundId &&
      current.providerRefundId !== providerRefundId
    )
      throw new Error("partner_refund_provider_conflict");
    await tx
      .update(partnerBillingRefundRequests)
      .set({ providerRefundId, status: "submitted", updatedAt: new Date() })
      .where(eq(partnerBillingRefundRequests.id, operationId));
  });
  // Authoritative provider retrieval and the existing CRM reconciliation determine
  // settlement, amounts, tip allocation, and invoice balance; PENDING is not paid.
  await reconcileSquareRefundEvent(providerRefundId);
  const [reconciled] = await db
    .select({ status: partnerBillingRefundRequests.status })
    .from(partnerBillingRefundRequests)
    .where(eq(partnerBillingRefundRequests.id, operationId))
    .limit(1);
  if (!reconciled || !["settled", "failed"].includes(reconciled.status)) {
    // The outbox retry/backoff and reconciliation worker must keep polling.
    // Do not acknowledge a pending provider operation as completed work.
    throw new Error("partner_refund_settlement_pending");
  }
}
