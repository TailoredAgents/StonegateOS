import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  appointments, closeDbForTests, contacts, getDb, partnerAccounts,
  partnerBookings, partnerInvoices, partnerPaymentAllocations,
  paymentAttempts, paymentRefunds, payments, properties, outboxEvents,
} from "@/db";
import { lockAppointmentInvoiceCollection, reconcilePartnerAppointmentInvoices } from "@/lib/partner-invoice-ledger";
import { createPartnerEmbeddedPaymentIntent, finalizePartnerPortalPaymentReconciliation } from "@/lib/partner-portal-v2-payments";
import type { PartnerEmbeddedPaymentProvider } from "@/lib/partner-embedded-payment-provider";
import { reconcileSquarePaymentEvent } from "@/lib/square-payments";
import { hasUnretiredPartnerHostedInvoice } from "@/lib/partner-hosted-retirement";

const databaseUrl = process.env["DATABASE_URL"];
const localDatabase = databaseUrl && ["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname);
const describeLocal = localDatabase ? describe : describe.skip;
type Fixture = { accountId: string; invoiceId: string; bookingId: string; appointmentId: string; contactId: string; propertyId: string };
const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
  const row = { accountId: randomUUID(), invoiceId: randomUUID(), bookingId: randomUUID(),
    appointmentId: randomUUID(), contactId: randomUUID(), propertyId: randomUUID() };
  await getDb().transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({ id: row.accountId, name: "Local invoice test",
      normalizedName: `invoice-test-${row.accountId}`, status: "active_partner", portalAccessEnabled: true });
    await tx.insert(contacts).values({ id: row.contactId, firstName: "Local", lastName: "Invoice", email: `${row.contactId}@example.test` });
    await tx.insert(properties).values({ id: row.propertyId, contactId: row.contactId,
      addressLine1: "100 Test Way", city: "Atlanta", state: "GA", postalCode: "30301" });
    await tx.insert(appointments).values({ id: row.appointmentId, contactId: row.contactId,
      propertyId: row.propertyId, partnerAccountId: row.accountId, type: "job", status: "completed",
      finalTotalCents: 10_000, rescheduleToken: randomUUID() });
    await tx.insert(partnerBookings).values({ id: row.bookingId, orgContactId: row.contactId,
      partnerAccountId: row.accountId, appointmentId: row.appointmentId, propertyId: row.propertyId,
      publicStatus: "completed" });
    await tx.insert(partnerInvoices).values({ id: row.invoiceId, partnerAccountId: row.accountId,
      partnerBookingId: row.bookingId, invoiceNumber: `TEST-${row.invoiceId}`, status: "issued", currency: "USD",
      subtotalCents: 10_000, totalCents: 10_000, paidCents: 0, balanceCents: 10_000,
      billingContact: {}, issuedAt: new Date() });
  });
  fixtures.push(row);
  return row;
}

async function sync(row: Fixture) {
  await getDb().transaction(async (tx) => {
    await lockAppointmentInvoiceCollection(tx, row.appointmentId);
    await reconcilePartnerAppointmentInvoices(tx, row.appointmentId);
  });
}

async function payment(row: Fixture, amount: number, status = "completed", tender = "cash") {
  const id = randomUUID();
  await getDb().insert(payments).values({ id, provider: tender === "cash" ? "manual" : "square",
    providerPaymentId: `test-${id}`, appointmentId: row.appointmentId, amount: amount + 500,
    jobAmountCents: amount, tipCents: 500, totalAmountCents: amount + 500, currency: "USD",
    status, canonicalStatus: status, providerStatus: status.toUpperCase(), method: tender, tenderType: tender });
  return id;
}

describeLocal("CRM-first invoice ledger in real PostgreSQL (local only)", () => {
  afterEach(() => {
    // Issued invoices and financial evidence are immutable. The explicitly
    // disposable local database owns cleanup, not production-guard bypasses.
    fixtures.splice(0);
  });
  afterAll(closeDbForTests);

  it("projects cash/card/settled ACH and partial refunds, never tips or pending ACH", async () => {
    const row = await fixture();
    await payment(row, 2_500);
    const cardId = await payment(row, 5_000, "completed", "card");
    const achId = await payment(row, 2_500, "pending", "bank_account");
    await sync(row);
    let [invoice] = await getDb().select().from(partnerInvoices).where(eq(partnerInvoices.id, row.invoiceId));
    expect(invoice).toMatchObject({ paidCents: 7_500, balanceCents: 2_500, status: "partially_paid" });
    await getDb().update(payments).set({ canonicalStatus: "completed", providerStatus: "COMPLETED" }).where(eq(payments.id, achId));
    await sync(row);
    [invoice] = await getDb().select().from(partnerInvoices).where(eq(partnerInvoices.id, row.invoiceId));
    expect(invoice).toMatchObject({ paidCents: 10_000, balanceCents: 0, status: "paid" });
    await getDb().insert(paymentRefunds).values({ paymentId: cardId, provider: "square", providerRefundId: randomUUID(),
      amountCents: 2_000, jobAmountCents: 2_000, tipCents: 0, currency: "USD", canonicalStatus: "completed", providerStatus: "COMPLETED" });
    await sync(row);
    await sync(row);
    [invoice] = await getDb().select().from(partnerInvoices).where(eq(partnerInvoices.id, row.invoiceId));
    expect(invoice).toMatchObject({ totalCents: 10_000, paidCents: 8_000, balanceCents: 2_000, status: "partially_paid" });
  });

  it("serializes duplicate allocation transactions into exactly one allocation", async () => {
    const row = await fixture();
    await payment(row, 10_000);
    await Promise.all([sync(row), sync(row), sync(row)]);
    const allocations = await getDb().select().from(partnerPaymentAllocations).where(eq(partnerPaymentAllocations.partnerInvoiceId, row.invoiceId));
    expect(allocations).toHaveLength(1);
    const [invoice] = await getDb().select().from(partnerInvoices).where(eq(partnerInvoices.id, row.invoiceId));
    expect(invoice).toMatchObject({ paidCents: 10_000, balanceCents: 0, version: 2 });
  });

  it("treats duplicate settlement after a fully-paid invoice as successful replay", async () => {
    const row = await fixture();
    const attemptId = randomUUID();
    const membershipId = randomUUID();
    await getDb().insert(paymentAttempts).values({ id: attemptId, appointmentId: row.appointmentId,
      provider: "square", clientRequestId: randomUUID(), status: "completed", requestedJobAmountCents: 10_000,
      currency: "USD", expiresAt: new Date(Date.now() + 60_000), metadata: { partnerPortalPayment: {
        schemaVersion: 1, partnerAccountId: row.accountId, partnerInvoiceId: row.invoiceId,
        partnerMembershipId: membershipId, partnerUserId: randomUUID(), purpose: "invoice_balance",
        paymentMethod: "card", checkoutMode: "embedded_card", amountMinor: 10_000, currency: "USD", minorUnit: 2,
        correlationId: "local-invoice-replay", idempotencyKeyHash: "a".repeat(64), providerPaymentLinkId: null,
        checkoutUrl: null, providerCreatedAt: null,
      } } });
    const paymentId = await payment(row, 10_000, "completed", "card");
    await getDb().update(payments).set({ paymentAttemptId: attemptId }).where(eq(payments.id, paymentId));
    const settle = () => getDb().transaction(async (tx) => {
      await lockAppointmentInvoiceCollection(tx, row.appointmentId);
      await finalizePartnerPortalPaymentReconciliation(tx, { status: "verified", appointmentId: row.appointmentId,
        attemptId, paymentId, providerPaymentId: `test-${paymentId}` });
    });
    await settle();
    await settle();
    const [attempt] = await getDb().select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId));
    expect(attempt?.metadata).toMatchObject({ partnerPortalPayment: { allocationState: "settled" } });
    expect(attempt?.status).toBe("completed");
    const allocations = await getDb().select().from(partnerPaymentAllocations).where(eq(partnerPaymentAllocations.partnerInvoiceId, row.invoiceId));
    expect(allocations).toHaveLength(1);
  });

  it("creates only one provider obligation under simultaneous invoice checkout", async () => {
    const row = await fixture();
    let orders = 0;
    const provider: PartnerEmbeddedPaymentProvider = {
      provider: "square", locationId: "local-test-location",
      webPayments: { applicationId: "sandbox-test", locationId: "local-test-location", environment: "sandbox",
        sdkUrl: "https://sandbox.web.squarecdn.com/v1/square.js", methods: { card: true, ach: true }, achUnavailableReason: null },
      createOrder: (request) => { orders += 1; return Promise.resolve({ provider: "square" as const, providerOrderId: `order-${request.intentId}`, locationId: "local-test-location" }); },
      createPayment: () => Promise.reject(new Error("No real or fake charge expected in prepare test")),
    };
    const input = { accountId: row.accountId, membershipId: randomUUID(), partnerUserId: randomUUID(),
      email: "local@example.test", roleKey: "billing_approver", sessionId: randomUUID(), correlationId: "local-prepare-race",
      idempotencyKeyHash: "a".repeat(64), invoiceId: row.invoiceId, purpose: "invoice_balance" as const,
      amountMinor: 10_000, currency: "USD" as const, paymentMethod: "ach" as const, provider };
    const results = await Promise.all([createPartnerEmbeddedPaymentIntent(input), createPartnerEmbeddedPaymentIntent(input)]);
    expect(orders).toBe(1);
    expect(results.some((result) => result.status === 201 || result.status === 200)).toBe(true);
    const attempts = await getDb().select().from(paymentAttempts).where(eq(paymentAttempts.appointmentId, row.appointmentId));
    expect(attempts).toHaveLength(1);
  });
  it("reconciles a verified failed bank payment without marking the invoice paid or repeatedly notifying", async () => {
    const row = await fixture(); const attemptId = randomUUID(), providerPaymentId = `local-${randomUUID()}`, orderId = `local-order-${randomUUID()}`;
    await getDb().insert(paymentAttempts).values({ id: attemptId, appointmentId: row.appointmentId, provider: "square", clientRequestId: randomUUID(),
      status: "pending_verification", requestedJobAmountCents: 10_000, currency: "USD", expiresAt: new Date(Date.now() + 60_000),
      providerOrderId: orderId, providerPaymentId, squareLocationId: "local-location", metadata: { partnerPortalPayment: {
        schemaVersion: 1, partnerAccountId: row.accountId, partnerInvoiceId: row.invoiceId, partnerMembershipId: randomUUID(),
        partnerUserId: randomUUID(), purpose: "invoice_balance", paymentMethod: "ach", checkoutMode: "embedded_ach",
        amountMinor: 10_000, currency: "USD", minorUnit: 2, correlationId: "local-failed-ach", idempotencyKeyHash: "b".repeat(64),
        providerPaymentLinkId: null, checkoutUrl: null, providerCreatedAt: null,
      } } });
    const originalFetch = globalThis.fetch, originalToken = process.env["SQUARE_ACCESS_TOKEN"];
    process.env["SQUARE_ACCESS_TOKEN"] = "local-test-not-a-secret";
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith(`/v2/payments/${providerPaymentId}`)) return Promise.reject(new Error("Unexpected external request blocked by local test"));
      return Promise.resolve(new Response(JSON.stringify({ payment: { id: providerPaymentId, order_id: orderId, location_id: "local-location",
        status: "FAILED", source_type: "BANK_ACCOUNT", amount_money: { amount: 10000, currency: "USD" } } }), { status: 200 }));
    }) as typeof fetch;
    try {
      await expect(reconcileSquarePaymentEvent(providerPaymentId)).resolves.toMatchObject({ status: "processed" });
      await reconcileSquarePaymentEvent(providerPaymentId);
    } finally { globalThis.fetch = originalFetch; if (originalToken === undefined) delete process.env["SQUARE_ACCESS_TOKEN"]; else process.env["SQUARE_ACCESS_TOKEN"] = originalToken; }
    expect((await getDb().select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId)))[0]!.status).toBe("failed");
    expect((await getDb().select().from(partnerInvoices).where(eq(partnerInvoices.id, row.invoiceId)))[0]).toMatchObject({ paidCents: 0, balanceCents: 10000 });
    const events = await getDb().select().from(outboxEvents).where(eq(outboxEvents.type, "partner.payment.failed"));
    expect(events.filter((event) => event.payload["paymentIntentId"] === attemptId)).toHaveLength(1);
  });
  it("blocks an orphaned legacy hosted collection even without a live local attempt", async () => {
    const row = await fixture();
    await getDb().update(partnerInvoices).set({ hostedPaymentUrl: "https://square.link/local-test", providerOrderId: "local-old-order" }).where(eq(partnerInvoices.id, row.invoiceId));
    expect(await hasUnretiredPartnerHostedInvoice(getDb(), row.appointmentId)).toBe(true);
    const provider: PartnerEmbeddedPaymentProvider = { provider: "square", locationId: "local-location",
      webPayments: { applicationId: "sandbox-test", locationId: "local-location", environment: "sandbox", sdkUrl: "https://sandbox.web.squarecdn.com/v1/square.js", methods: { card: true, ach: true }, achUnavailableReason: null },
      createOrder: () => Promise.reject(new Error("Provider must not be called before legacy retirement")), createPayment: () => Promise.reject(new Error("No charge permitted")) };
    const result = await createPartnerEmbeddedPaymentIntent({ accountId: row.accountId, membershipId: randomUUID(), partnerUserId: randomUUID(), email: "local@example.test",
      roleKey: "billing_approver", sessionId: randomUUID(), correlationId: "local-hosted-retirement", idempotencyKeyHash: "d".repeat(64),
      invoiceId: row.invoiceId, purpose: "invoice_balance", amountMinor: 10000, currency: "USD", paymentMethod: "card", provider });
    expect(result).toMatchObject({ status: 422 });
    expect(await getDb().select().from(paymentAttempts).where(eq(paymentAttempts.appointmentId, row.appointmentId))).toHaveLength(0);
  });
});
