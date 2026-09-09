import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
  teamMembers,
  partnerAllocationReconciliations,
} from "@/db";
import {
  lockAppointmentInvoiceCollection,
  reconcilePartnerAppointmentInvoices,
} from "@/lib/partner-invoice-ledger";
import {
  readPartnerAllocationReconciliation,
  reconcilePartnerPaymentAllocations,
} from "@/lib/partner-allocation-reconciliation";
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
    invoiceId = randomUUID();
  await getDb().transaction(async (tx) => {
    await tx
      .insert(partnerAccounts)
      .values({
        id: accountId,
        name: "Local historical scalar test",
        normalizedName: accountId,
        status: "active_partner",
        portalAccessEnabled: true,
      });
    await tx
      .insert(contacts)
      .values({ id: contactId, firstName: "Local", lastName: "Scalar" });
    await tx
      .insert(properties)
      .values({
        id: propertyId,
        contactId,
        addressLine1: "1 Local Test Way",
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
      .insert(partnerInvoices)
      .values({
        id: invoiceId,
        partnerAccountId: accountId,
        partnerBookingId: jobId,
        invoiceNumber: `LOCAL-${invoiceId}`,
        status: "partially_paid",
        currency: "USD",
        subtotalCents: 20000,
        totalCents: 20000,
        paidCents: 10000,
        balanceCents: 10000,
        issuedAt: new Date(),
        billingContact: {},
      });
  });
  async function payment(amount: number, allocated: boolean) {
    const id = randomUUID();
    await getDb().transaction(async (tx) => {
      await tx
        .insert(payments)
        .values({
          id,
          appointmentId,
          provider: "manual",
          providerPaymentId: id,
          amount: amount + 500,
          jobAmountCents: amount,
          tipCents: 500,
          totalAmountCents: amount + 500,
          currency: "USD",
          method: "cash",
          tenderType: "cash",
          status: "completed",
          canonicalStatus: "completed",
          providerStatus: "COMPLETED",
        });
      if (allocated)
        await tx
          .insert(partnerPaymentAllocations)
          .values({
            partnerAccountId: accountId,
            partnerInvoiceId: invoiceId,
            paymentId: id,
            amountCents: amount,
            state: "settled",
          });
    });
    return id;
  }
  const read = async () =>
    (
      await getDb()
        .select()
        .from(partnerInvoices)
        .where(eq(partnerInvoices.id, invoiceId))
    )[0]!;
  const sync = () =>
    getDb().transaction(async (tx) => {
      await lockAppointmentInvoiceCollection(tx, appointmentId);
      await reconcilePartnerAppointmentInvoices(tx, appointmentId);
    });
  return { accountId, appointmentId, jobId, invoiceId, payment, read, sync };
}
suite("partial historical paid scalar preservation / real PostgreSQL", () => {
  afterAll(closeDbForTests);
  it("does not reopen a partially supported historical paid balance", async () => {
    const f = await fixture();
    await f.payment(4000, true);
    const before = await f.read();
    await expect(f.sync()).rejects.toThrow(
      "historical_payment_reconciliation_required",
    );
    expect(await f.read()).toEqual(before);
  });
  it("does not let new automatic allocations substitute for missing old payment evidence", async () => {
    const f = await fixture();
    await f.payment(4000, false);
    const before = await f.read();
    await expect(f.sync()).rejects.toThrow(
      "historical_payment_reconciliation_required",
    );
    expect(await f.read()).toEqual(before);
    expect(
      await getDb()
        .select()
        .from(partnerPaymentAllocations)
        .where(eq(partnerPaymentAllocations.partnerInvoiceId, f.invoiceId)),
    ).toHaveLength(0);
  });
  it("still applies genuine completed service refunds and safely replays them", async () => {
    const f = await fixture(),
      paymentId = await f.payment(10000, true);
    await getDb()
      .insert(paymentRefunds)
      .values({
        paymentId,
        provider: "manual",
        providerRefundId: randomUUID(),
        amountCents: 2250,
        jobAmountCents: 2000,
        tipCents: 250,
        currency: "USD",
        canonicalStatus: "completed",
        providerStatus: "COMPLETED",
        refundedAt: new Date(),
      });
    const originalPayment = await getDb()
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    await f.sync();
    await f.sync();
    expect(await f.read()).toMatchObject({
      paidCents: 8000,
      balanceCents: 12000,
      totalCents: 20000,
      status: "partially_paid",
    });
    expect(
      await getDb().select().from(payments).where(eq(payments.id, paymentId)),
    ).toEqual(originalPayment);
  });
  it("permits the exact audited repair after genuine missing allocations are supplied", async () => {
    const f = await fixture(),
      partial = await f.payment(4000, true),
      missing = await f.payment(6000, false),
      actorId = randomUUID();
    await getDb()
      .insert(teamMembers)
      .values({
        id: actorId,
        name: "Local reconciliation supervisor",
        email: `${actorId}@example.test`,
        active: true,
      });
    const before = await getDb().transaction((tx) =>
      readPartnerAllocationReconciliation(tx, f.accountId, f.jobId),
    );
    const originalPayments = await getDb()
      .select()
      .from(payments)
      .where(eq(payments.appointmentId, f.appointmentId));
    await getDb().transaction((tx) =>
      reconcilePartnerPaymentAllocations(tx, {
        accountId: f.accountId,
        jobId: f.jobId,
        actorId,
        correlationId: randomUUID(),
        expectedVersion: before.revision,
        command: {
          reason: "Original cash receipts prove the historical paid amount",
          evidenceReference: "Synthetic local receipt records",
          payments: [
            {
              paymentId: partial,
              allocations: [
                { invoiceId: f.invoiceId, grossAmountCents: 4000, refunds: [] },
              ],
            },
            {
              paymentId: missing,
              allocations: [
                { invoiceId: f.invoiceId, grossAmountCents: 6000, refunds: [] },
              ],
            },
          ],
        },
      }),
    );
    await f.sync();
    expect(await f.read()).toMatchObject({
      paidCents: 10000,
      balanceCents: 10000,
    });
    expect(
      await getDb()
        .select()
        .from(partnerAllocationReconciliations)
        .where(eq(partnerAllocationReconciliations.partnerBookingId, f.jobId)),
    ).toHaveLength(2);
    expect(
      await getDb()
        .select()
        .from(payments)
        .where(eq(payments.appointmentId, f.appointmentId)),
    ).toEqual(originalPayments);
  });
});
