import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import {
  appointments,
  auditLogs,
  partnerBookings,
  partnerInvoices,
  paymentAttempts,
  payments,
} from "@/db";
import { lockAppointmentInvoiceCollection } from "@/lib/partner-invoice-ledger";
import { PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES } from "@/lib/payment-ledger";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export class PartnerChangeOrderFinancialReviewRequired extends TeamMutationFailure {
  constructor() {
    super(
      "conflict",
      "Stonegate must review this job’s existing invoice or payment before this new price can be accepted. The quote, job price, and billing record have not changed.",
      { status: 409 },
    );
  }
}

/** Uses the existing CRM quoted-price authority. Never rewrites finalized
 * revenue, attribution, commission rows, or issued invoice/document evidence.
 * Callers that lock a booking row must acquire its collection lock first. */
export async function applyPartnerChangeOrderPrice(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    jobId: string;
    appointmentId: string;
    amountCents: number;
    actorMembershipId: string;
    changeOrderId: string;
    quoteVersionId: string;
    correlationId: string;
    now: Date;
  },
): Promise<void> {
  await lockAppointmentInvoiceCollection(tx, input.appointmentId);
  const [job] = await tx
    .select({
      id: appointments.id,
      quotedTotalCents: appointments.quotedTotalCents,
      finalTotalCents: appointments.finalTotalCents,
      status: appointments.status,
      updatedAt: appointments.updatedAt,
    })
    .from(appointments)
    .innerJoin(
      partnerBookings,
      and(
        eq(partnerBookings.appointmentId, appointments.id),
        eq(partnerBookings.id, input.jobId),
        eq(partnerBookings.partnerAccountId, input.accountId),
      ),
    )
    .where(
      and(
        eq(appointments.id, input.appointmentId),
        eq(appointments.partnerAccountId, input.accountId),
      ),
    )
    .for("update", { of: appointments })
    .limit(1);
  if (
    !job ||
    !Number.isSafeInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents > 2_147_483_647
  )
    throw new PartnerChangeOrderFinancialReviewRequired();
  const invoices = await tx
    .select({
      status: partnerInvoices.status,
      paidCents: partnerInvoices.paidCents,
      hosted: partnerInvoices.hostedPaymentUrl,
      order: partnerInvoices.providerOrderId,
      invoice: partnerInvoices.providerInvoiceId,
    })
    .from(partnerInvoices)
    .where(
      and(
        eq(partnerInvoices.partnerAccountId, input.accountId),
        eq(partnerInvoices.partnerBookingId, input.jobId),
      ),
    );
  const [attempt] = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.appointmentId, input.appointmentId),
        inArray(paymentAttempts.status, [
          ...PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES,
        ]),
      ),
    )
    .limit(1);
  // Even a refunded settled payment carries immutable allocations; correcting
  // its obligation is a separate staff financial-review operation.
  const [payment] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.appointmentId, input.appointmentId),
        or(
          isNull(payments.canonicalStatus),
          notInArray(payments.canonicalStatus, ["failed", "canceled"]),
        ),
      ),
    )
    .limit(1);
  if (
    job.finalTotalCents !== null ||
    ["completed", "canceled", "no_show"].includes(job.status) ||
    attempt ||
    payment ||
    invoices.some(
      (invoice) =>
        !["draft", "void"].includes(invoice.status) ||
        invoice.paidCents > 0 ||
        invoice.hosted ||
        invoice.order ||
        invoice.invoice,
    )
  )
    throw new PartnerChangeOrderFinancialReviewRequired();
  const updatedAt = new Date(
    Math.max(input.now.getTime(), job.updatedAt.getTime() + 1),
  );
  await tx
    .update(appointments)
    .set({
      quotedTotalCents: input.amountCents,
      quotedTotalMaxCents: input.amountCents,
      updatedAt,
    })
    .where(eq(appointments.id, input.appointmentId));
  await tx
    .insert(auditLogs)
    .values({
      actorType: "human",
      actorId: input.actorMembershipId,
      action: "partner.change_order.crm_price_applied",
      entityType: "appointment",
      entityId: input.appointmentId,
      correlationId: input.correlationId,
      meta: {
        partnerAccountId: input.accountId,
        partnerBookingId: input.jobId,
        changeOrderId: input.changeOrderId,
        quoteVersionId: input.quoteVersionId,
        previousQuotedTotalCents: job.quotedTotalCents,
        quotedTotalCents: input.amountCents,
        actorContext: "partner_session",
        financialAuthority: "crm_quote_before_finalization",
        correlationId: input.correlationId,
      },
      createdAt: input.now,
    });
}
