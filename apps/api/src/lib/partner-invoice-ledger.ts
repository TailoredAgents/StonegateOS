import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  partnerBookings,
  partnerInvoices,
  partnerAccounts,
  partnerBillingDocumentOperations,
  partnerPaymentAllocations,
  paymentRefunds,
  payments,
} from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { queuePartnerBillingDocument } from "@/lib/partner-billing-documents";
import { resolvePartnerRefundAllocations } from "@/lib/partner-refund-allocation";

const PAYABLE_STATES = ["issued", "partially_paid", "paid", "overdue"];

/** Acquire before locking payment attempts, payments, or invoice rows. */
export async function lockAppointmentInvoiceCollection(
  tx: TeamMutationTransaction,
  appointmentId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('appointment_payment_collection'), hashtext(${appointmentId}))`,
  );
}

export function calculatePartnerInvoiceSettlement(input: {
  totalCents: number;
  creditedCents?: number;
  dueAt: Date | null;
  entries: ReadonlyArray<{ allocatedCents: number; refundedJobCents: number }>;
  now?: Date;
}): { paidCents: number; balanceCents: number; status: string } {
  const creditedCents = input.creditedCents ?? 0;
  const amounts = [
    input.totalCents,
    creditedCents,
    ...input.entries.flatMap((entry) => [
      entry.allocatedCents,
      entry.refundedJobCents,
    ]),
  ];
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
    throw new Error("partner_invoice_ledger_invalid_amount");
  }
  const paidCents = input.entries.reduce(
    (sum, entry) =>
      sum + Math.max(0, entry.allocatedCents - entry.refundedJobCents),
    0,
  );
  if (
    !Number.isSafeInteger(paidCents) ||
    paidCents + creditedCents > input.totalCents
  ) {
    throw new Error("partner_invoice_ledger_overallocated");
  }
  const balanceCents = input.totalCents - paidCents - creditedCents;
  return {
    paidCents,
    balanceCents,
    status:
      balanceCents === 0
        ? "paid"
        : input.dueAt && input.dueAt < (input.now ?? new Date())
          ? "overdue"
          : paidCents > 0
            ? "partially_paid"
            : "issued",
  };
}

/**
 * Project the canonical CRM payment/refund ledger into account-owned invoices.
 * Never infer an account from a CRM contact. Auto-allocation is permitted only
 * for one explicitly linked, issued invoice; ambiguous multi-invoice payments
 * are left for staff allocation. Existing allocation history is not rewritten.
 * Call inside the financial mutation, with the appointment collection lock held.
 */
export async function reconcilePartnerAppointmentInvoices(
  tx: TeamMutationTransaction,
  appointmentId: string,
  options: { explicitlyReconciledInvoiceIds?: ReadonlySet<string> } = {},
): Promise<void> {
  const invoices = await tx
    .select({
      id: partnerInvoices.id,
      bookingId: partnerInvoices.partnerBookingId,
      accountId: partnerInvoices.partnerAccountId,
      accountName: partnerAccounts.name,
      invoiceNumber: partnerInvoices.invoiceNumber,
      currency: partnerInvoices.currency,
      totalCents: partnerInvoices.totalCents,
      creditedCents: partnerInvoices.creditedCents,
      paidCents: partnerInvoices.paidCents,
      balanceCents: partnerInvoices.balanceCents,
      status: partnerInvoices.status,
      dueDate: partnerInvoices.dueDate,
      paidAt: partnerInvoices.paidAt,
      version: partnerInvoices.version,
    })
    .from(partnerInvoices)
    .innerJoin(
      partnerBookings,
      and(
        eq(partnerBookings.id, partnerInvoices.partnerBookingId),
        eq(partnerBookings.partnerAccountId, partnerInvoices.partnerAccountId),
      ),
    )
    .innerJoin(
      partnerAccounts,
      eq(partnerAccounts.id, partnerInvoices.partnerAccountId),
    )
    .where(
      and(
        eq(partnerBookings.appointmentId, appointmentId),
        inArray(partnerInvoices.status, PAYABLE_STATES),
      ),
    )
    .orderBy(asc(partnerInvoices.id))
    .for("update", { of: partnerInvoices });
  if (invoices.length === 0) return;

  const paymentRows = await tx
    .select({
      id: payments.id,
      currency: payments.currency,
      jobAmountCents: payments.jobAmountCents,
      canonicalStatus: payments.canonicalStatus,
      tipCents: payments.tipCents,
      totalAmountCents: payments.totalAmountCents,
      capturedAt: payments.capturedAt,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(eq(payments.appointmentId, appointmentId))
    .orderBy(asc(payments.id))
    .for("update");
  const paymentIds = paymentRows.map((payment) => payment.id);
  const invoiceIds = invoices.map((invoice) => invoice.id);
  // Include allocations for an invoice whose payment was subsequently detached;
  // those no longer count as settled against this job.
  const allocations = await tx
    .select()
    .from(partnerPaymentAllocations)
    .where(inArray(partnerPaymentAllocations.partnerInvoiceId, invoiceIds))
    .orderBy(asc(partnerPaymentAllocations.id))
    .for("update");
  const allPaymentAllocations = paymentIds.length
    ? await tx
        .select()
        .from(partnerPaymentAllocations)
        .where(inArray(partnerPaymentAllocations.paymentId, paymentIds))
        .for("update")
    : [];
  const refunds = paymentIds.length
    ? await tx
        .select({
          id: paymentRefunds.id,
          paymentId: paymentRefunds.paymentId,
          providerRefundId: paymentRefunds.providerRefundId,
          jobAmountCents: paymentRefunds.jobAmountCents,
          amountCents: paymentRefunds.amountCents,
          refundedAt: paymentRefunds.refundedAt,
          createdAt: paymentRefunds.createdAt,
        })
        .from(paymentRefunds)
        .where(
          and(
            inArray(paymentRefunds.paymentId, paymentIds),
            sql`upper(${paymentRefunds.providerStatus}) = 'COMPLETED'`,
          ),
        )
    : [];
  const refundedByPayment = new Map<string, number>();
  for (const refund of refunds) {
    refundedByPayment.set(
      refund.paymentId,
      (refundedByPayment.get(refund.paymentId) ?? 0) + refund.jobAmountCents,
    );
  }
  // A newly encountered unallocated payment is not evidence that an earlier
  // historical paid scalar was backed by that payment. Check the pre-existing
  // projection BEFORE auto-allocation can hide a missing or partial history.
  // Compare gross principal, not net: genuine completed refunds must still be
  // allowed to reduce an otherwise fully supported invoice's paid balance.
  for (const invoice of invoices) {
    if (options.explicitlyReconciledInvoiceIds?.has(invoice.id)) continue;
    const supportedGross = allocations
      .filter(
        (allocation) =>
          allocation.partnerInvoiceId === invoice.id &&
          allocation.partnerAccountId === invoice.accountId &&
          allocation.state === "settled" &&
          paymentRows.some(
            (payment) =>
              payment.id === allocation.paymentId &&
              payment.canonicalStatus === "completed" &&
              payment.currency === invoice.currency,
          ),
      )
      .reduce((sum, allocation) => sum + allocation.amountCents, 0);
    if (invoice.paidCents > supportedGross)
      throw new Error(
        "partner_invoice_historical_payment_reconciliation_required",
      );
  }
  const now = new Date();
  if (invoices.length === 1) {
    const invoice = invoices[0]!;
    let allocatedNet = allocations
      .filter((row) => row.state === "settled")
      .reduce(
        (sum, row) =>
          sum +
          Math.max(
            0,
            row.amountCents - (refundedByPayment.get(row.paymentId) ?? 0),
          ),
        0,
      );
    for (const payment of paymentRows) {
      if (
        payment.canonicalStatus !== "completed" ||
        payment.currency !== invoice.currency ||
        !payment.jobAmountCents ||
        payment.jobAmountCents <= 0 ||
        allPaymentAllocations.some((row) => row.paymentId === payment.id) ||
        allocatedNet +
          Math.max(
            0,
            payment.jobAmountCents - (refundedByPayment.get(payment.id) ?? 0),
          ) >
          invoice.totalCents - invoice.creditedCents
      )
        continue;
      const [allocation] = await tx
        .insert(partnerPaymentAllocations)
        .values({
          partnerAccountId: invoice.accountId,
          partnerInvoiceId: invoice.id,
          paymentId: payment.id,
          amountCents: payment.jobAmountCents,
          state: "settled",
          allocatedAt: now,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (allocation) {
        allocations.push(allocation);
        allocatedNet += Math.max(
          0,
          payment.jobAmountCents - (refundedByPayment.get(payment.id) ?? 0),
        );
      }
    }
  }
  const refundAllocations = await resolvePartnerRefundAllocations(tx, {
    allocations,
    refunds,
  });
  const allocatedRefund = (invoiceId: string, paymentId: string) =>
    refundAllocations
      .filter(
        (row) =>
          row.partnerInvoiceId === invoiceId &&
          refunds.some(
            (refund) =>
              refund.id === row.refundId && refund.paymentId === paymentId,
          ),
      )
      .reduce((sum, row) => sum + row.jobAmountCents, 0);
  for (const payment of paymentRows) {
    if (
      allocations
        .filter(
          (row) => row.paymentId === payment.id && row.state === "settled",
        )
        .reduce((sum, row) => sum + row.amountCents, 0) >
      (payment.jobAmountCents ?? 0)
    )
      throw new Error("partner_payment_allocation_overallocated");
  }
  for (const invoice of invoices) {
    const settledAllocations = allocations.filter(
      (row) =>
        row.partnerInvoiceId === invoice.id &&
        row.partnerAccountId === invoice.accountId &&
        row.state === "settled" &&
        paymentRows.some(
          (payment) =>
            payment.id === row.paymentId &&
            payment.canonicalStatus === "completed" &&
            payment.currency === invoice.currency,
        ),
    );
    if (
      invoice.paidCents > 0 &&
      settledAllocations.length === 0 &&
      !options.explicitlyReconciledInvoiceIds?.has(invoice.id)
    ) {
      // A legacy scalar or detached payment is not proof that money disappeared.
      // Do not reopen its balance and permit a second collection; staff must
      // reconcile the explicit allocation before any new financial mutation.
      throw new Error(
        "partner_invoice_historical_payment_reconciliation_required",
      );
    }
    if (settledAllocations.some(row => allocatedRefund(invoice.id, row.paymentId) > row.amountCents))
      throw new Error("partner_refund_allocation_reconciliation_required");
    const settlement = calculatePartnerInvoiceSettlement({
      totalCents: invoice.totalCents,
      creditedCents: invoice.creditedCents,
      dueAt: invoice.dueDate
        ? DateTime.fromISO(invoice.dueDate, { zone: "America/New_York" })
            .endOf("day")
            .toJSDate()
        : null,
      now,
      entries: settledAllocations.map((row) => ({
        allocatedCents: row.amountCents,
        refundedJobCents: allocatedRefund(invoice.id, row.paymentId),
      })),
    });
    if (
      settlement.paidCents !== invoice.paidCents ||
      settlement.balanceCents !== invoice.balanceCents ||
      settlement.status !== invoice.status
    )
      await tx
        .update(partnerInvoices)
        .set({
          ...settlement,
          paidAt: settlement.status === "paid" ? (invoice.paidAt ?? now) : null,
          version: invoice.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerInvoices.id, invoice.id),
            eq(partnerInvoices.partnerAccountId, invoice.accountId),
          ),
        );
    for (const allocation of allocations.filter(
      (row) => row.partnerInvoiceId === invoice.id && row.state === "settled",
    )) {
      const payment = paymentRows.find(
        (row) =>
          row.id === allocation.paymentId &&
          row.canonicalStatus === "completed",
      );
      if (!payment) continue;
      const [existingReceipt] = await tx
        .select({ id: partnerBillingDocumentOperations.id })
        .from(partnerBillingDocumentOperations)
        .where(
          and(
            eq(
              partnerBillingDocumentOperations.partnerAccountId,
              invoice.accountId,
            ),
            eq(partnerBillingDocumentOperations.documentType, "receipt"),
            eq(partnerBillingDocumentOperations.partnerInvoiceId, invoice.id),
            inArray(partnerBillingDocumentOperations.sourceKey, [
              payment.id,
              allocation.id,
            ]),
          ),
        )
        .limit(1);
      if (!existingReceipt)
        await queuePartnerBillingDocument(tx, {
          accountId: invoice.accountId,
          bookingId: invoice.bookingId,
          invoiceId: invoice.id,
          sourceKey:
            allocations.filter(
              (row) => row.paymentId === payment.id && row.state === "settled",
            ).length === 1
              ? payment.id
              : allocation.id,
          kind: "receipt",
          snapshot: {
            title: "Receipt",
            number: invoice.invoiceNumber,
            accountName: invoice.accountName,
            issuedAt: (payment.capturedAt ?? payment.createdAt).toISOString(),
            currency: "USD",
            lines: [
              {
                description: "Payment applied to invoice",
                amountCents: allocation.amountCents,
              },
              ...(payment.tipCents > 0 &&
              allocations.filter(
                (row) =>
                  row.paymentId === payment.id && row.state === "settled",
              ).length === 1
                ? [{ description: "Tip", amountCents: payment.tipCents }]
                : []),
            ],
            totals: [
              {
                label: "Payment received",
                amountCents:
                  allocation.amountCents +
                  (allocations.filter(
                    (row) =>
                      row.paymentId === payment.id && row.state === "settled",
                  ).length === 1
                    ? payment.tipCents
                    : 0),
              },
            ],
            notes: [
              "This receipt confirms a settled payment, not a pending authorization.",
            ],
          },
        });
      for (const refund of refunds.filter(
        (row) => row.paymentId === payment.id,
      )) {
        const refundAmount = refundAllocations
          .filter(
            (row) =>
              row.refundId === refund.id && row.partnerInvoiceId === invoice.id,
          )
          .reduce((sum, row) => sum + row.jobAmountCents, 0);
        if (!refundAmount) continue;
        const [existingRefund] = await tx
          .select({ id: partnerBillingDocumentOperations.id })
          .from(partnerBillingDocumentOperations)
          .where(
            and(
              eq(
                partnerBillingDocumentOperations.partnerAccountId,
                invoice.accountId,
              ),
              eq(partnerBillingDocumentOperations.documentType, "refund"),
              eq(partnerBillingDocumentOperations.partnerInvoiceId, invoice.id),
              inArray(partnerBillingDocumentOperations.sourceKey, [
                refund.id,
                `${refund.id}/${invoice.id}`,
              ]),
            ),
          )
          .limit(1);
        if (existingRefund) continue;
        await queuePartnerBillingDocument(tx, {
          accountId: invoice.accountId,
          bookingId: invoice.bookingId,
          invoiceId: invoice.id,
          sourceKey:
            refundAllocations.filter((row) => row.refundId === refund.id)
              .length === 1
              ? refund.id
              : `${refund.id}/${invoice.id}`,
          kind: "refund",
          snapshot: {
            title: "Refund receipt",
            number: invoice.invoiceNumber,
            accountName: invoice.accountName,
            issuedAt: (refund.refundedAt ?? refund.createdAt).toISOString(),
            currency: "USD",
            lines: [
              {
                description: "Refund to original payment method",
                amountCents: refundAmount,
              },
            ],
            totals: [
              { label: "Refund applied to invoice", amountCents: refundAmount },
            ],
            notes: [
              "A refund returns a payment. A separate credit is needed to reduce the invoice charge.",
            ],
          },
        });
      }
    }
  }
}
