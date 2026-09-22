import { loadPartnerStaffInvitationAuthority } from "./partner-invitation-authority";
import {
  lockPartnerRequestFinancials,
  partnerRequestTotalSql,
} from "./partner-request-financials";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  appointments,
  outboxEvents,
  partnerAccounts,
  partnerBillingDocumentOperations,
  partnerBillingRefundRequests,
  partnerBookings,
  partnerInvoiceCredits,
  partnerInvoiceLines,
  partnerInvoices,
  partnerPaymentAllocations,
  partnerRefundAllocations,
  partnerStatements,
  paymentAttempts,
  paymentRefunds,
  payments,
} from "@/db";
import { queuePartnerBillingDocument } from "@/lib/partner-billing-documents";
import type { PartnerBillingDocumentSnapshot } from "@/lib/partner-billing-document-renderer";
import { reconcilePartnerAppointmentInvoices } from "@/lib/partner-invoice-ledger";
import { PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES } from "@/lib/payment-ledger";
import { allocateRefund } from "@/lib/payment-summary";
import { resolvePartnerRefundAllocations } from "@/lib/partner-refund-allocation";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const Minor = z.number().int().min(0).max(2_147_483_647);
const Reason = z.string().trim().min(3).max(192);
const Line = z
  .object({
    description: z.string().trim().min(1).max(1000),
    quantity: z
      .string()
      .regex(/^[0-9]{1,6}(?:\.[0-9]{1,3})?$/u)
      .default("1"),
    unitAmountCents: Minor,
  })
  .strict();
const InvoiceFields = {
  lines: z.array(Line).min(1).max(100),
  taxCents: Minor.default(0),
  discountCents: Minor.default(0),
  depositCents: Minor.default(0),
  poNumber: z.string().trim().max(100).nullable().default(null),
  costCenter: z.string().trim().max(100).nullable().default(null),
  billingContact: z
    .object({
      name: z.string().trim().min(1).max(200),
      email: z.string().email().max(320).optional(),
    })
    .strict(),
  terms: z.string().trim().max(1000).nullable().default(null),
  dueDate: z.string().date().nullable().default(null),
  reason: Reason,
};
export const PartnerBillingCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create_invoice"),
      jobId: z.string().uuid(),
      ...InvoiceFields,
    })
    .strict(),
  z
    .object({
      action: z.literal("revise_invoice"),
      invoiceId: z.string().uuid(),
      ...InvoiceFields,
    })
    .strict(),
  z
    .object({
      action: z.literal("issue_invoice"),
      invoiceId: z.string().uuid(),
      reason: Reason,
    })
    .strict(),
  z
    .object({
      action: z.literal("void_invoice"),
      invoiceId: z.string().uuid(),
      reason: Reason,
    })
    .strict(),
  z
    .object({
      action: z.literal("credit_invoice"),
      invoiceId: z.string().uuid(),
      amountCents: Minor.positive(),
      reason: Reason,
    })
    .strict(),
  z
    .object({
      action: z.literal("refund_payment"),
      invoiceId: z.string().uuid(),
      paymentId: z.string().uuid(),
      amountCents: Minor.positive(),
      reason: Reason,
    })
    .strict(),
  z
    .object({
      action: z.literal("record_manual_payment"),
      invoiceId: z.string().uuid(),
      clientRequestId: z.string().uuid(),
      amountCents: Minor.positive(),
      method: z.enum(["cash", "check"]),
      reference: z.string().trim().max(120).nullable().default(null),
      reason: Reason,
      confirmation: z.literal("PAYMENT ALREADY RECEIVED"),
    })
    .strict(),
  z
    .object({
      action: z.literal("record_manual_refund"),
      invoiceId: z.string().uuid(),
      paymentId: z.string().uuid(),
      amountCents: Minor.positive(),
      reason: Reason,
      confirmation: z.literal("REFUND ALREADY GIVEN"),
    })
    .strict(),
  z
    .object({
      action: z.literal("generate_statement"),
      periodStart: z.string().date(),
      periodEnd: z.string().date(),
      reason: Reason,
    })
    .strict(),
]);
export type PartnerBillingCommand = z.infer<typeof PartnerBillingCommandSchema>;

export function calculatePartnerInvoiceLines(
  lines: Array<z.infer<typeof Line>>,
  taxCents: number,
  discountCents: number,
) {
  const calculated = lines.map((line) => {
    const [whole, fraction = ""] = line.quantity.split(".");
    const quantityMillis =
      Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
    const numerator = quantityMillis * line.unitAmountCents;
    if (quantityMillis <= 0 || !Number.isSafeInteger(numerator))
      throw new TeamMutationFailure(
        "invalid",
        "Invoice quantities are outside the supported range.",
      );
    const lineTotalCents = Math.round(numerator / 1000);
    if (lineTotalCents > 2_147_483_647)
      throw new TeamMutationFailure(
        "invalid",
        "An invoice line exceeds the supported amount.",
      );
    return { ...line, lineTotalCents };
  });
  const subtotalCents = calculated.reduce(
    (sum, line) => sum + line.lineTotalCents,
    0,
  );
  const totalCents = subtotalCents + taxCents - discountCents;
  if (
    !Number.isSafeInteger(subtotalCents) ||
    subtotalCents > 2_147_483_647 ||
    !Number.isSafeInteger(totalCents) ||
    totalCents <= 0 ||
    totalCents > 2_147_483_647
  )
    throw new TeamMutationFailure(
      "invalid",
      "Invoice total must be a positive supported amount.",
    );
  return { lines: calculated, subtotalCents, totalCents };
}

async function assertNoUnresolvedPayment(
  tx: TeamMutationTransaction,
  binding: { id: string; appointmentId: string | null },
) {
  const [attempt] = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        binding.appointmentId
          ? eq(paymentAttempts.appointmentId, binding.appointmentId)
          : eq(paymentAttempts.partnerBookingId, binding.id),
        inArray(paymentAttempts.status, [
          ...PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES,
        ]),
      ),
    )
    .limit(1);
  if (attempt)
    throw new TeamMutationFailure(
      "conflict",
      "A payment is pending or needs reconciliation. Resolve it before changing this invoice.",
    );
}

function requireVersion(actual: number, expected: string | null) {
  if (expected?.replace(/^"|"$/gu, "") !== String(actual)) {
    throw new TeamMutationFailure(
      "conflict",
      "The invoice changed. Refresh before saving.",
      { status: 412 },
    );
  }
}

export async function runPartnerBillingCommand(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    actorId: string;
    command: PartnerBillingCommand;
    expectedVersion: string | null;
  },
): Promise<{
  invoiceId?: string;
  operationId?: string;
  creditId?: string;
  refundRequestId?: string;
  paymentId?: string;
  replayed?: boolean;
  revision?: number;
}> {
  const { command, accountId } = input;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('partner_staff_billing'), hashtext(${accountId}))`,
  );
  const [account] = await tx
    .select({
      name: partnerAccounts.name,
      timezone: sql<string>`'America/New_York'`,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, accountId))
    .limit(1);
  if (!account)
    throw new TeamMutationFailure("invalid", "Account not found.", {
      status: 404,
    });
  if (command.action === "generate_statement")
    return generateStatement(tx, accountId, account, command);

  let invoice: typeof partnerInvoices.$inferSelect | undefined;
  let booking:
    | { id: string; appointmentId: string | null; totalCents: number | null }
    | undefined;
  if (command.action === "create_invoice") {
    [booking] = await tx
      .select({
        id: partnerBookings.id,
        appointmentId: partnerBookings.appointmentId,
        totalCents: partnerRequestTotalSql,
      })
      .from(partnerBookings)
      .leftJoin(
        appointments,
        eq(appointments.id, partnerBookings.appointmentId),
      )
      .where(
        and(
          eq(partnerBookings.id, command.jobId),
          eq(partnerBookings.partnerAccountId, accountId),
        ),
      )
      .limit(1);
  } else {
    [invoice] = await tx
      .select()
      .from(partnerInvoices)
      .where(
        and(
          eq(partnerInvoices.id, command.invoiceId),
          eq(partnerInvoices.partnerAccountId, accountId),
        ),
      )
      .limit(1);
    if (invoice?.partnerBookingId)
      [booking] = await tx
        .select({
          id: partnerBookings.id,
          appointmentId: partnerBookings.appointmentId,
          totalCents: partnerRequestTotalSql,
        })
        .from(partnerBookings)
        .leftJoin(
          appointments,
          eq(appointments.id, partnerBookings.appointmentId),
        )
        .where(
          and(
            eq(partnerBookings.id, invoice.partnerBookingId),
            eq(partnerBookings.partnerAccountId, accountId),
          ),
        )
        .limit(1);
  }
  if (!booking)
    throw new TeamMutationFailure(
      "invalid",
      "Choose an account-owned job with a reconciled invoice binding.",
      { status: 404 },
    );
  const currentJob = await lockPartnerRequestFinancials(
    tx,
    accountId,
    booking.id,
  );
  booking.totalCents = currentJob.totalCents;
  if (command.action !== "create_invoice") {
    [invoice] = await tx
      .select()
      .from(partnerInvoices)
      .where(
        and(
          eq(partnerInvoices.id, command.invoiceId),
          eq(partnerInvoices.partnerAccountId, accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!invoice)
      throw new TeamMutationFailure("invalid", "Invoice not found.", {
        status: 404,
      });
    requireVersion(invoice.version, input.expectedVersion);
    if (
      invoice.providerInvoiceId ||
      invoice.hostedPaymentUrl ||
      invoice.providerOrderId
    )
      throw new TeamMutationFailure(
        "conflict",
        "This legacy hosted collection requires verified provider retirement and reconciliation before CRM billing changes.",
      );
  }
  await assertNoUnresolvedPayment(tx, booking);
  const now = new Date();
  if (
    command.action === "create_invoice" ||
    command.action === "revise_invoice"
  ) {
    const values = calculatePartnerInvoiceLines(
      command.lines,
      command.taxCents,
      command.discountCents,
    );
    if (booking.totalCents !== values.totalCents)
      throw new TeamMutationFailure(
        "conflict",
        "The invoice must match the approved or final job total. Update the job or change order first.",
      );
    if (command.depositCents > values.totalCents)
      throw new TeamMutationFailure(
        "invalid",
        "Deposit cannot exceed the invoice total.",
      );
    if (command.action === "create_invoice") {
      const [existing] = await tx
        .select({ id: partnerInvoices.id })
        .from(partnerInvoices)
        .where(
          and(
            eq(partnerInvoices.partnerAccountId, accountId),
            eq(partnerInvoices.partnerBookingId, booking.id),
            or(
              ne(partnerInvoices.status, "void"),
              isNotNull(partnerInvoices.providerInvoiceId),
              isNotNull(partnerInvoices.providerOrderId),
              isNotNull(partnerInvoices.hostedPaymentUrl),
              sql`${partnerInvoices.paidCents} > 0`,
            ),
          ),
        )
        .limit(1);
      if (existing)
        throw new TeamMutationFailure(
          "conflict",
          "This job already has an active invoice or an unretired hosted collection. Open that invoice instead.",
        );
    } else if (invoice?.status !== "draft")
      throw new TeamMutationFailure(
        "conflict",
        "Issued invoice lines are immutable. Record a credit or change order instead.",
      );
    const invoiceId = invoice?.id ?? randomUUID();
    const fields = {
      subtotalCents: values.subtotalCents,
      taxCents: command.taxCents,
      discountCents: command.discountCents,
      depositCents: command.depositCents,
      totalCents: values.totalCents,
      balanceCents: values.totalCents,
      poNumber: command.poNumber,
      costCenter: command.costCenter,
      billingContact: command.billingContact,
      terms: command.terms,
      dueDate: command.dueDate,
      version: (invoice?.version ?? 0) + 1,
      updatedAt: now,
    };
    if (invoice) {
      await tx
        .delete(partnerInvoiceLines)
        .where(eq(partnerInvoiceLines.partnerInvoiceId, invoiceId));
      await tx
        .update(partnerInvoices)
        .set(fields)
        .where(eq(partnerInvoices.id, invoiceId));
    } else
      await tx.insert(partnerInvoices).values({
        id: invoiceId,
        partnerAccountId: accountId,
        partnerBookingId: booking.id,
        invoiceNumber: `SG-${invoiceId.toUpperCase()}`,
        status: "draft",
        currency: "USD",
        ...fields,
      });
    await tx.insert(partnerInvoiceLines).values(
      values.lines.map((line, index) => ({
        partnerInvoiceId: invoiceId,
        lineNumber: index + 1,
        description: line.description,
        quantity: line.quantity,
        unitAmountCents: line.unitAmountCents,
        lineTotalCents: line.lineTotalCents,
      })),
    );
    return { invoiceId, revision: fields.version };
  }
  if (!invoice)
    throw new TeamMutationFailure("invalid", "Invoice not found.", {
      status: 404,
    });
  const base = { accountId, bookingId: booking.id, invoiceId: invoice.id };
  const notes = [
    invoice.poNumber ? `Purchase order: ${invoice.poNumber}` : "",
    invoice.costCenter ? `Cost center: ${invoice.costCenter}` : "",
    invoice.terms ?? "",
    invoice.dueDate ? `Payment due: ${invoice.dueDate}` : "",
  ].filter(Boolean);

  if (command.action === "record_manual_payment") {
    if (
      !(await loadPartnerStaffInvitationAuthority(tx, input.actorId, [
        "partners.commercial.manage",
        "payments.collect",
      ]))
    )
      throw new TeamMutationFailure(
        "forbidden",
        "Your permission to record payments is no longer available.",
      );
    if (currentJob.modelVersion !== 2 || booking.appointmentId)
      throw new TeamMutationFailure(
        "conflict",
        "Record this legacy job's cash or check payment from its appointment.",
      );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('payment_client_request'), hashtext(${command.clientRequestId}))`,
    );
    const providerPaymentId = `manual:${command.clientRequestId}`;
    const [existing] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.provider, "manual"),
          eq(payments.providerPaymentId, providerPaymentId),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        existing.partnerAccountId !== accountId ||
        existing.partnerBookingId !== booking.id ||
        existing.appointmentId !== null ||
        existing.metadata?.["invoiceId"] !== invoice.id ||
        existing.amount !== command.amountCents ||
        existing.method !== command.method ||
        (existing.metadata?.["reference"] ?? null) !== command.reference ||
        existing.canonicalStatus !== "completed"
      )
        throw new TeamMutationFailure(
          "conflict",
          "This payment reference already belongs to another recorded operation. Retry the original payment.",
        );
      return {
        invoiceId: invoice.id,
        paymentId: existing.id,
        revision: invoice.version,
        replayed: true,
      };
    }
    if (
      !invoice.issuedAt ||
      !["issued", "partially_paid", "overdue"].includes(invoice.status) ||
      invoice.currency !== "USD"
    )
      throw new TeamMutationFailure(
        "conflict",
        "Issue and review this invoice before recording a received payment.",
      );
    await reconcilePartnerAppointmentInvoices(tx, {
      bookingId: booking.id,
      accountId,
    });
    const [current] = await tx
      .select()
      .from(partnerInvoices)
      .where(
        and(
          eq(partnerInvoices.id, invoice.id),
          eq(partnerInvoices.partnerAccountId, accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current)
      throw new TeamMutationFailure(
        "conflict",
        "Refresh this invoice before recording payment.",
      );
    requireVersion(current.version, input.expectedVersion);
    if (current.balanceCents <= 0 || command.amountCents > current.balanceCents)
      throw new TeamMutationFailure(
        "conflict",
        "The received amount exceeds this invoice's remaining balance. Review the payment before saving.",
      );
    const [payment] = await tx
      .insert(payments)
      .values({
        provider: "manual",
        providerPaymentId,
        partnerAccountId: accountId,
        partnerBookingId: booking.id,
        appointmentId: null,
        amount: command.amountCents,
        jobAmountCents: command.amountCents,
        totalAmountCents: command.amountCents,
        tipCents: 0,
        currency: "USD",
        status: "completed",
        canonicalStatus: "completed",
        providerStatus: "completed",
        method: command.method,
        tenderType: command.method,
        initiatedByMemberId: input.actorId,
        metadata: {
          clientRequestId: command.clientRequestId,
          invoiceId: invoice.id,
          reference: command.reference,
          note: command.reason,
        },
        paidAt: now,
        capturedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: payments.id });
    if (!payment) throw new Error("partner_manual_payment_not_recorded");
    await reconcilePartnerAppointmentInvoices(tx, {
      bookingId: booking.id,
      accountId,
    });
    const [settled] = await tx
      .select()
      .from(partnerInvoices)
      .where(eq(partnerInvoices.id, invoice.id))
      .limit(1);
    const [allocation] = await tx
      .select({ amount: partnerPaymentAllocations.amountCents })
      .from(partnerPaymentAllocations)
      .where(
        and(
          eq(partnerPaymentAllocations.partnerAccountId, accountId),
          eq(partnerPaymentAllocations.partnerInvoiceId, invoice.id),
          eq(partnerPaymentAllocations.paymentId, payment.id),
          eq(partnerPaymentAllocations.state, "settled"),
        ),
      )
      .limit(1);
    if (
      !settled ||
      allocation?.amount !== command.amountCents ||
      settled.balanceCents !== current.balanceCents - command.amountCents
    )
      throw new Error("partner_manual_payment_reconciliation_failed");
    return {
      invoiceId: invoice.id,
      paymentId: payment.id,
      revision: settled.version,
    };
  }

  if (command.action === "issue_invoice") {
    if (invoice.status !== "draft" || invoice.totalCents !== booking.totalCents)
      throw new TeamMutationFailure(
        "conflict",
        "Only a reviewed draft matching the job total can be issued.",
      );
    const lines = await tx
      .select()
      .from(partnerInvoiceLines)
      .where(eq(partnerInvoiceLines.partnerInvoiceId, invoice.id))
      .orderBy(asc(partnerInvoiceLines.lineNumber));
    if (
      lines.length === 0 ||
      lines.reduce((sum, line) => sum + line.lineTotalCents, 0) !==
        invoice.subtotalCents
    )
      throw new TeamMutationFailure(
        "conflict",
        "The invoice lines need reconciliation before issue.",
      );
    await tx
      .update(partnerInvoices)
      .set({
        status: "issued",
        issuedAt: now,
        version: invoice.version + 1,
        updatedAt: now,
      })
      .where(eq(partnerInvoices.id, invoice.id));
    await reconcilePartnerAppointmentInvoices(
      tx,
      booking.appointmentId ?? { bookingId: booking.id, accountId },
    );
    const [issued] = await tx
      .select()
      .from(partnerInvoices)
      .where(eq(partnerInvoices.id, invoice.id));
    const operationId = await queuePartnerBillingDocument(tx, {
      ...base,
      sourceKey: invoice.id,
      kind: "invoice",
      snapshot: {
        title: "Invoice",
        number: invoice.invoiceNumber,
        accountName: account.name,
        issuedAt: now.toISOString(),
        currency: "USD",
        lines: lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          amountCents: line.lineTotalCents,
        })),
        totals: [
          { label: "Subtotal", amountCents: invoice.subtotalCents },
          { label: "Tax", amountCents: invoice.taxCents },
          { label: "Discount", amountCents: -invoice.discountCents },
          { label: "Invoice total", amountCents: invoice.totalCents },
          { label: "Paid", amountCents: issued?.paidCents ?? 0 },
          {
            label: "Balance due",
            amountCents: issued?.balanceCents ?? invoice.totalCents,
          },
        ],
        notes,
      },
    });
    return {
      invoiceId: invoice.id,
      revision: issued?.version ?? invoice.version + 1,
      operationId,
    };
  }
  if (
    command.action === "credit_invoice" ||
    command.action === "void_invoice"
  ) {
    const voiding = command.action === "void_invoice";
    if (
      invoice.status === "void" ||
      (!voiding && invoice.status === "draft") ||
      (voiding && invoice.paidCents > 0)
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "This invoice cannot be credited or voided in its current state. Reconcile payments first.",
      );
    }
    const amountCents = voiding ? invoice.balanceCents : command.amountCents;
    if (amountCents <= 0 || amountCents > invoice.balanceCents)
      throw new TeamMutationFailure(
        "invalid",
        "Credit cannot exceed the unpaid invoice balance. Refund any settled payment separately.",
      );
    const creditId = randomUUID();
    // Drafts were never invoiced; voiding them does not create statement credit.
    if (invoice.status !== "draft")
      await tx.insert(partnerInvoiceCredits).values({
        id: creditId,
        partnerAccountId: accountId,
        partnerInvoiceId: invoice.id,
        amountCents,
        reason: command.reason,
        kind: voiding ? "void" : "credit",
        createdBy: input.actorId,
        createdAt: now,
      });
    const balanceCents = invoice.balanceCents - amountCents;
    await tx
      .update(partnerInvoices)
      .set({
        creditedCents: invoice.creditedCents + amountCents,
        balanceCents,
        status: voiding ? "void" : balanceCents === 0 ? "paid" : invoice.status,
        voidedAt: voiding ? now : invoice.voidedAt,
        version: invoice.version + 1,
        updatedAt: now,
      })
      .where(eq(partnerInvoices.id, invoice.id));
    if (invoice.status === "draft")
      return { invoiceId: invoice.id, revision: invoice.version + 1 };
    const operationId = await queuePartnerBillingDocument(tx, {
      ...base,
      sourceKey: creditId,
      kind: voiding ? "void" : "credit",
      snapshot: {
        title: voiding ? "Voided invoice" : "Credit note",
        number: invoice.invoiceNumber,
        accountName: account.name,
        issuedAt: now.toISOString(),
        currency: "USD",
        lines: [{ description: command.reason, amountCents }],
        totals: [
          { label: "Credit", amountCents },
          { label: "Remaining balance", amountCents: balanceCents },
        ],
        notes: [
          "This document adjusts the bill. It does not itself send a payment refund.",
          ...notes,
        ],
      },
    });
    return {
      invoiceId: invoice.id,
      revision: invoice.version + 1,
      creditId,
      operationId,
    };
  }
  return createRefund(tx, {
    ...base,
    accountName: account.name,
    actorId: input.actorId,
    appointmentId: booking.appointmentId,
    invoice,
    command,
    now,
  });
}

async function createRefund(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    accountName: string;
    invoiceId: string;
    bookingId: string;
    appointmentId: string | null;
    actorId: string;
    invoice: typeof partnerInvoices.$inferSelect;
    now: Date;
    command: Extract<
      PartnerBillingCommand,
      { action: "refund_payment" | "record_manual_refund" }
    >;
  },
) {
  const { command } = input;
  const [payment] = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.id, command.paymentId),
        input.appointmentId
          ? eq(payments.appointmentId, input.appointmentId)
          : and(
              eq(payments.partnerBookingId, input.bookingId),
              eq(payments.partnerAccountId, input.accountId),
            ),
      ),
    )
    .for("update")
    .limit(1);
  const [allocation] = await tx
    .select()
    .from(partnerPaymentAllocations)
    .where(
      and(
        eq(partnerPaymentAllocations.partnerAccountId, input.accountId),
        eq(partnerPaymentAllocations.partnerInvoiceId, input.invoiceId),
        eq(partnerPaymentAllocations.paymentId, command.paymentId),
        eq(partnerPaymentAllocations.state, "settled"),
      ),
    )
    .limit(1);
  if (
    !payment ||
    !allocation ||
    payment.canonicalStatus !== "completed" ||
    payment.currency !== "USD"
  )
    throw new TeamMutationFailure(
      "conflict",
      "Only a settled, invoice-linked payment can be refunded.",
    );
  const pending = await tx
    .select({
      amount: partnerBillingRefundRequests.amountCents,
      invoiceId: partnerBillingRefundRequests.partnerInvoiceId,
    })
    .from(partnerBillingRefundRequests)
    .where(
      and(
        eq(partnerBillingRefundRequests.paymentId, payment.id),
        inArray(partnerBillingRefundRequests.status, [
          "queued",
          "submitted",
          "needs_review",
        ]),
      ),
    );
  const reserved = pending.reduce((sum, row) => sum + row.amount, 0);
  const [untrackedPending] = await tx
    .select({ id: paymentRefunds.id })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.paymentId, payment.id),
        sql`upper(${paymentRefunds.providerStatus}) NOT IN ('COMPLETED', 'FAILED', 'REJECTED')`,
      ),
    )
    .limit(1);
  if (untrackedPending)
    throw new TeamMutationFailure(
      "conflict",
      "A provider refund is pending. Reconcile it before requesting another refund.",
    );
  const remaining =
    (payment.totalAmountCents ?? payment.amount) -
    payment.refundedAmountCents -
    reserved;
  if (command.amountCents > remaining)
    throw new TeamMutationFailure(
      "conflict",
      "That amount is already refunded or reserved by a pending refund.",
    );
  const completedRefunds = await tx
    .select({ id: paymentRefunds.id, job: paymentRefunds.jobAmountCents })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.paymentId, payment.id),
        eq(paymentRefunds.canonicalStatus, "completed"),
      ),
    );
  const activeAllocations = await tx
    .select({ invoiceId: partnerPaymentAllocations.partnerInvoiceId })
    .from(partnerPaymentAllocations)
    .where(
      and(
        eq(partnerPaymentAllocations.paymentId, payment.id),
        eq(partnerPaymentAllocations.state, "settled"),
      ),
    );
  const splits = completedRefunds.length
    ? await tx
        .select()
        .from(partnerRefundAllocations)
        .where(
          inArray(
            partnerRefundAllocations.refundId,
            completedRefunds.map((row) => row.id),
          ),
        )
    : [];
  const refundedPrincipal = completedRefunds.reduce(
    (sum, row) => sum + row.job,
    0,
  );
  if (
    activeAllocations.length > 1 &&
    splits.reduce((sum, row) => sum + row.jobAmountCents, 0) !==
      refundedPrincipal
  )
    throw new TeamMutationFailure(
      "conflict",
      "Reconcile the existing refund allocations before requesting another refund.",
    );
  const priorInvoiceRefund =
    activeAllocations.length === 1
      ? refundedPrincipal
      : splits
          .filter((row) => row.partnerInvoiceId === input.invoiceId)
          .reduce((sum, row) => sum + row.jobAmountCents, 0);
  const nextRefundPrincipal = Math.min(
    command.amountCents,
    Math.max(0, (payment.jobAmountCents ?? 0) - refundedPrincipal),
  );
  const reservedForInvoice = pending
    .filter((row) => row.invoiceId === input.invoiceId)
    .reduce((sum, row) => sum + row.amount, 0);
  if (
    nextRefundPrincipal + reservedForInvoice >
    allocation.amountCents - priorInvoiceRefund
  )
    throw new TeamMutationFailure(
      "conflict",
      "That refund exceeds the settled service payment allocated to this invoice. Choose the invoice receiving those funds.",
    );
  if (command.action === "refund_payment") {
    if (payment.provider !== "square" || !payment.providerPaymentId)
      throw new TeamMutationFailure(
        "invalid",
        "Use the separate cash/check refund record for a manual payment.",
      );
    const id = randomUUID();
    await tx.insert(partnerBillingRefundRequests).values({
      id,
      partnerAccountId: input.accountId,
      partnerInvoiceId: input.invoiceId,
      paymentId: payment.id,
      amountCents: command.amountCents,
      reason: command.reason,
      requestedBy: input.actorId,
    });
    await tx.insert(outboxEvents).values({
      type: "partner.billing.refund.submit",
      payload: { operationId: id },
    });
    return {
      invoiceId: input.invoiceId,
      revision: input.invoice.version,
      refundRequestId: id,
    };
  }
  if (payment.provider !== "manual")
    throw new TeamMutationFailure(
      "invalid",
      "Online payments must be refunded to their original payment method.",
    );
  const prior = await tx
    .select({
      job: paymentRefunds.jobAmountCents,
      tip: paymentRefunds.tipCents,
    })
    .from(paymentRefunds)
    .where(
      and(
        eq(paymentRefunds.paymentId, payment.id),
        eq(paymentRefunds.canonicalStatus, "completed"),
      ),
    );
  const allocationAmounts = allocateRefund({
    jobAmountCents: Math.max(
      0,
      (payment.jobAmountCents ?? 0) -
        prior.reduce((sum, row) => sum + row.job, 0),
    ),
    tipCents: Math.max(
      0,
      payment.tipCents - prior.reduce((sum, row) => sum + row.tip, 0),
    ),
    refundedAmountCents: command.amountCents,
  });
  const refundId = randomUUID();
  await tx.insert(paymentRefunds).values({
    id: refundId,
    paymentId: payment.id,
    provider: "manual",
    providerRefundId: refundId,
    amountCents: command.amountCents,
    jobAmountCents: allocationAmounts.refundedJobCents,
    tipCents: allocationAmounts.refundedTipCents,
    currency: "USD",
    canonicalStatus: "completed",
    providerStatus: "COMPLETED",
    reason: command.reason,
    refundedAt: input.now,
  });
  await tx
    .update(payments)
    .set({
      refundedAmountCents: payment.refundedAmountCents + command.amountCents,
      updatedAt: input.now,
    })
    .where(eq(payments.id, payment.id));
  if (allocationAmounts.refundedJobCents > 0)
    await tx.insert(partnerRefundAllocations).values({
      partnerAccountId: input.accountId,
      partnerInvoiceId: input.invoiceId,
      refundId,
      jobAmountCents: allocationAmounts.refundedJobCents,
    });
  await reconcilePartnerAppointmentInvoices(
    tx,
    input.appointmentId ?? {
      bookingId: input.bookingId,
      accountId: input.accountId,
    },
  );
  const [operation] = await tx
    .select({ id: partnerBillingDocumentOperations.id })
    .from(partnerBillingDocumentOperations)
    .where(
      and(
        eq(partnerBillingDocumentOperations.partnerAccountId, input.accountId),
        eq(partnerBillingDocumentOperations.documentType, "refund"),
        inArray(partnerBillingDocumentOperations.sourceKey, [
          refundId,
          `${refundId}/${input.invoiceId}`,
        ]),
      ),
    )
    .limit(1);
  return {
    invoiceId: input.invoiceId,
    ...(operation ? { operationId: operation.id } : {}),
  };
}

async function generateStatement(
  tx: TeamMutationTransaction,
  accountId: string,
  account: { name: string; timezone: string },
  command: Extract<PartnerBillingCommand, { action: "generate_statement" }>,
) {
  const start = DateTime.fromISO(command.periodStart, {
    zone: account.timezone,
  }).startOf("day");
  const end = DateTime.fromISO(command.periodEnd, { zone: account.timezone })
    .plus({ days: 1 })
    .startOf("day");
  if (
    !start.isValid ||
    !end.isValid ||
    end <= start ||
    end.diff(start, "days").days > 366
  )
    throw new TeamMutationFailure(
      "invalid",
      "Choose a valid statement period of at most one year.",
    );
  const invoices = await tx
    .select()
    .from(partnerInvoices)
    .where(
      and(
        eq(partnerInvoices.partnerAccountId, accountId),
        eq(partnerInvoices.currency, "USD"),
        isNotNull(partnerInvoices.issuedAt),
        lt(partnerInvoices.issuedAt, end.toJSDate()),
      ),
    );
  const ids = invoices.map((invoice) => invoice.id);
  const allocations = ids.length
    ? await tx
        .select({
          amount: partnerPaymentAllocations.amountCents,
          at: partnerPaymentAllocations.allocatedAt,
          paymentId: partnerPaymentAllocations.paymentId,
          invoiceId: partnerPaymentAllocations.partnerInvoiceId,
        })
        .from(partnerPaymentAllocations)
        .innerJoin(
          payments,
          eq(payments.id, partnerPaymentAllocations.paymentId),
        )
        .innerJoin(
          partnerInvoices,
          eq(partnerInvoices.id, partnerPaymentAllocations.partnerInvoiceId),
        )
        .innerJoin(
          partnerBookings,
          and(
            eq(partnerBookings.id, partnerInvoices.partnerBookingId),
            eq(
              partnerBookings.partnerAccountId,
              partnerInvoices.partnerAccountId,
            ),
            or(
              eq(partnerBookings.appointmentId, payments.appointmentId),
              and(
                eq(partnerBookings.id, payments.partnerBookingId),
                eq(partnerBookings.partnerAccountId, payments.partnerAccountId),
              ),
            ),
          ),
        )
        .where(
          and(
            inArray(partnerPaymentAllocations.partnerInvoiceId, ids),
            eq(payments.canonicalStatus, "completed"),
            eq(payments.currency, "USD"),
            eq(partnerPaymentAllocations.partnerAccountId, accountId),
            eq(partnerPaymentAllocations.state, "settled"),
          ),
        )
    : [];
  const paymentIds = [...new Set(allocations.map((row) => row.paymentId))];
  const refundRows = paymentIds.length
    ? await tx
        .select({
          id: paymentRefunds.id,
          providerRefundId: paymentRefunds.providerRefundId,
          jobAmountCents: paymentRefunds.jobAmountCents,
          amount: paymentRefunds.jobAmountCents,
          at: paymentRefunds.refundedAt,
          paymentId: paymentRefunds.paymentId,
        })
        .from(paymentRefunds)
        .where(
          and(
            inArray(paymentRefunds.paymentId, paymentIds),
            sql`upper(${paymentRefunds.providerStatus}) = 'COMPLETED'`,
          ),
        )
    : [];
  const refundSplits = await resolvePartnerRefundAllocations(tx, {
    persist: false,
    allocations: allocations.map((row) => ({
      partnerAccountId: accountId,
      partnerInvoiceId: row.invoiceId,
      paymentId: row.paymentId,
      amountCents: row.amount,
      state: "settled",
    })),
    refunds: refundRows,
  });
  // The resolver verifies the COMPLETE refund against its immutable payment
  // evidence first. A statement is only a projection of its included invoices:
  // a later-issued invoice's split must not enter an earlier statement without
  // that invoice or its matching payment allocation.
  const statementInvoiceIds = new Set(ids);
  const refunds = refundSplits
    .filter((row) => statementInvoiceIds.has(row.partnerInvoiceId))
    .map((row) => ({
      amount: row.jobAmountCents,
      invoiceId: row.partnerInvoiceId,
      paymentId: refundRows.find((refund) => refund.id === row.refundId)!
        .paymentId,
      at: refundRows.find((refund) => refund.id === row.refundId)!.at,
    }));
  const credits = ids.length
    ? await tx
        .select({
          amount: partnerInvoiceCredits.amountCents,
          at: partnerInvoiceCredits.createdAt,
          invoiceId: partnerInvoiceCredits.partnerInvoiceId,
        })
        .from(partnerInvoiceCredits)
        .where(inArray(partnerInvoiceCredits.partnerInvoiceId, ids))
    : [];
  for (const invoice of invoices) {
    const applied = allocations.filter((row) => row.invoiceId === invoice.id);
    const refunded = refunds
      .filter((row) => row.invoiceId === invoice.id)
      .reduce((sum, row) => sum + row.amount, 0);
    const paid = applied.reduce((sum, row) => sum + row.amount, 0) - refunded;
    const credited = credits
      .filter((row) => row.invoiceId === invoice.id)
      .reduce((sum, row) => sum + row.amount, 0);
    if (invoice.paidCents !== paid || invoice.creditedCents !== credited)
      throw new TeamMutationFailure(
        "conflict",
        "Invoice history needs payment or credit reconciliation before this statement can be generated.",
      );
  }
  const movement = (rows: Array<{ amount: number; at: Date | null }>) => ({
    before: rows
      .filter((row) => row.at && row.at < start.toJSDate())
      .reduce((sum, row) => sum + row.amount, 0),
    current: rows
      .filter(
        (row) =>
          row.at && row.at >= start.toJSDate() && row.at < end.toJSDate(),
      )
      .reduce((sum, row) => sum + row.amount, 0),
  });
  const issued = movement(
    invoices.map((row) => ({ amount: row.totalCents, at: row.issuedAt })),
  );
  const paid = movement(allocations);
  const refunded = movement(refunds);
  const credited = movement(credits);
  const openingBalanceCents =
    issued.before + refunded.before - paid.before - credited.before;
  const closingBalanceCents =
    openingBalanceCents +
    issued.current +
    refunded.current -
    paid.current -
    credited.current;
  const sourceKey = `${command.periodStart}/${command.periodEnd}/USD`;
  const [latest] = await tx
    .select({ version: partnerBillingDocumentOperations.version })
    .from(partnerBillingDocumentOperations)
    .where(
      and(
        eq(partnerBillingDocumentOperations.partnerAccountId, accountId),
        eq(partnerBillingDocumentOperations.documentType, "statement"),
        eq(partnerBillingDocumentOperations.sourceKey, sourceKey),
      ),
    )
    .orderBy(desc(partnerBillingDocumentOperations.version))
    .limit(1);
  const [stored] = await tx
    .select({ revision: partnerStatements.revision })
    .from(partnerStatements)
    .where(
      and(
        eq(partnerStatements.partnerAccountId, accountId),
        eq(partnerStatements.periodStart, command.periodStart),
        eq(partnerStatements.periodEnd, command.periodEnd),
        eq(partnerStatements.currency, "USD"),
      ),
    )
    .orderBy(desc(partnerStatements.revision))
    .limit(1);
  const revision = Math.max(stored?.revision ?? 0, latest?.version ?? 0) + 1;
  const activity = [
    ...invoices.map((row) => ({
      amount: row.totalCents,
      at: row.issuedAt,
      label: `Invoice ${row.invoiceNumber}`,
    })),
    ...allocations.map((row) => ({ ...row, label: "Payment received" })),
    ...refunds.map((row) => ({ ...row, label: "Payment refunded" })),
    ...credits.map((row) => ({ ...row, label: "Invoice credit" })),
  ]
    .filter(
      (row) => row.at && row.at >= start.toJSDate() && row.at < end.toJSDate(),
    )
    .sort((a, b) => a.at!.getTime() - b.at!.getTime());
  if (activity.length > 500)
    throw new TeamMutationFailure(
      "invalid",
      "Choose a shorter statement period with at most 500 entries.",
    );
  const snapshot: PartnerBillingDocumentSnapshot = {
    title: "Statement",
    number: `${command.periodStart}–${command.periodEnd}-v${revision}`,
    accountName: account.name,
    issuedAt: new Date().toISOString(),
    currency: "USD",
    lines: activity.map((row) => ({
      description: `${DateTime.fromJSDate(row.at!, { zone: account.timezone }).toISODate()} — ${row.label}`,
      amountCents: row.amount,
    })),
    totals: [
      { label: "Opening balance", amountCents: openingBalanceCents },
      { label: "Invoices", amountCents: issued.current },
      { label: "Payments", amountCents: -paid.current },
      { label: "Refunds", amountCents: refunded.current },
      { label: "Credits", amountCents: -credited.current },
      { label: "Closing balance", amountCents: closingBalanceCents },
    ],
    notes: [
      `Period: ${command.periodStart} through ${command.periodEnd} (${account.timezone}).`,
      "Pending payments are excluded until settlement.",
    ],
    statement: {
      periodStart: command.periodStart,
      periodEnd: command.periodEnd,
      revision,
      openingBalanceCents,
      invoiceCents: issued.current,
      paymentCents: paid.current,
      refundCents: refunded.current,
      creditCents: credited.current,
      closingBalanceCents,
    },
  };
  const operationId = await queuePartnerBillingDocument(tx, {
    accountId,
    bookingId: null,
    invoiceId: null,
    sourceKey,
    kind: "statement",
    snapshot,
  });
  return { operationId, revision };
}
