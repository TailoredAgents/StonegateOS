import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  appointments,
  auditLogs,
  partnerBookings,
  partnerInvoices,
  paymentAttempts,
  payments,
} from "@/db";
import { lockPartnerRequestFinancials } from "./partner-request-financials";
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
    appointmentId: string | null;
    amountCents: number;
    actorMembershipId: string;
    changeOrderId: string;
    quoteVersionId: string;
    correlationId: string;
    now: Date;
  },
): Promise<void> {
  const binding = await lockPartnerRequestFinancials(
    tx,
    input.accountId,
    input.jobId,
  );
  if (binding.appointmentId !== input.appointmentId)
    throw new PartnerChangeOrderFinancialReviewRequired();
  const [job] = await tx
    .select({
      id: partnerBookings.id,
      modelVersion: partnerBookings.modelVersion,
      quotedTotalCents: sql<
        number | null
      >`case when ${partnerBookings.modelVersion}=2 then ${partnerBookings.quotedTotalCents} else ${appointments.quotedTotalCents} end`,
      finalTotalCents: sql<
        number | null
      >`case when ${partnerBookings.modelVersion}=2 then ${partnerBookings.finalTotalCents} else ${appointments.finalTotalCents} end`,
      status: sql<string>`case when ${partnerBookings.modelVersion}=2 then ${partnerBookings.publicStatus} else ${appointments.status}::text end`,
      updatedAt: partnerBookings.updatedAt,
    })
    .from(partnerBookings)
    .leftJoin(
      appointments,
      and(
        eq(appointments.id, partnerBookings.appointmentId),
        eq(appointments.partnerAccountId, input.accountId),
      ),
    )
    .where(
      and(
        eq(partnerBookings.id, input.jobId),
        eq(partnerBookings.partnerAccountId, input.accountId),
      ),
    )
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
        input.appointmentId
          ? eq(paymentAttempts.appointmentId, input.appointmentId)
          : and(
              eq(paymentAttempts.partnerBookingId, input.jobId),
              eq(paymentAttempts.partnerAccountId, input.accountId),
            ),
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
        input.appointmentId
          ? eq(payments.appointmentId, input.appointmentId)
          : and(
              eq(payments.partnerBookingId, input.jobId),
              eq(payments.partnerAccountId, input.accountId),
            ),
        or(
          isNull(payments.canonicalStatus),
          notInArray(payments.canonicalStatus, ["failed", "canceled"]),
        ),
      ),
    )
    .limit(1);
  if (
    (job.modelVersion === 2 && job.quotedTotalCents !== input.amountCents) ||
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
  if (input.appointmentId)
    await tx
      .update(appointments)
      .set({
        quotedTotalCents: input.amountCents,
        quotedTotalMaxCents: input.amountCents,
        updatedAt,
      })
      .where(eq(appointments.id, input.appointmentId));
  await tx.insert(auditLogs).values({
    actorType: "human",
    actorId: input.actorMembershipId,
    action: "partner.change_order.crm_price_applied",
    entityType: input.appointmentId ? "appointment" : "partner_booking",
    entityId: input.appointmentId ?? input.jobId,
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
