import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  closeDbForTests,
  partnerAccounts,
  contacts,
  properties,
  appointments,
  partnerBookings,
  partnerInvoices,
  payments,
  paymentRefunds,
  partnerPaymentAllocations,
  partnerRefundAllocations,
  partnerBillingDocumentOperations,
  teamMembers,
} from "@/db";
import { runPartnerBillingCommand } from "@/lib/partner-billing-administration";

const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
async function fixture() {
  const accountId = randomUUID(),
    contactId = randomUUID(),
    propertyId = randomUUID(),
    appointmentId = randomUUID(),
    jobId = randomUUID(),
    earlyInvoiceId = randomUUID(),
    laterInvoiceId = randomUUID(),
    paymentId = randomUUID(),
    refundId = randomUUID(),
    actorId = randomUUID();
  await getDb().transaction(async (tx) => {
    await tx
      .insert(partnerAccounts)
      .values({
        id: accountId,
        name: "Local statement period test",
        normalizedName: accountId,
        status: "active_partner",
        portalAccessEnabled: true,
      });
    await tx
      .insert(contacts)
      .values({ id: contactId, firstName: "Local", lastName: "Statement" });
    await tx
      .insert(properties)
      .values({
        id: propertyId,
        contactId,
        addressLine1: "1 Synthetic Way",
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
      });
    await tx
      .insert(appointments)
      .values({
        id: appointmentId,
        partnerAccountId: accountId,
        contactId,
        propertyId,
        status: "completed",
        type: "job",
        finalTotalCents: 20000,
        rescheduleToken: randomUUID(),
      });
    await tx
      .insert(partnerBookings)
      .values({
        id: jobId,
        partnerAccountId: accountId,
        appointmentId,
        orgContactId: contactId,
        propertyId,
        publicStatus: "completed",
      });
    await tx
      .insert(teamMembers)
      .values({
        id: actorId,
        name: "Local statement reader",
        email: `${actorId}@example.test`,
        active: true,
      });
    await tx.insert(partnerInvoices).values(
      [
        {
          id: earlyInvoiceId,
          paidCents: 9000,
          balanceCents: 1000,
          issuedAt: new Date("2026-06-01T14:00:00Z"),
        },
        {
          id: laterInvoiceId,
          paidCents: 8000,
          balanceCents: 2000,
          issuedAt: new Date("2026-07-01T14:00:00Z"),
        },
      ].map((row) => ({
        ...row,
        partnerAccountId: accountId,
        partnerBookingId: jobId,
        invoiceNumber: `LOCAL-${row.id}`,
        status: "partially_paid" as const,
        currency: "USD",
        subtotalCents: 10000,
        totalCents: 10000,
        creditedCents: 0,
        billingContact: {},
      })),
    );
    await tx
      .insert(payments)
      .values({
        id: paymentId,
        appointmentId,
        provider: "manual",
        providerPaymentId: paymentId,
        amount: 20500,
        jobAmountCents: 20000,
        tipCents: 500,
        totalAmountCents: 20500,
        refundedAmountCents: 3000,
        currency: "USD",
        method: "cash",
        tenderType: "cash",
        status: "completed",
        canonicalStatus: "completed",
        providerStatus: "COMPLETED",
        capturedAt: new Date("2026-06-15T14:00:00Z"),
      });
    await tx
      .insert(partnerPaymentAllocations)
      .values(
        [earlyInvoiceId, laterInvoiceId].map((invoiceId) => ({
          partnerAccountId: accountId,
          partnerInvoiceId: invoiceId,
          paymentId,
          amountCents: 10000,
          state: "settled" as const,
          allocatedAt: new Date("2026-06-15T14:00:00Z"),
        })),
      );
    await tx
      .insert(paymentRefunds)
      .values({
        id: refundId,
        paymentId,
        provider: "manual",
        providerRefundId: refundId,
        amountCents: 3000,
        jobAmountCents: 3000,
        tipCents: 0,
        currency: "USD",
        canonicalStatus: "completed",
        providerStatus: "COMPLETED",
        refundedAt: new Date("2026-06-20T14:00:00Z"),
      });
    await tx.insert(partnerRefundAllocations).values(
      [
        { partnerInvoiceId: earlyInvoiceId, jobAmountCents: 1000 },
        { partnerInvoiceId: laterInvoiceId, jobAmountCents: 2000 },
      ].map((row) => ({ ...row, partnerAccountId: accountId, refundId })),
    );
  });
  async function statement(periodEnd = "2026-06-30") {
    await getDb().transaction((tx) =>
      runPartnerBillingCommand(tx, {
        accountId,
        actorId,
        expectedVersion: null,
        command: {
          action: "generate_statement",
          periodStart: "2026-06-01",
          periodEnd,
          reason: "Verify the historical invoice statement boundary",
        },
      }),
    );
    return getDb()
      .select()
      .from(partnerBillingDocumentOperations)
      .where(
        and(
          eq(partnerBillingDocumentOperations.partnerAccountId, accountId),
          eq(partnerBillingDocumentOperations.documentType, "statement"),
        ),
      );
  }
  return { accountId, paymentId, refundId, laterInvoiceId, statement };
}
suite("statement refund scope / actual PostgreSQL", () => {
  afterAll(closeDbForTests);
  it("does not import a later invoice's refund into an earlier invoice statement", async () => {
    const f = await fixture();
    const originalPayment = await getDb()
      .select()
      .from(payments)
      .where(eq(payments.id, f.paymentId));
    const originalSplits = await getDb()
      .select()
      .from(partnerRefundAllocations)
      .where(eq(partnerRefundAllocations.refundId, f.refundId));
    const [statement] = await f.statement();
    expect(statement?.snapshot).toMatchObject({
      statement: {
        openingBalanceCents: 0,
        invoiceCents: 10000,
        paymentCents: 10000,
        refundCents: 1000,
        closingBalanceCents: 1000,
      },
    });
    expect(
      await getDb().select().from(payments).where(eq(payments.id, f.paymentId)),
    ).toEqual(originalPayment);
    expect(
      await getDb()
        .select()
        .from(partnerRefundAllocations)
        .where(eq(partnerRefundAllocations.refundId, f.refundId)),
    ).toEqual(originalSplits);
  });
  it("includes both portions once both invoices are included", async () => {
    const f = await fixture(),
      [statement] = await f.statement("2026-07-31");
    expect(statement?.snapshot).toMatchObject({
      statement: {
        invoiceCents: 20000,
        paymentCents: 20000,
        refundCents: 3000,
        closingBalanceCents: 3000,
      },
    });
  });
  it("still rejects incomplete GLOBAL refund evidence before narrowing the statement projection", async () => {
    const f = await fixture();
    await getDb()
      .update(partnerRefundAllocations)
      .set({ jobAmountCents: 0 })
      .where(
        and(
          eq(partnerRefundAllocations.refundId, f.refundId),
          eq(partnerRefundAllocations.partnerInvoiceId, f.laterInvoiceId),
        ),
      );
    await expect(f.statement()).rejects.toThrow(
      "partner_refund_allocation_reconciliation_required",
    );
    expect(
      await getDb()
        .select()
        .from(partnerBillingDocumentOperations)
        .where(
          and(
            eq(partnerBillingDocumentOperations.partnerAccountId, f.accountId),
            eq(partnerBillingDocumentOperations.documentType, "statement"),
          ),
        ),
    ).toHaveLength(0);
  });
});
