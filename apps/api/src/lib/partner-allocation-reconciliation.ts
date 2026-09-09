import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  appointments,
  partnerAccounts,
  partnerAllocationReconciliations,
  partnerBillingRefundRequests,
  partnerBookings,
  partnerInvoices,
  partnerPaymentAllocations,
  partnerRefundAllocations,
  paymentAttempts,
  paymentRefunds,
  payments,
} from "@/db";
import {
  lockAppointmentInvoiceCollection,
  reconcilePartnerAppointmentInvoices,
} from "@/lib/partner-invoice-ledger";
import { PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES } from "@/lib/payment-ledger";
import { queuePartnerBillingDocument } from "@/lib/partner-billing-documents";
import { effectivePartnerInvoiceStatusSql } from "@/lib/partner-invoice-status";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const Minor = z.number().int().min(0).max(2_147_483_647);
const SinglePaymentPlan = z
  .object({
    paymentId: z.string().uuid(),
    allocations: z
      .array(
        z
          .object({
            invoiceId: z.string().uuid(),
            grossAmountCents: Minor.positive(),
            refunds: z
              .array(
                z
                  .object({
                    refundId: z.string().uuid(),
                    amountCents: Minor.positive(),
                  })
                  .strict(),
              )
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    reason: z.string().trim().min(12).max(2000),
    evidenceReference: z.string().trim().min(3).max(500),
  })
  .strict();
type Command = z.infer<typeof SinglePaymentPlan>;
const HistoricalPayment = z
  .object({
    paymentId: z.string().uuid(),
    tenderType: z.enum(["cash", "check"]),
    jobAmountCents: Minor.positive(),
    receivedAt: z.string().datetime({ offset: true }),
    evidenceReference: z.string().trim().min(3).max(500),
    tipAcknowledgment: z.literal("NO_UNRECORDED_TIP"),
    allocations: SinglePaymentPlan.shape.allocations,
  })
  .strict();
export const PartnerAllocationReconciliationCommand = z
  .object({
    payments: z
      .array(SinglePaymentPlan.pick({ paymentId: true, allocations: true }))
      .max(200),
    historicalPayments: z.array(HistoricalPayment).max(10).optional(),
    reason: z.string().trim().min(12).max(2000),
    evidenceReference: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine(
    (command) =>
      command.payments.length + (command.historicalPayments?.length ?? 0) > 0,
    "Choose genuine existing payments or explicitly supported historical cash/check receipts.",
  );
function fail(message: string, status = 409): never {
  throw new TeamMutationFailure("conflict", message, { status });
}

export async function readPartnerAllocationReconciliation(
  tx: TeamMutationTransaction,
  accountId: string,
  jobId: string,
) {
  const [job] = await tx
    .select({
      id: partnerBookings.id,
      appointmentId: appointments.id,
      accountName: partnerAccounts.name,
      finalTotalCents: appointments.finalTotalCents,
      quotedTotalCents: appointments.quotedTotalCents,
      status: appointments.status,
    })
    .from(partnerBookings)
    .innerJoin(
      appointments,
      and(
        eq(appointments.id, partnerBookings.appointmentId),
        eq(appointments.partnerAccountId, accountId),
      ),
    )
    .innerJoin(
      partnerAccounts,
      eq(partnerAccounts.id, partnerBookings.partnerAccountId),
    )
    .where(
      and(
        eq(partnerBookings.id, jobId),
        eq(partnerBookings.partnerAccountId, accountId),
      ),
    )
    .limit(1);
  if (!job) fail("Choose an account-owned job.", 404);
  const invoices = await tx
    .select({
      id: partnerInvoices.id,
      number: partnerInvoices.invoiceNumber,
      status: effectivePartnerInvoiceStatusSql(),
      currency: partnerInvoices.currency,
      totalCents: partnerInvoices.totalCents,
      creditedCents: partnerInvoices.creditedCents,
      paidCents: partnerInvoices.paidCents,
      balanceCents: partnerInvoices.balanceCents,
      version: partnerInvoices.version,
      providerInvoiceId: partnerInvoices.providerInvoiceId,
      providerOrderId: partnerInvoices.providerOrderId,
      hostedPaymentUrl: partnerInvoices.hostedPaymentUrl,
    })
    .from(partnerInvoices)
    .where(
      and(
        eq(partnerInvoices.partnerAccountId, accountId),
        eq(partnerInvoices.partnerBookingId, jobId),
      ),
    )
    .orderBy(asc(partnerInvoices.id))
    .limit(101);
  const paymentRows = await tx
    .select({
      id: payments.id,
      method: payments.method,
      currency: payments.currency,
      jobAmountCents: payments.jobAmountCents,
      tipCents: payments.tipCents,
      totalAmountCents: payments.totalAmountCents,
      refundedAmountCents: payments.refundedAmountCents,
      status: payments.canonicalStatus,
      capturedAt: payments.capturedAt,
      createdAt: payments.createdAt,
      updatedAt: payments.updatedAt,
    })
    .from(payments)
    .where(eq(payments.appointmentId, job.appointmentId))
    .orderBy(asc(payments.id))
    .limit(201);
  if (invoices.length > 100 || paymentRows.length > 200)
    fail(
      "This job exceeds the reconciliation view limit. Resolve its financial ownership before splitting its records.",
    );
  const paymentIds = paymentRows.map((row) => row.id),
    invoiceIds = invoices.map((row) => row.id);
  const allocations =
    paymentIds.length || invoiceIds.length
      ? await tx
          .select()
          .from(partnerPaymentAllocations)
          .where(
            or(
              paymentIds.length
                ? inArray(partnerPaymentAllocations.paymentId, paymentIds)
                : undefined,
              invoiceIds.length
                ? inArray(
                    partnerPaymentAllocations.partnerInvoiceId,
                    invoiceIds,
                  )
                : undefined,
            ),
          )
          .orderBy(asc(partnerPaymentAllocations.id))
      : [];
  if (
    allocations.some(
      (row) =>
        row.partnerAccountId !== accountId ||
        !invoiceIds.includes(row.partnerInvoiceId) ||
        !paymentIds.includes(row.paymentId),
    )
  )
    fail(
      "An allocation has conflicting company or job ownership. Contain and reconcile its canonical payment binding first.",
    );
  const refunds = paymentIds.length
    ? await tx
        .select({
          id: paymentRefunds.id,
          paymentId: paymentRefunds.paymentId,
          jobAmountCents: paymentRefunds.jobAmountCents,
          tipCents: paymentRefunds.tipCents,
          amountCents: paymentRefunds.amountCents,
          status: paymentRefunds.canonicalStatus,
          providerStatus: paymentRefunds.providerStatus,
          refundedAt: paymentRefunds.refundedAt,
        })
        .from(paymentRefunds)
        .where(inArray(paymentRefunds.paymentId, paymentIds))
        .orderBy(asc(paymentRefunds.id))
    : [];
  const splits = refunds.length
    ? await tx
        .select()
        .from(partnerRefundAllocations)
        .where(
          inArray(
            partnerRefundAllocations.refundId,
            refunds.map((row) => row.id),
          ),
        )
        .orderBy(asc(partnerRefundAllocations.id))
    : [];
  if (
    splits.some(
      (row) =>
        row.partnerAccountId !== accountId ||
        !invoiceIds.includes(row.partnerInvoiceId),
    )
  )
    fail(
      "A refund allocation has conflicting ownership. Contain it before making a financial correction.",
    );
  const [pendingAttempt] = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.appointmentId, job.appointmentId),
        inArray(paymentAttempts.status, [
          ...PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES,
        ]),
      ),
    )
    .limit(1);
  const [pendingRefund] = paymentIds.length
    ? await tx
        .select({ id: partnerBillingRefundRequests.id })
        .from(partnerBillingRefundRequests)
        .where(
          and(
            inArray(partnerBillingRefundRequests.paymentId, paymentIds),
            inArray(partnerBillingRefundRequests.status, [
              "queued",
              "submitted",
              "needs_review",
            ]),
          ),
        )
        .limit(1)
    : [];
  const blockers = [
    pendingAttempt ||
    paymentRows.some(
      (row) =>
        !row.status ||
        !["completed", "failed", "canceled"].includes(row.status) ||
        (row.status === "completed" &&
          (row.jobAmountCents === null ||
            row.jobAmountCents < 0 ||
            row.currency !== "USD")),
    )
      ? "A payment is pending or needs provider reconciliation."
      : "",
    pendingRefund ||
    refunds.some(
      (row) => !["completed", "failed", "canceled"].includes(row.status),
    )
      ? "A refund is pending or needs provider reconciliation."
      : "",
    invoices.some(
      (row) =>
        row.providerInvoiceId || row.providerOrderId || row.hostedPaymentUrl,
    )
      ? "Retire and reconcile existing hosted collection first."
      : "",
  ].filter(Boolean);
  const unexplainedPaidPrincipalCents = Math.max(
    0,
    invoices.reduce((sum, row) => sum + row.paidCents, 0) -
      Math.max(
        0,
        paymentRows
          .filter((row) => row.status === "completed" && row.currency === "USD")
          .reduce((sum, row) => sum + (row.jobAmountCents ?? 0), 0) -
          refunds
            .filter(
              (row) =>
                row.status === "completed" &&
                row.providerStatus?.toUpperCase() === "COMPLETED",
            )
            .reduce((sum, row) => sum + row.jobAmountCents, 0),
      ),
  );
  const snapshot = {
    job,
    invoices,
    payments: paymentRows,
    allocations,
    refunds,
    refundAllocations: splits,
    blockers,
    unexplainedPaidPrincipalCents,
  };
  const revision = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  const history = await tx
    .select({
      id: partnerAllocationReconciliations.id,
      reason: partnerAllocationReconciliations.reason,
      evidenceReference: partnerAllocationReconciliations.evidenceReference,
      paymentId: partnerAllocationReconciliations.paymentId,
      createdAt: partnerAllocationReconciliations.createdAt,
    })
    .from(partnerAllocationReconciliations)
    .where(
      and(
        eq(partnerAllocationReconciliations.partnerAccountId, accountId),
        eq(partnerAllocationReconciliations.partnerBookingId, jobId),
      ),
    )
    .orderBy(
      asc(partnerAllocationReconciliations.createdAt),
      asc(partnerAllocationReconciliations.id),
    );
  return { ...snapshot, revision, history };
}

async function stagePartnerPaymentAllocations(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    jobId: string;
    actorId: string;
    correlationId: string;
    expectedVersion: string | null;
    command: Command;
  },
) {
  const initial = await readPartnerAllocationReconciliation(
    tx,
    input.accountId,
    input.jobId,
  );
  await lockAppointmentInvoiceCollection(tx, initial.job.appointmentId);
  const current = await readPartnerAllocationReconciliation(
    tx,
    input.accountId,
    input.jobId,
  );
  if (input.expectedVersion?.replace(/^"|"$/gu, "") !== current.revision)
    fail(
      "The financial records changed. Refresh and review them before saving.",
      412,
    );
  if (current.blockers.length) fail(current.blockers.join(" "));
  const payment = current.payments.find(
    (row) => row.id === input.command.paymentId,
  );
  if (
    !payment ||
    payment.status !== "completed" ||
    payment.currency !== "USD" ||
    !payment.jobAmountCents
  )
    fail(
      "Choose a genuine settled, itemized payment already linked to this job. Pending payments and tips cannot support an invoice balance.",
    );
  const chosen = input.command.allocations;
  if (new Set(chosen.map((row) => row.invoiceId)).size !== chosen.length)
    fail("Choose each invoice only once.");
  if (
    chosen.reduce((sum, row) => sum + row.grossAmountCents, 0) !==
    payment.jobAmountCents
  )
    fail(
      "Allocate the complete service-payment principal exactly once. Exclude tips and do not invent or discard money.",
    );
  const refunds = current.refunds.filter(
    (row) =>
      row.paymentId === payment.id &&
      row.status === "completed" &&
      row.providerStatus?.toUpperCase() === "COMPLETED",
  );
  const refundIds = new Set(refunds.map((row) => row.id));
  for (const allocation of chosen) {
    const invoice = current.invoices.find(
      (row) => row.id === allocation.invoiceId,
    );
    if (
      !invoice ||
      !["issued", "partially_paid", "paid", "overdue"].includes(
        invoice.status,
      ) ||
      invoice.currency !== payment.currency
    )
      fail(
        "Choose an issued invoice for this exact company, job, and currency.",
      );
    if (
      new Set(allocation.refunds.map((row) => row.refundId)).size !==
        allocation.refunds.length ||
      allocation.refunds.some((row) => !refundIds.has(row.refundId))
    )
      fail("Choose each genuine completed refund only once per invoice.");
    if (
      allocation.refunds.reduce((sum, row) => sum + row.amountCents, 0) >
      allocation.grossAmountCents
    )
      fail(
        "An invoice cannot receive more refunded principal than its payment allocation.",
      );
  }
  for (const refund of refunds)
    if (
      chosen
        .flatMap((row) => row.refunds)
        .filter((row) => row.refundId === refund.id)
        .reduce((sum, row) => sum + row.amountCents, 0) !==
      refund.jobAmountCents
    )
      fail(
        "Allocate every completed service refund exactly once. Refund tips remain outside invoice balances.",
      );
  const now = new Date();
  await tx
    .update(partnerPaymentAllocations)
    .set({ state: "reversed", reversedAt: now })
    .where(
      and(
        eq(partnerPaymentAllocations.partnerAccountId, input.accountId),
        eq(partnerPaymentAllocations.paymentId, payment.id),
      ),
    );
  if (refundIds.size)
    await tx
      .update(partnerRefundAllocations)
      .set({ jobAmountCents: 0, updatedAt: now })
      .where(
        and(
          eq(partnerRefundAllocations.partnerAccountId, input.accountId),
          inArray(partnerRefundAllocations.refundId, [...refundIds]),
        ),
      );
  for (const row of chosen) {
    await tx
      .insert(partnerPaymentAllocations)
      .values({
        partnerAccountId: input.accountId,
        partnerInvoiceId: row.invoiceId,
        paymentId: payment.id,
        amountCents: row.grossAmountCents,
        state: "settled",
        allocatedAt: payment.capturedAt ?? payment.createdAt,
      })
      .onConflictDoUpdate({
        target: [
          partnerPaymentAllocations.partnerInvoiceId,
          partnerPaymentAllocations.paymentId,
        ],
        set: {
          amountCents: row.grossAmountCents,
          state: "settled",
          allocatedAt: payment.capturedAt ?? payment.createdAt,
          reversedAt: null,
        },
      });
    for (const refund of row.refunds)
      await tx
        .insert(partnerRefundAllocations)
        .values({
          partnerAccountId: input.accountId,
          partnerInvoiceId: row.invoiceId,
          refundId: refund.refundId,
          jobAmountCents: refund.amountCents,
        })
        .onConflictDoUpdate({
          target: [
            partnerRefundAllocations.partnerInvoiceId,
            partnerRefundAllocations.refundId,
          ],
          set: { jobAmountCents: refund.amountCents, updatedAt: now },
        });
  }
}

export async function reconcilePartnerPaymentAllocations(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    jobId: string;
    actorId: string;
    correlationId: string;
    expectedVersion: string | null;
    command: z.infer<typeof PartnerAllocationReconciliationCommand>;
  },
) {
  const initial = await readPartnerAllocationReconciliation(
    tx,
    input.accountId,
    input.jobId,
  );
  await lockAppointmentInvoiceCollection(tx, initial.job.appointmentId);
  const before = await readPartnerAllocationReconciliation(
    tx,
    input.accountId,
    input.jobId,
  );
  if (input.expectedVersion?.replace(/^"|"$/gu, "") !== before.revision)
    fail(
      "The financial records changed. Refresh and review them before saving.",
      412,
    );
  if (before.blockers.length) fail(before.blockers.join(" "));
  const historical = input.command.historicalPayments ?? [];
  const historicalTotal = historical.reduce(
    (sum, row) => sum + row.jobAmountCents,
    0,
  );
  if (historicalTotal > before.unexplainedPaidPrincipalCents)
    fail(
      "Historical cash/check records may explain only genuinely missing legacy paid principal. Existing payment records must be reconciled, not recorded again.",
    );
  const historicalNow = new Date();
  for (const record of historical) {
    const received = new Date(record.receivedAt);
    if (
      !Number.isFinite(received.getTime()) ||
      received > historicalNow ||
      received.getUTCFullYear() < 1900
    )
      fail("Enter the actual historical receipt date, not a future date.");
    if (
      record.tipAcknowledgment !== "NO_UNRECORDED_TIP" ||
      record.allocations.some((row) => row.refunds.length > 0)
    )
      fail(
        "Historical recording covers service principal only. Resolve unrecorded tips with payroll before claiming this receipt is reconciled; refund evidence requires separate review.",
      );
    const receiptKey = createHash("sha256")
      .update(
        JSON.stringify([
          input.accountId,
          input.jobId,
          record.tenderType,
          record.evidenceReference.trim().toLowerCase(),
        ]),
      )
      .digest("hex");
    const [existing] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        or(
          eq(payments.id, record.paymentId),
          and(
            eq(payments.provider, "manual"),
            eq(payments.providerPaymentId, `historical-${receiptKey}`),
          ),
        ),
      )
      .limit(1);
    if (existing)
      fail(
        "This historical receipt already has a payment record. Refresh and reconcile that record instead of recording it again.",
      );
    await tx
      .insert(payments)
      .values({
        id: record.paymentId,
        provider: "manual",
        providerPaymentId: `historical-${receiptKey}`,
        appointmentId: before.job.appointmentId,
        amount: record.jobAmountCents,
        jobAmountCents: record.jobAmountCents,
        totalAmountCents: record.jobAmountCents,
        tipCents: 0,
        refundedAmountCents: 0,
        currency: "USD",
        status: "completed",
        canonicalStatus: "completed",
        providerStatus: "COMPLETED",
        method: record.tenderType,
        tenderType: record.tenderType,
        initiatedByMemberId: input.actorId,
        legacySource: "partner_historical_receipt",
        paidAt: received,
        capturedAt: received,
        createdAt: historicalNow,
        updatedAt: historicalNow,
        metadata: {
          historicalPartnerReceipt: {
            schemaVersion: 1,
            partnerAccountId: input.accountId,
            partnerBookingId: input.jobId,
            evidenceReference: record.evidenceReference,
            receivedAt: record.receivedAt,
            reason: input.command.reason,
            tipAcknowledgment: record.tipAcknowledgment,
            monetaryCollectionPerformed: false,
            correlationId: input.correlationId,
          },
        },
      });
  }
  const paymentPlans = [
    ...input.command.payments,
    ...historical.map((row) => ({
      paymentId: row.paymentId,
      allocations: row.allocations,
    })),
  ];
  const paymentIds = new Set(paymentPlans.map((row) => row.paymentId));
  if (paymentIds.size !== paymentPlans.length)
    fail("Choose each payment only once.");
  for (const plan of paymentPlans) {
    const staged = await readPartnerAllocationReconciliation(
      tx,
      input.accountId,
      input.jobId,
    );
    await stagePartnerPaymentAllocations(tx, {
      ...input,
      expectedVersion: staged.revision,
      command: {
        ...plan,
        reason: input.command.reason,
        evidenceReference: input.command.evidenceReference,
      },
    });
  }
  const proposed = await readPartnerAllocationReconciliation(
    tx,
    input.accountId,
    input.jobId,
  );
  const net = (state: typeof before, invoiceId: string) =>
    state.allocations
      .filter(
        (row) => row.partnerInvoiceId === invoiceId && row.state === "settled",
      )
      .reduce((sum, row) => sum + row.amountCents, 0) -
    state.refundAllocations
      .filter((row) => row.partnerInvoiceId === invoiceId)
      .reduce((sum, row) => sum + row.jobAmountCents, 0);
  for (const invoice of before.invoices) {
    const paid = net(proposed, invoice.id);
    if (paid < 0 || paid > invoice.totalCents - invoice.creditedCents)
      fail("The proposed allocation exceeds an invoice’s collectible total.");
    if (
      invoice.paidCents > Math.max(0, net(before, invoice.id)) &&
      paid < invoice.paidCents
    )
      fail(
        "A historical paid balance lacks supporting allocations. Include every genuine settled payment supporting that balance; this action cannot erase it or reopen it for collection.",
      );
  }
  await reconcilePartnerAppointmentInvoices(tx, before.job.appointmentId, {
    explicitlyReconciledInvoiceIds: new Set(
      before.invoices.map((row) => row.id),
    ),
  });
  const after = await readPartnerAllocationReconciliation(
    tx,
    input.accountId,
    input.jobId,
  );
  const reconciliationId = randomUUID(),
    now = new Date();
  for (const [index, paymentId] of [...paymentIds].entries())
    await tx.insert(partnerAllocationReconciliations).values({
      id: index === 0 ? reconciliationId : randomUUID(),
      partnerAccountId: input.accountId,
      partnerBookingId: input.jobId,
      paymentId,
      actorId: input.actorId,
      reason: input.command.reason,
      evidenceReference: input.command.evidenceReference,
      beforeSnapshot: {
        ...before,
        history: undefined,
        batchId: reconciliationId,
      },
      afterSnapshot: {
        ...after,
        history: undefined,
        batchId: reconciliationId,
        recordedHistoricalPayments: historical,
      },
      correlationId: input.correlationId,
      // Order evidence by the correction time after the collection lock, not
      // PostgreSQL's transaction-start timestamp while another repair waited.
      createdAt: now,
    });
  const affected = new Set([
    ...before.allocations
      .filter((row) => paymentIds.has(row.paymentId))
      .map((row) => row.partnerInvoiceId),
    ...paymentPlans.flatMap((row) => row.allocations.map((a) => a.invoiceId)),
  ]);
  for (const invoice of after.invoices.filter((row) => affected.has(row.id)))
    await queuePartnerBillingDocument(tx, {
      accountId: input.accountId,
      bookingId: input.jobId,
      invoiceId: invoice.id,
      sourceKey: `${reconciliationId}/${invoice.id}`,
      kind: "receipt",
      snapshot: {
        title: "Receipt",
        number: invoice.number,
        accountName: before.job.accountName,
        issuedAt: now.toISOString(),
        currency: "USD",
        lines: [
          {
            description:
              "Settled service-payment principal applied after reconciliation",
            amountCents: invoice.paidCents,
          },
        ],
        totals: [
          { label: "Invoice total", amountCents: invoice.totalCents },
          { label: "Net settled payments", amountCents: invoice.paidCents },
          { label: "Remaining balance", amountCents: invoice.balanceCents },
        ],
        notes: [
          "This corrects the allocation of an existing payment. No new charge, refund, or service revenue was created. Earlier documents remain part of the record.",
        ],
      },
    });
  return {
    reconciliationId,
    revision: after.revision,
    accountId: input.accountId,
    jobId: input.jobId,
  };
}
