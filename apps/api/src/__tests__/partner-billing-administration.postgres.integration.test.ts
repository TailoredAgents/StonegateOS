import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import {
  appointments,
  closeDbForTests,
  contacts,
  getDb,
  partnerAccounts,
  partnerBillingDocumentOperations,
  partnerBillingRefundRequests,
  partnerBookings,
  partnerBookingServiceLines,
  partnerInvoiceCredits,
  partnerInvoiceLines,
  partnerRefundAllocations,
  partnerInvoices,
  payments,
  paymentRefunds,
  properties,
  teamMembers,
  teamRoles,
} from "@/db";
import {
  runPartnerBillingCommand,
  type PartnerBillingCommand,
} from "@/lib/partner-billing-administration";
import { getAppointmentPaymentSummary } from "@/lib/payment-ledger";
import {
  lockAppointmentInvoiceCollection,
  reconcilePartnerAppointmentInvoices,
} from "@/lib/partner-invoice-ledger";
import { loadPartnerQuoteV2StaffContext } from "@/lib/partner-quote-v2-staff-context";
import { completeTestPartnerRateCard } from "./fixtures/partner-service-rates";
import { hasPartnerInvoiceAccess } from "@/lib/partner-invoice-access";
import { reconcileSquareRefundEvent } from "@/lib/square-payments";
import { lockPartnerRequestFinancials } from "@/lib/partner-request-financials";

const databaseUrl = process.env["DATABASE_URL"];
const local =
  databaseUrl &&
  ["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname);
const describeLocal = local ? describe : describe.skip;
async function fixture(parent = false) {
  const ids = {
    accountId: randomUUID(),
    jobId: randomUUID(),
    appointmentId: randomUUID(),
    contactId: randomUUID(),
    propertyId: randomUUID(),
    actorId: randomUUID(),
  };
  await getDb().transaction(async (tx) => {
    await tx
      .insert(teamMembers)
      .values({ id: ids.actorId, name: "Local billing test", active: true });
    await tx.insert(partnerAccounts).values({
      id: ids.accountId,
      name: "Local billing company",
      normalizedName: `billing-${ids.accountId}`,
      status: "active_partner",
      portalAccessEnabled: true,
    });
    await tx.insert(contacts).values({
      id: ids.contactId,
      partnerAccountId: ids.accountId,
      firstName: "Local",
      lastName: "Billing",
      email: `${ids.contactId}@example.test`,
    });
    await tx.insert(properties).values({
      id: ids.propertyId,
      contactId: ids.contactId,
      addressLine1: "100 Local Way",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    });
    if (!parent)
      await tx.insert(appointments).values({
        id: ids.appointmentId,
        contactId: ids.contactId,
        propertyId: ids.propertyId,
        partnerAccountId: ids.accountId,
        type: "job",
        status: "completed",
        finalTotalCents: 10_000,
        rescheduleToken: randomUUID(),
      });
    await tx.insert(partnerBookings).values({
      id: ids.jobId,
      orgContactId: ids.contactId,
      partnerAccountId: ids.accountId,
      appointmentId: parent ? null : ids.appointmentId,
      modelVersion: parent ? 2 : 1,
      finalTotalCents: parent ? 10000 : null,
      quotedTotalCents: parent ? 10000 : null,
      pricedAt: parent ? new Date() : null,
      propertyId: ids.propertyId,
      publicStatus: "completed",
    });
  });
  return ids;
}
function create(jobId: string): PartnerBillingCommand {
  return {
    action: "create_invoice",
    jobId,
    lines: [
      {
        description: "Junk removal service",
        quantity: "1",
        unitAmountCents: 10_000,
      },
    ],
    taxCents: 0,
    discountCents: 0,
    depositCents: 0,
    poNumber: "PO-TEST",
    costCenter: null,
    billingContact: { name: "Billing contact" },
    terms: "Due on receipt",
    dueDate: null,
    reason: "Reviewed completed job",
  };
}
const command = (
  ids: Awaited<ReturnType<typeof fixture>>,
  input: PartnerBillingCommand,
  revision?: number,
) =>
  getDb().transaction((tx) =>
    runPartnerBillingCommand(tx, {
      accountId: ids.accountId,
      actorId: ids.actorId,
      command: input,
      expectedVersion: revision ? String(revision) : null,
    }),
  );
async function invoice(id: string) {
  return (
    await getDb()
      .select()
      .from(partnerInvoices)
      .where(eq(partnerInvoices.id, id))
  )[0]!;
}

async function allowManualPayments(ids: Awaited<ReturnType<typeof fixture>>) {
  const roleId = randomUUID();
  await getDb()
    .insert(teamRoles)
    .values({
      id: roleId,
      slug: `manual-billing-${roleId}`,
      name: "Manual billing collector",
      permissions: ["partners.commercial.manage", "payments.collect"],
    });
  await getDb()
    .update(teamMembers)
    .set({ roleId })
    .where(eq(teamMembers.id, ids.actorId));
}
function manual(
  invoiceId: string,
  amountCents = 6000,
): Extract<PartnerBillingCommand, { action: "record_manual_payment" }> {
  return {
    action: "record_manual_payment",
    invoiceId,
    clientRequestId: randomUUID(),
    amountCents,
    method: "cash",
    reference: null,
    reason: "Cash received by the office",
    confirmation: "PAYMENT ALREADY RECEIVED",
  };
}

describeLocal("canonical staff billing in real local PostgreSQL", () => {
  afterAll(closeDbForTests); // Immutable evidence remains in this disposable database.
  it("issues a draft, allocates cash, refunds, credits receivables, and snapshots a statement without changing job price", async () => {
    const ids = await fixture();
    const draft = await command(ids, create(ids.jobId));
    const invoiceId = draft.invoiceId!;
    await command(
      ids,
      { action: "issue_invoice", invoiceId, reason: "Reviewed for issue" },
      draft.revision,
    );
    const paymentId = randomUUID();
    await getDb().transaction(async (tx) => {
      await lockAppointmentInvoiceCollection(tx, ids.appointmentId);
      await tx.insert(payments).values({
        id: paymentId,
        provider: "manual",
        providerPaymentId: paymentId,
        appointmentId: ids.appointmentId,
        amount: 6000,
        jobAmountCents: 6000,
        tipCents: 0,
        totalAmountCents: 6000,
        currency: "USD",
        method: "cash",
        status: "completed",
        canonicalStatus: "completed",
        providerStatus: "COMPLETED",
      });
      await reconcilePartnerAppointmentInvoices(tx, ids.appointmentId);
    });
    expect(await invoice(invoiceId)).toMatchObject({
      paidCents: 6000,
      balanceCents: 4000,
    });
    await command(
      ids,
      {
        action: "record_manual_refund",
        invoiceId,
        paymentId,
        amountCents: 1000,
        reason: "Cash already returned",
        confirmation: "REFUND ALREADY GIVEN",
      },
      (await invoice(invoiceId)).version,
    );
    expect(await invoice(invoiceId)).toMatchObject({
      paidCents: 5000,
      balanceCents: 5000,
    });
    await command(
      ids,
      {
        action: "credit_invoice",
        invoiceId,
        amountCents: 2000,
        reason: "Goodwill credit approved",
      },
      (await invoice(invoiceId)).version,
    );
    expect(await invoice(invoiceId)).toMatchObject({
      totalCents: 10000,
      creditedCents: 2000,
      paidCents: 5000,
      balanceCents: 3000,
    });
    const [job] = await getDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, ids.appointmentId));
    expect(job!.finalTotalCents).toBe(10000);
    const summary = await getAppointmentPaymentSummary(
      getDb(),
      ids.appointmentId,
    );
    expect(summary).toMatchObject({ balanceCents: 3000 });
    const today = DateTime.now().setZone("America/New_York").toISODate()!;
    await command(ids, {
      action: "generate_statement",
      periodStart: today,
      periodEnd: today,
      reason: "Requested current statement",
    });
    const operations = await getDb()
      .select()
      .from(partnerBillingDocumentOperations)
      .where(
        eq(partnerBillingDocumentOperations.partnerAccountId, ids.accountId),
      );
    expect(operations.map((row) => row.documentType).sort()).toEqual([
      "credit",
      "invoice",
      "receipt",
      "refund",
      "statement",
    ]);
    expect(
      operations.find((row) => row.documentType === "statement")!.snapshot,
    ).toMatchObject({
      statement: {
        invoiceCents: 10000,
        paymentCents: 6000,
        refundCents: 1000,
        creditCents: 2000,
        closingBalanceCents: 3000,
      },
    });
    await expect(
      getDb()
        .update(partnerInvoiceLines)
        .set({ description: "Overwrite issued line" })
        .where(eq(partnerInvoiceLines.partnerInvoiceId, invoiceId)),
    ).rejects.toHaveProperty(
      "cause.message",
      expect.stringContaining("immutable"),
    );
    await expect(
      getDb()
        .update(partnerInvoices)
        .set({ totalCents: 9000 })
        .where(eq(partnerInvoices.id, invoiceId)),
    ).rejects.toHaveProperty(
      "cause.message",
      expect.stringContaining("immutable"),
    );
    await expect(
      getDb()
        .update(partnerInvoiceCredits)
        .set({ amountCents: 1 })
        .where(eq(partnerInvoiceCredits.partnerInvoiceId, invoiceId)),
    ).rejects.toHaveProperty(
      "cause.message",
      expect.stringContaining("immutable"),
    );
  });
  it("rejects cross-account jobs, duplicate invoices, stale revision, and unapproved price changes", async () => {
    const ids = await fixture();
    const other = await fixture();
    await expect(command(ids, create(other.jobId))).rejects.toThrow(
      "account-owned",
    );
    await expect(
      command(ids, {
        ...create(ids.jobId),
        taxCents: 1,
      } as PartnerBillingCommand),
    ).rejects.toThrow("match");
    const results = await Promise.allSettled([
      command(ids, create(ids.jobId)),
      command(ids, create(ids.jobId)),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const created = results.find((row) => row.status === "fulfilled")!;
    await expect(
      command(
        ids,
        {
          action: "issue_invoice",
          invoiceId: created.value.invoiceId!,
          reason: "Reviewed issue",
        },
        999,
      ),
    ).rejects.toThrow("changed");
  });
  it("reserves queued Square refunds against races without making provider calls", async () => {
    const ids = await fixture();
    const draft = await command(ids, create(ids.jobId));
    const invoiceId = draft.invoiceId!;
    await command(
      ids,
      { action: "issue_invoice", invoiceId, reason: "Ready to issue" },
      draft.revision,
    );
    const paymentId = randomUUID();
    await getDb().transaction(async (tx) => {
      await lockAppointmentInvoiceCollection(tx, ids.appointmentId);
      await tx.insert(payments).values({
        id: paymentId,
        provider: "square",
        providerPaymentId: `local-${paymentId}`,
        appointmentId: ids.appointmentId,
        amount: 10000,
        jobAmountCents: 10000,
        totalAmountCents: 10000,
        currency: "USD",
        method: "card",
        status: "completed",
        canonicalStatus: "completed",
        providerStatus: "COMPLETED",
      });
      await reconcilePartnerAppointmentInvoices(tx, ids.appointmentId);
    });
    const refund: PartnerBillingCommand = {
      action: "refund_payment",
      invoiceId,
      paymentId,
      amountCents: 7000,
      reason: "Requested original method refund",
    };
    const results = await Promise.allSettled([
      command(ids, refund, (await invoice(invoiceId)).version),
      command(ids, refund, (await invoice(invoiceId)).version),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(
      await getDb()
        .select()
        .from(partnerBillingRefundRequests)
        .where(eq(partnerBillingRefundRequests.paymentId, paymentId)),
    ).toHaveLength(1);
    expect(await invoice(invoiceId)).toMatchObject({
      paidCents: 10000,
      balanceCents: 0,
    });
  });
  it("allows scoped billing only for the explicitly permitted property and returns no cross-account resource", async () => {
    const ids = await fixture();
    const draft = await command(ids, create(ids.jobId));
    const access = {
      accountId: ids.accountId,
      accessLevel: "scoped" as const,
      accessScope: {
        propertyIds: [ids.propertyId],
        locationIds: [],
        costCenterIds: [],
      },
    };
    expect(
      await hasPartnerInvoiceAccess(
        getDb(),
        ids.accountId,
        draft.invoiceId!,
        access,
      ),
    ).toBe(true);
    expect(
      await hasPartnerInvoiceAccess(getDb(), ids.accountId, draft.invoiceId!, {
        ...access,
        accessScope: { ...access.accessScope, propertyIds: [randomUUID()] },
      }),
    ).toBe(false);
    expect(
      await hasPartnerInvoiceAccess(
        getDb(),
        randomUUID(),
        draft.invoiceId!,
        access,
      ),
    ).toBe(false);
  });
  it("issues one parent invoice for combined work without an appointment and prevents concurrent duplicate billing", async () => {
    const ids = await fixture(true);
    const results = await Promise.allSettled([
      command(ids, create(ids.jobId)),
      command(ids, create(ids.jobId)),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const created = results.find((result) => result.status === "fulfilled")!;
    if (created.status !== "fulfilled")
      throw new Error("Invoice was not created");
    const invoiceId = created.value.invoiceId!;
    await command(
      ids,
      {
        action: "issue_invoice",
        invoiceId,
        reason: "Approved combined service total",
      },
      created.value.revision,
    );
    expect(await invoice(invoiceId)).toMatchObject({
      partnerBookingId: ids.jobId,
      totalCents: 10000,
      paidCents: 0,
      balanceCents: 10000,
    });
    expect(
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.partnerAccountId, ids.accountId)),
    ).toHaveLength(0);
    const other = await fixture(true);
    await expect(command(other, create(ids.jobId))).rejects.toThrow(
      "account-owned",
    );
    await expect(
      command(other, { ...create(other.jobId), taxCents: 1 }),
    ).rejects.toThrow("match");
    const [booking] = await getDb()
      .select()
      .from(partnerBookings)
      .where(eq(partnerBookings.id, ids.jobId));
    expect(booking).toMatchObject({
      appointmentId: null,
      modelVersion: 2,
      finalTotalCents: 10000,
    });
    const operations = await getDb()
      .select()
      .from(partnerBillingDocumentOperations)
      .where(
        eq(partnerBillingDocumentOperations.partnerAccountId, ids.accountId),
      );
    expect(operations).toHaveLength(1);
    expect(operations[0]!.documentType).toBe("invoice");
  });
  it("refuses a parent invoice until Stonegate has recorded its confirmed total", async () => {
    const ids = await fixture(true);
    await getDb()
      .update(partnerBookings)
      .set({ quotedTotalCents: null, finalTotalCents: null, pricedAt: null })
      .where(eq(partnerBookings.id, ids.jobId));
    await expect(command(ids, create(ids.jobId))).rejects.toThrow("match");
    expect(
      await getDb()
        .select()
        .from(partnerInvoices)
        .where(eq(partnerInvoices.partnerBookingId, ids.jobId)),
    ).toHaveLength(0);
  });
  it("provides account-bound quote itemization with exact reviewed amounts and retains missing prices", async () => {
    const ids = await fixture(true);
    await getDb()
      .update(partnerBookings)
      .set({
        publicStatus: "under_review",
        scopeSnapshot: { serviceLabel: "Painting + Soft washing" },
      })
      .where(eq(partnerBookings.id, ids.jobId));
    const card = completeTestPartnerRateCard();
    const paintRate = {
      ...card.rates.find((rate) => rate.serviceKey === "painting")!,
      unit: "sq_ft" as const,
      unitAmount: "0.1255",
    };
    await getDb()
      .insert(partnerBookingServiceLines)
      .values([
        {
          id: randomUUID(),
          partnerBookingId: ids.jobId,
          partnerAccountId: ids.accountId,
          position: 0,
          serviceKey: "painting",
          serviceLabel: "Painting",
          description: "Paint the walls; preserve the stone trim.",
          priceDescription: "Two coats on the agreed interior walls",
          quotedAmountCents: 6000,
          proofRequirements: {},
          pricingSnapshot: { currency: "USD", rates: [paintRate] },
        },
        {
          id: randomUUID(),
          partnerBookingId: ids.jobId,
          partnerAccountId: ids.accountId,
          position: 1,
          serviceKey: "soft-washing",
          serviceLabel: "Soft washing",
          description: "Wash the roof.",
          quotedAmountCents: 4000,
          proofRequirements: {},
        },
      ]);
    const context = await loadPartnerQuoteV2StaffContext({
      accountId: ids.accountId,
    });
    const target = context!.targets.find((item) => item.id === ids.jobId)!;
    expect(
      target.serviceLines.map((line) => [line.title, line.amountCents]),
    ).toEqual([
      ["Painting", 6000],
      ["Soft washing", 4000],
    ]);
    expect(target.serviceLines[0]!.description).toContain(
      "preserve the stone trim",
    );
    expect(target.serviceLines[0]!.description).toContain("Two coats");
    expect(target.serviceLines[0]!.rateReferences[0]).toContain(
      "$0.1255 / square foot",
    );
    const other = await fixture(true);
    expect(
      (await loadPartnerQuoteV2StaffContext({
        accountId: other.accountId,
      }))!.targets.some((item) => item.id === ids.jobId),
    ).toBe(false);
    await getDb()
      .update(partnerBookings)
      .set({ pricedAt: null, quotedTotalCents: null, finalTotalCents: null })
      .where(eq(partnerBookings.id, ids.jobId));
    const unpriced = (await loadPartnerQuoteV2StaffContext({
      accountId: ids.accountId,
    }))!.targets.find((item) => item.id === ids.jobId)!;
    expect(
      unpriced.serviceLines.every((line) => line.amountCents === null),
    ).toBe(true);
  });

  it("records received parent cash/check once, reconciles one invoice and queues exact receipts", async () => {
    const ids = await fixture(true);
    await allowManualPayments(ids);
    const draft = await command(ids, create(ids.jobId)),
      invoiceId = draft.invoiceId!;
    await command(
      ids,
      { action: "issue_invoice", invoiceId, reason: "Reviewed combined work" },
      draft.revision,
    );
    const received = manual(invoiceId);
    const first = await command(
      ids,
      received,
      (await invoice(invoiceId)).version,
    );
    expect(first.paymentId).toEqual(expect.any(String));
    expect(await invoice(invoiceId)).toMatchObject({
      paidCents: 6000,
      balanceCents: 4000,
      status: "partially_paid",
    });
    expect(
      await command(ids, received, (await invoice(invoiceId)).version),
    ).toMatchObject({ paymentId: first.paymentId, replayed: true });
    await expect(
      command(
        ids,
        { ...received, amountCents: 3000 },
        (await invoice(invoiceId)).version,
      ),
    ).rejects.toThrow("already belongs");
    await command(
      ids,
      { ...manual(invoiceId, 4000), method: "check", reference: "Check 101" },
      (await invoice(invoiceId)).version,
    );
    expect(await invoice(invoiceId)).toMatchObject({
      paidCents: 10000,
      balanceCents: 0,
      status: "paid",
    });
    const records = await getDb()
      .select()
      .from(payments)
      .where(eq(payments.partnerBookingId, ids.jobId));
    expect(records).toHaveLength(2);
    expect(
      records.every(
        (row) =>
          row.appointmentId === null &&
          row.partnerAccountId === ids.accountId &&
          row.canonicalStatus === "completed",
      ),
    ).toBe(true);
    expect(records.map((row) => row.method).sort()).toEqual(["cash", "check"]);
    const docs = await getDb()
      .select()
      .from(partnerBillingDocumentOperations)
      .where(
        eq(partnerBillingDocumentOperations.partnerAccountId, ids.accountId),
      );
    expect(docs.filter((row) => row.documentType === "receipt")).toHaveLength(
      2,
    );
  });
  it("serializes parent payment races, refuses excess collection and rechecks revoked authority", async () => {
    const ids = await fixture(true);
    await allowManualPayments(ids);
    const draft = await command(ids, create(ids.jobId)),
      invoiceId = draft.invoiceId!;
    await expect(
      command(ids, manual(invoiceId), draft.revision),
    ).rejects.toThrow("Issue and review");
    await command(
      ids,
      { action: "issue_invoice", invoiceId, reason: "Reviewed combined work" },
      draft.revision,
    );
    const revision = (await invoice(invoiceId)).version;
    const results = await Promise.allSettled([
      command(ids, manual(invoiceId), revision),
      command(ids, manual(invoiceId), revision),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await getDb()
        .select()
        .from(payments)
        .where(eq(payments.partnerBookingId, ids.jobId)),
    ).toHaveLength(1);
    await expect(
      command(ids, manual(invoiceId, 5000), (await invoice(invoiceId)).version),
    ).rejects.toThrow("exceeds");
    await getDb()
      .update(teamMembers)
      .set({ permissionsDeny: ["payments.collect"] })
      .where(eq(teamMembers.id, ids.actorId));
    await expect(
      command(ids, manual(invoiceId, 1000), (await invoice(invoiceId)).version),
    ).rejects.toMatchObject({ code: "forbidden" });
    const other = await fixture(true);
    await allowManualPayments(other);
    await expect(
      command(
        other,
        manual(invoiceId, 1000),
        (await invoice(invoiceId)).version,
      ),
    ).rejects.toThrow("account-owned");
    expect(await invoice(invoiceId)).toMatchObject({
      paidCents: 6000,
      balanceCents: 4000,
    });
  });

  it("settles parent Square refunds against one invoice and keeps retries, older provider reads, and legacy history safe", async () => {
    const ids = await fixture(true);
    const legacy = await fixture();
    const legacyDraft = await command(legacy, create(legacy.jobId));
    const legacyBefore = await invoice(legacyDraft.invoiceId!);
    const draft = await command(ids, create(ids.jobId));
    const invoiceId = draft.invoiceId!;
    await command(
      ids,
      { action: "issue_invoice", invoiceId, reason: "Reviewed combined work" },
      draft.revision,
    );
    const paymentId = randomUUID();
    const providerPaymentId = `parent-payment-${paymentId}`;
    const firstRefundId = `parent-refund-${randomUUID()}`;
    const finalRefundId = `parent-refund-${randomUUID()}`;
    await getDb().transaction(async (tx) => {
      await lockPartnerRequestFinancials(tx, ids.accountId, ids.jobId);
      await tx.insert(payments).values({
        id: paymentId,
        provider: "square",
        providerPaymentId,
        partnerAccountId: ids.accountId,
        partnerBookingId: ids.jobId,
        appointmentId: null,
        amount: 10000,
        jobAmountCents: 10000,
        tipCents: 0,
        totalAmountCents: 10000,
        currency: "USD",
        method: "card",
        status: "completed",
        canonicalStatus: "completed",
        providerStatus: "COMPLETED",
      });
      await reconcilePartnerAppointmentInvoices(tx, {
        accountId: ids.accountId,
        bookingId: ids.jobId,
      });
      await tx.insert(partnerBillingRefundRequests).values([
        {
          partnerAccountId: ids.accountId,
          partnerInvoiceId: invoiceId,
          paymentId,
          amountCents: 2000,
          reason: "Reviewed partial refund",
          status: "submitted",
          providerRefundId: firstRefundId,
          requestedBy: ids.actorId,
        },
        {
          partnerAccountId: ids.accountId,
          partnerInvoiceId: invoiceId,
          paymentId,
          amountCents: 8000,
          reason: "Reviewed remaining refund",
          status: "submitted",
          providerRefundId: finalRefundId,
          requestedBy: ids.actorId,
        },
      ]);
    });
    expect(await invoice(invoiceId)).toMatchObject({
      paidCents: 10000,
      balanceCents: 0,
    });
    const env = {
      E2E_RUN_ID: "parent-square-refund-regression",
      SQUARE_ENVIRONMENT: "sandbox",
      SQUARE_ACCESS_TOKEN: "synthetic-local-square-token",
      SQUARE_API_BASE_URL: "http://127.0.0.1:50199",
    };
    const before = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    let providerRefundedCents = 2000;
    const originalFetch = globalThis.fetch;
    const providerRequests: string[] = [];
    globalThis.fetch = (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      expect(url.origin).toBe(env.SQUARE_API_BASE_URL);
      providerRequests.push(url.pathname);
      if (url.pathname === `/v2/payments/${providerPaymentId}`)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              payment: {
                id: providerPaymentId,
                status: "COMPLETED",
                amount_money: { amount: 10000, currency: "USD" },
                total_money: { amount: 10000, currency: "USD" },
                tip_money: { amount: 0, currency: "USD" },
                refunded_money: {
                  amount: providerRefundedCents,
                  currency: "USD",
                },
              },
            }),
          ),
        );
      const refundId = url.pathname.split("/").at(-1);
      if (
        url.pathname.startsWith("/v2/refunds/") &&
        [firstRefundId, finalRefundId].includes(refundId!)
      )
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refund: {
                id: refundId,
                payment_id: providerPaymentId,
                status: "COMPLETED",
                amount_money: {
                  amount: refundId === firstRefundId ? 2000 : 8000,
                  currency: "USD",
                },
                updated_at: new Date().toISOString(),
              },
            }),
          ),
        );
      throw Error("Unexpected provider request in local regression");
    };
    try {
      await expect(
        reconcileSquareRefundEvent(firstRefundId),
      ).resolves.toMatchObject({ paymentId, status: "needs_review" });
      expect(await invoice(invoiceId)).toMatchObject({
        paidCents: 8000,
        balanceCents: 2000,
      });
      providerRefundedCents = 10000;
      const repeated = await Promise.all([
        reconcileSquareRefundEvent(finalRefundId),
        reconcileSquareRefundEvent(finalRefundId),
      ]);
      expect(repeated.every((result) => result.status === "processed")).toBe(
        true,
      );
      expect(await invoice(invoiceId)).toMatchObject({
        paidCents: 0,
        balanceCents: 10000,
      });
      // A delayed partial-refund event must not roll back a newer provider total.
      providerRefundedCents = 2000;
      await reconcileSquareRefundEvent(firstRefundId);
      expect(
        (
          await getDb()
            .select()
            .from(payments)
            .where(eq(payments.id, paymentId))
        )[0],
      ).toMatchObject({ appointmentId: null, refundedAmountCents: 10000 });
      const refunds = await getDb()
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.paymentId, paymentId));
      expect(refunds).toHaveLength(2);
      expect(
        refunds.reduce((total, row) => total + row.jobAmountCents, 0),
      ).toBe(10000);
      expect(
        (
          await getDb()
            .select()
            .from(partnerBillingRefundRequests)
            .where(eq(partnerBillingRefundRequests.paymentId, paymentId))
        ).every((row) => row.status === "settled"),
      ).toBe(true);
      expect(await invoice(invoiceId)).toMatchObject({
        paidCents: 0,
        balanceCents: 10000,
      });
      expect(await invoice(legacyDraft.invoiceId!)).toEqual(legacyBefore);
      // The new parent allocation branch must keep both request and company
      // boundaries; sharing the same company does not make two jobs fungible.
      const siblingJobId = randomUUID();
      await getDb().insert(partnerBookings).values({
        id: siblingJobId,
        orgContactId: ids.contactId,
        partnerAccountId: ids.accountId,
        propertyId: ids.propertyId,
        modelVersion: 2,
        quotedTotalCents: 10000,
        finalTotalCents: 10000,
        pricedAt: new Date(),
        publicStatus: "completed",
      });
      const sibling = await command(ids, create(siblingJobId));
      for (const target of [
        { accountId: ids.accountId, invoiceId: sibling.invoiceId! },
        { accountId: legacy.accountId, invoiceId: legacyDraft.invoiceId! },
      ]) {
        await expect(
          getDb().insert(partnerRefundAllocations).values({
            partnerAccountId: target.accountId,
            partnerInvoiceId: target.invoiceId,
            refundId: refunds[0]!.id,
            jobAmountCents: 1000,
          }),
        ).rejects.toHaveProperty(
          "cause.message",
          "partner_allocation_account_job_payment_mismatch",
        );
      }
      expect(providerRequests).toHaveLength(8);
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(env)) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  });
});
