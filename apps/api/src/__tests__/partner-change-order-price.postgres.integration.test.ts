import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  appointments,
  closeDbForTests,
  contacts,
  getDb,
  partnerAccounts,
  partnerBookings,
  partnerInvoices,
  payments,
  properties,
  teamMembers,
} from "@/db";
import {
  applyPartnerChangeOrderPrice,
  PartnerChangeOrderFinancialReviewRequired,
} from "@/lib/partner-change-order-price";
import {
  runPartnerBillingCommand,
  type PartnerBillingCommand,
} from "@/lib/partner-billing-administration";
import { getAppointmentPaymentSummary } from "@/lib/payment-ledger";

const local =
  process.env["DATABASE_URL"] &&
  ["127.0.0.1", "localhost"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const describeLocal = local ? describe : describe.skip;
async function fixture() {
  const f = {
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
      .values({ id: f.actorId, name: "Local change-order billing reviewer" });
    await tx
      .insert(partnerAccounts)
      .values({
        id: f.accountId,
        name: "Local change-order billing",
        normalizedName: f.accountId,
        status: "active_partner",
        portalAccessEnabled: true,
      });
    await tx
      .insert(contacts)
      .values({
        id: f.contactId,
        firstName: "Local",
        lastName: "Price bridge",
      });
    await tx
      .insert(properties)
      .values({
        id: f.propertyId,
        contactId: f.contactId,
        addressLine1: "1 Local Way",
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
      });
    await tx
      .insert(appointments)
      .values({
        id: f.appointmentId,
        contactId: f.contactId,
        propertyId: f.propertyId,
        partnerAccountId: f.accountId,
        type: "job",
        status: "confirmed",
        quotedTotalCents: 10000,
        finalTotalCents: null,
        rescheduleToken: randomUUID(),
      });
    await tx
      .insert(partnerBookings)
      .values({
        id: f.jobId,
        partnerAccountId: f.accountId,
        orgContactId: f.contactId,
        appointmentId: f.appointmentId,
        propertyId: f.propertyId,
        publicStatus: "confirmed",
      });
  });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const apply = (f: Fixture) =>
  getDb().transaction((tx) =>
    applyPartnerChangeOrderPrice(tx, {
      ...f,
      amountCents: 15000,
      actorMembershipId: f.actorId,
      changeOrderId: randomUUID(),
      quoteVersionId: randomUUID(),
      correlationId: randomUUID(),
      now: new Date(),
    }),
  );
const command = (
  f: Fixture,
  command: PartnerBillingCommand,
  version?: number,
) =>
  getDb().transaction((tx) =>
    runPartnerBillingCommand(tx, {
      accountId: f.accountId,
      actorId: f.actorId,
      command,
      expectedVersion: version ? String(version) : null,
    }),
  );
const create = (f: Fixture, amount = 10000): PartnerBillingCommand => ({
  action: "create_invoice",
  jobId: f.jobId,
  lines: [
    { description: "Agreed service", quantity: "1", unitAmountCents: amount },
  ],
  taxCents: 0,
  discountCents: 0,
  depositCents: 0,
  poNumber: null,
  costCenter: null,
  billingContact: { name: "Test billing contact" },
  terms: null,
  dueDate: null,
  reason: "Reviewed agreed job total",
});
async function invoice(id: string) {
  return (
    await getDb()
      .select()
      .from(partnerInvoices)
      .where(eq(partnerInvoices.id, id))
  )[0]!;
}

describeLocal(
  "change-order CRM financial authority in local PostgreSQL",
  () => {
    afterAll(closeDbForTests);
    it("updates only pre-finalization quote price and requires a stale draft invoice to be revised", async () => {
      const f = await fixture();
      const draft = await command(f, create(f));
      const [before] = await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, f.appointmentId));
      await apply(f);
      const [after] = await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, f.appointmentId));
      expect(after!.updatedAt).toBeInstanceOf(Date);
      expect({ ...after, updatedAt: before!.updatedAt }).toEqual({
        ...before,
        quotedTotalCents: 15000,
        quotedTotalMaxCents: 15000,
      });
      await expect(
        command(
          f,
          {
            action: "issue_invoice",
            invoiceId: draft.invoiceId!,
            reason: "Trying old amount",
          },
          draft.revision,
        ),
      ).rejects.toThrow("matching the job total");
      const fields = create(f, 15000);
      const {
        action: _action,
        jobId: _job,
        ...rest
      } = fields as Extract<
        PartnerBillingCommand,
        { action: "create_invoice" }
      >;
      const revised = await command(
        f,
        { ...rest, action: "revise_invoice", invoiceId: draft.invoiceId! },
        draft.revision,
      );
      await command(
        f,
        {
          action: "issue_invoice",
          invoiceId: draft.invoiceId!,
          reason: "Revised to accepted price",
        },
        revised.revision,
      );
      expect(await invoice(draft.invoiceId!)).toMatchObject({
        totalCents: 15000,
        balanceCents: 15000,
        status: "issued",
      });
    });
    it("rejects an issued invoice without mutating either obligation, then allows an unpaid void and replacement", async () => {
      const f = await fixture();
      const draft = await command(f, create(f));
      await command(
        f,
        {
          action: "issue_invoice",
          invoiceId: draft.invoiceId!,
          reason: "Reviewed original invoice",
        },
        draft.revision,
      );
      await expect(apply(f)).rejects.toBeInstanceOf(
        PartnerChangeOrderFinancialReviewRequired,
      );
      expect(
        (
          await getDb()
            .select()
            .from(appointments)
            .where(eq(appointments.id, f.appointmentId))
        )[0]!.quotedTotalCents,
      ).toBe(10000);
      expect(await invoice(draft.invoiceId!)).toMatchObject({
        totalCents: 10000,
        status: "issued",
      });
      await command(
        f,
        {
          action: "void_invoice",
          invoiceId: draft.invoiceId!,
          reason: "Replace after agreed scope correction",
        },
        (await invoice(draft.invoiceId!)).version,
      );
      await apply(f);
      const replacement = await command(f, create(f, 15000));
      await command(
        f,
        {
          action: "issue_invoice",
          invoiceId: replacement.invoiceId!,
          reason: "Reviewed replacement",
        },
        replacement.revision,
      );
      expect(await invoice(draft.invoiceId!)).toMatchObject({
        totalCents: 10000,
        creditedCents: 10000,
        status: "void",
      });
      expect(await invoice(replacement.invoiceId!)).toMatchObject({
        totalCents: 15000,
        creditedCents: 0,
        balanceCents: 15000,
      });
      expect(
        await getAppointmentPaymentSummary(getDb(), f.appointmentId, {
          jobTotalCents: 15000,
        }),
      ).toMatchObject({ balanceCents: 15000 });
      await expect(command(f, create(f, 15000))).rejects.toThrow(
        "active invoice",
      );
    });
    it("does not rewrite a recorded final total or completed-job financial evidence", async () => {
      const f = await fixture();
      await getDb()
        .update(appointments)
        .set({ finalTotalCents: 10000 })
        .where(eq(appointments.id, f.appointmentId));
      await expect(apply(f)).rejects.toBeInstanceOf(
        PartnerChangeOrderFinancialReviewRequired,
      );
      expect(
        (
          await getDb()
            .select()
            .from(appointments)
            .where(eq(appointments.id, f.appointmentId))
        )[0],
      ).toMatchObject({ finalTotalCents: 10000, quotedTotalCents: 10000 });
    });
    it("keeps settled and pending provider obligations in financial review", async () => {
      for (const status of ["pending", "completed"] as const) {
        const f = await fixture();
        const paymentId = randomUUID();
        await getDb()
          .insert(payments)
          .values({
            id: paymentId,
            appointmentId: f.appointmentId,
            provider: "square",
            providerPaymentId: paymentId,
            amount: 10000,
            jobAmountCents: 10000,
            totalAmountCents: 10000,
            currency: "USD",
            method: "card",
            status,
            canonicalStatus: status,
            providerStatus: status.toUpperCase(),
          });
        await expect(apply(f)).rejects.toBeInstanceOf(
          PartnerChangeOrderFinancialReviewRequired,
        );
        expect(
          (
            await getDb()
              .select()
              .from(appointments)
              .where(eq(appointments.id, f.appointmentId))
          )[0]!.quotedTotalCents,
        ).toBe(10000);
      }
    });
    it("serializes price acceptance with staff invoice issue so only one old-price obligation can win", async () => {
      const f = await fixture();
      const draft = await command(f, create(f));
      const outcomes = await Promise.allSettled([
        apply(f),
        command(
          f,
          {
            action: "issue_invoice",
            invoiceId: draft.invoiceId!,
            reason: "Concurrent issue",
          },
          draft.revision,
        ),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const current = await invoice(draft.invoiceId!);
      const [job] = await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, f.appointmentId));
      expect(
        current.status === "issued"
          ? job!.quotedTotalCents === current.totalCents
          : job!.quotedTotalCents === 15000,
      ).toBe(true);
    });
  },
);
