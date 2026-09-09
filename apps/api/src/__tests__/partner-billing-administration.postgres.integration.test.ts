import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { appointments, closeDbForTests, contacts, getDb, partnerAccounts, partnerBillingDocumentOperations,
  partnerBillingRefundRequests, partnerBookings, partnerInvoiceCredits, partnerInvoiceLines, partnerInvoices, payments, properties, teamMembers } from "@/db";
import { runPartnerBillingCommand, type PartnerBillingCommand } from "@/lib/partner-billing-administration";
import { getAppointmentPaymentSummary } from "@/lib/payment-ledger";
import { lockAppointmentInvoiceCollection, reconcilePartnerAppointmentInvoices } from "@/lib/partner-invoice-ledger";
import { hasPartnerInvoiceAccess } from "@/lib/partner-invoice-access";

const databaseUrl = process.env["DATABASE_URL"];
const local = databaseUrl && ["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname);
const describeLocal = local ? describe : describe.skip;
async function fixture() {
  const ids = { accountId: randomUUID(), jobId: randomUUID(), appointmentId: randomUUID(), contactId: randomUUID(), propertyId: randomUUID(), actorId: randomUUID() };
  await getDb().transaction(async (tx) => {
    await tx.insert(teamMembers).values({ id: ids.actorId, name: "Local billing test", active: true });
    await tx.insert(partnerAccounts).values({ id: ids.accountId, name: "Local billing company", normalizedName: `billing-${ids.accountId}`, status: "active_partner", portalAccessEnabled: true });
    await tx.insert(contacts).values({ id: ids.contactId, firstName: "Local", lastName: "Billing", email: `${ids.contactId}@example.test` });
    await tx.insert(properties).values({ id: ids.propertyId, contactId: ids.contactId, addressLine1: "100 Local Way", city: "Atlanta", state: "GA", postalCode: "30301" });
    await tx.insert(appointments).values({ id: ids.appointmentId, contactId: ids.contactId, propertyId: ids.propertyId,
      partnerAccountId: ids.accountId, type: "job", status: "completed", finalTotalCents: 10_000, rescheduleToken: randomUUID() });
    await tx.insert(partnerBookings).values({ id: ids.jobId, orgContactId: ids.contactId, partnerAccountId: ids.accountId,
      appointmentId: ids.appointmentId, propertyId: ids.propertyId, publicStatus: "completed" });
  });
  return ids;
}
function create(jobId: string): PartnerBillingCommand { return { action: "create_invoice", jobId,
  lines: [{ description: "Junk removal service", quantity: "1", unitAmountCents: 10_000 }], taxCents: 0, discountCents: 0, depositCents: 0,
  poNumber: "PO-TEST", costCenter: null, billingContact: { name: "Billing contact" }, terms: "Due on receipt", dueDate: null, reason: "Reviewed completed job" }; }
const command = (ids: Awaited<ReturnType<typeof fixture>>, input: PartnerBillingCommand, revision?: number) => getDb().transaction((tx) => runPartnerBillingCommand(tx,
  { accountId: ids.accountId, actorId: ids.actorId, command: input, expectedVersion: revision ? String(revision) : null }));
async function invoice(id: string) { return (await getDb().select().from(partnerInvoices).where(eq(partnerInvoices.id, id)))[0]!; }

describeLocal("canonical staff billing in real local PostgreSQL", () => {
  afterAll(closeDbForTests); // Immutable evidence remains in this disposable database.
  it("issues a draft, allocates cash, refunds, credits receivables, and snapshots a statement without changing job price", async () => {
    const ids = await fixture(); const draft = await command(ids, create(ids.jobId)); const invoiceId = draft.invoiceId!;
    await command(ids, { action: "issue_invoice", invoiceId, reason: "Reviewed for issue" }, draft.revision);
    const paymentId = randomUUID();
    await getDb().transaction(async (tx) => { await lockAppointmentInvoiceCollection(tx, ids.appointmentId);
      await tx.insert(payments).values({ id: paymentId, provider: "manual", providerPaymentId: paymentId, appointmentId: ids.appointmentId,
        amount: 6000, jobAmountCents: 6000, tipCents: 0, totalAmountCents: 6000, currency: "USD", method: "cash",
        status: "completed", canonicalStatus: "completed", providerStatus: "COMPLETED" });
      await reconcilePartnerAppointmentInvoices(tx, ids.appointmentId);
    });
    expect(await invoice(invoiceId)).toMatchObject({ paidCents: 6000, balanceCents: 4000 });
    await command(ids, { action: "record_manual_refund", invoiceId, paymentId, amountCents: 1000, reason: "Cash already returned", confirmation: "REFUND ALREADY GIVEN" }, (await invoice(invoiceId)).version);
    expect(await invoice(invoiceId)).toMatchObject({ paidCents: 5000, balanceCents: 5000 });
    await command(ids, { action: "credit_invoice", invoiceId, amountCents: 2000, reason: "Goodwill credit approved" }, (await invoice(invoiceId)).version);
    expect(await invoice(invoiceId)).toMatchObject({ totalCents: 10000, creditedCents: 2000, paidCents: 5000, balanceCents: 3000 });
    const [job] = await getDb().select().from(appointments).where(eq(appointments.id, ids.appointmentId));
    expect(job!.finalTotalCents).toBe(10000);
    const summary = await getAppointmentPaymentSummary(getDb(), ids.appointmentId);
    expect(summary).toMatchObject({ balanceCents: 3000 });
    const today = DateTime.now().setZone("America/New_York").toISODate()!;
    await command(ids, { action: "generate_statement", periodStart: today, periodEnd: today, reason: "Requested current statement" });
    const operations = await getDb().select().from(partnerBillingDocumentOperations).where(eq(partnerBillingDocumentOperations.partnerAccountId, ids.accountId));
    expect(operations.map((row) => row.documentType).sort()).toEqual(["credit", "invoice", "receipt", "refund", "statement"]);
    expect(operations.find((row) => row.documentType === "statement")!.snapshot).toMatchObject({ statement: { invoiceCents: 10000, paymentCents: 6000, refundCents: 1000, creditCents: 2000, closingBalanceCents: 3000 } });
    await expect(getDb().update(partnerInvoiceLines).set({ description: "Overwrite issued line" }).where(eq(partnerInvoiceLines.partnerInvoiceId, invoiceId))).rejects.toHaveProperty("cause.message", expect.stringContaining("immutable"));
    await expect(getDb().update(partnerInvoices).set({ totalCents: 9000 }).where(eq(partnerInvoices.id, invoiceId))).rejects.toHaveProperty("cause.message", expect.stringContaining("immutable"));
    await expect(getDb().update(partnerInvoiceCredits).set({ amountCents: 1 }).where(eq(partnerInvoiceCredits.partnerInvoiceId, invoiceId))).rejects.toHaveProperty("cause.message", expect.stringContaining("immutable"));
  });
  it("rejects cross-account jobs, duplicate invoices, stale revision, and unapproved price changes", async () => {
    const ids = await fixture(); const other = await fixture();
    await expect(command(ids, create(other.jobId))).rejects.toThrow("account-owned");
    await expect(command(ids, { ...create(ids.jobId), taxCents: 1 } as PartnerBillingCommand)).rejects.toThrow("match");
    const results = await Promise.allSettled([command(ids, create(ids.jobId)), command(ids, create(ids.jobId))]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const created = results.find((row) => row.status === "fulfilled")!;
    await expect(command(ids, { action: "issue_invoice", invoiceId: created.value.invoiceId!, reason: "Reviewed issue" }, 999)).rejects.toThrow("changed");
  });
  it("reserves queued Square refunds against races without making provider calls", async () => {
    const ids = await fixture(); const draft = await command(ids, create(ids.jobId)); const invoiceId = draft.invoiceId!;
    await command(ids, { action: "issue_invoice", invoiceId, reason: "Ready to issue" }, draft.revision);
    const paymentId = randomUUID();
    await getDb().transaction(async (tx) => { await lockAppointmentInvoiceCollection(tx, ids.appointmentId);
      await tx.insert(payments).values({ id: paymentId, provider: "square", providerPaymentId: `local-${paymentId}`, appointmentId: ids.appointmentId,
        amount: 10000, jobAmountCents: 10000, totalAmountCents: 10000, currency: "USD", method: "card", status: "completed", canonicalStatus: "completed", providerStatus: "COMPLETED" });
      await reconcilePartnerAppointmentInvoices(tx, ids.appointmentId);
    });
    const refund: PartnerBillingCommand = { action: "refund_payment", invoiceId, paymentId, amountCents: 7000, reason: "Requested original method refund" };
    const results = await Promise.allSettled([command(ids, refund, (await invoice(invoiceId)).version), command(ids, refund, (await invoice(invoiceId)).version)]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(await getDb().select().from(partnerBillingRefundRequests).where(eq(partnerBillingRefundRequests.paymentId, paymentId))).toHaveLength(1);
    expect(await invoice(invoiceId)).toMatchObject({ paidCents: 10000, balanceCents: 0 });
  });
  it("allows scoped billing only for the explicitly permitted property and returns no cross-account resource", async () => {
    const ids = await fixture(); const draft = await command(ids, create(ids.jobId));
    const access = { accountId: ids.accountId, accessLevel: "scoped" as const, accessScope: { propertyIds: [ids.propertyId], locationIds: [], costCenterIds: [] } };
    expect(await hasPartnerInvoiceAccess(getDb(), ids.accountId, draft.invoiceId!, access)).toBe(true);
    expect(await hasPartnerInvoiceAccess(getDb(), ids.accountId, draft.invoiceId!, { ...access, accessScope: { ...access.accessScope, propertyIds: [randomUUID()] } })).toBe(false);
    expect(await hasPartnerInvoiceAccess(getDb(), randomUUID(), draft.invoiceId!, access)).toBe(false);
  });
});
