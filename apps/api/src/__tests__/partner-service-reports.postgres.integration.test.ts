import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import {
  appointments,
  closeDbForTests,
  contacts,
  getDb,
  partnerAccounts,
  partnerAccountLocations,
  partnerBookings,
  partnerInvoices,
  properties,
} from "@/db";
import {
  readPartnerServiceReport,
  partnerServiceReportCsv,
} from "@/lib/partner-service-reports";
import { renderPartnerServiceReportPdf } from "@/lib/partner-service-report-pdf";
import { effectivePartnerInvoiceStatusSql } from "@/lib/partner-invoice-status";
import { listPartnerInvoices } from "@/lib/partner-portal-v2-commercial";
const local =
  process.env["DATABASE_URL"] &&
  ["127.0.0.1", "localhost"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const describeLocal = local ? describe : describe.skip;
async function fixture(dueDate: string | null = null) {
  const accountId = randomUUID(),
    contactId = randomUUID();
  const jobs = [0, 1].map(() => ({
    id: randomUUID(),
    appointmentId: randomUUID(),
    propertyId: randomUUID(),
    locationId: randomUUID(),
  }));
  await getDb().transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: "Local report company",
      normalizedName: `reports-${accountId}`,
      status: "active_partner",
      portalAccessEnabled: true,
    });
    await tx.insert(contacts).values({
      id: contactId,
      firstName: "Local",
      lastName: "Reports",
      email: `${contactId}@example.test`,
    });
    for (const [index, job] of jobs.entries()) {
      await tx.insert(properties).values({
        id: job.propertyId,
        contactId,
        addressLine1: `${index + 1} Local Way`,
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
      });
      await tx.insert(partnerAccountLocations).values({
        id: job.locationId,
        partnerAccountId: accountId,
        propertyId: job.propertyId,
        siteName: index ? "Other site" : "Assigned site",
        addressLine1: `${index + 1} Local Way`,
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
      });
      await tx.insert(appointments).values({
        id: job.appointmentId,
        contactId,
        propertyId: job.propertyId,
        partnerAccountId: accountId,
        type: "job",
        status: "completed",
        finalTotalCents: 10000,
        rescheduleToken: randomUUID(),
      });
      await tx.insert(partnerBookings).values({
        id: job.id,
        partnerAccountId: accountId,
        orgContactId: contactId,
        appointmentId: job.appointmentId,
        propertyId: job.propertyId,
        serviceKey: index ? "cleanout" : "junk_removal",
        publicStatus: "completed",
        poNumber: index ? "PO-2" : "=FORMULA",
        costCenter: "SITE-A",
        proofRequirementsSnapshot: { before: index === 0 },
      });
    }
    await tx.insert(partnerInvoices).values({
      partnerAccountId: accountId,
      partnerBookingId: jobs[0]!.id,
      invoiceNumber: `REPORT-${accountId}`,
      status: "partially_paid",
      currency: "USD",
      subtotalCents: 10000,
      totalCents: 10000,
      paidCents: 2000,
      creditedCents: 1000,
      balanceCents: 7000,
      billingContact: {},
      issuedAt: new Date(),
      dueDate,
      costCenter: "SITE-A",
      poNumber: "=FORMULA",
    });
  });
  return {
    accountId,
    jobs,
    access: { accountId, accessLevel: "account" as const, accessScope: {} },
  };
}
describeLocal("bounded role-separated reports in local PostgreSQL", () => {
  afterAll(closeDbForTests);
  it("isolates assigned locations and keeps financial fields out of operational rows and CSV", async () => {
    const f = await fixture();
    const report = await readPartnerServiceReport({
      ...f,
      params: new URLSearchParams("format=csv"),
    });
    expect(report.count).toBe(2);
    expect(report.summary).toEqual([]);
    expect(report.items.every((r) => !("financial" in r))).toBe(true);
    const csv = partnerServiceReportCsv(report);
    expect(csv).not.toContain("total_minor");
    expect(csv).not.toContain(f.jobs[0]!.appointmentId);
    expect(csv).toContain("'=FORMULA");
    const scoped = await readPartnerServiceReport({
      ...f,
      access: {
        ...f.access,
        accessLevel: "scoped",
        accessScope: { locationIds: [f.jobs[0]!.locationId] },
      },
      params: new URLSearchParams(),
    });
    expect(scoped.items.map((r) => r.jobId)).toEqual([f.jobs[0]!.id]);
    const hidden = await readPartnerServiceReport({
      ...f,
      access: {
        ...f.access,
        accessLevel: "scoped",
        accessScope: { propertyIds: [randomUUID()] },
      },
      params: new URLSearchParams(),
    });
    expect(hidden.items).toEqual([]);
  });
  it("filters job scope and proof accurately and snapshots net paid, credits, and invoice balances", async () => {
    const f = await fixture();
    const missing = await readPartnerServiceReport({
      ...f,
      params: new URLSearchParams(
        "proof=missing&service=junk_removal&costCenter=SITE-A&status=completed",
      ),
    });
    expect(missing.items.map((r) => r.jobId)).toEqual([f.jobs[0]!.id]);
    expect(missing.asOf).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u,
    );
    const financial = await readPartnerServiceReport({
      ...f,
      params: new URLSearchParams(
        "kind=financial&format=pdf&financialStatus=partially_paid",
      ),
    });
    expect(financial.summary).toEqual([
      {
        currency: "USD",
        invoices: 1,
        totalMinor: 10000,
        paidMinor: 2000,
        creditedMinor: 1000,
        balanceMinor: 7000,
      },
    ]);
    const pdf = await renderPartnerServiceReportPdf(financial);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
    const repeat = await renderPartnerServiceReportPdf(financial);
    expect(repeat.equals(pdf)).toBe(true);
  });
  it("pins every list cursor to the account, filters, scope, and unchanged complete snapshot", async () => {
    const f = await fixture();
    const first = await readPartnerServiceReport({
      ...f,
      params: new URLSearchParams("limit=1"),
    });
    expect(first.page.nextCursor).toBeTruthy();
    const next = new URLSearchParams({
      limit: "1",
      cursor: first.page.nextCursor!,
    });
    const second = await readPartnerServiceReport({ ...f, params: next });
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.snapshotHash).toBe(first.snapshotHash);
    await getDb()
      .update(partnerBookings)
      .set({ publicStatus: "canceled" })
      .where(eq(partnerBookings.id, f.jobs[0]!.id));
    await expect(
      readPartnerServiceReport({ ...f, params: next }),
    ).rejects.toMatchObject({ code: "report_changed", status: 409 });
    await expect(
      readPartnerServiceReport({
        ...f,
        access: {
          ...f.access,
          accessLevel: "scoped",
          accessScope: { locationIds: [f.jobs[0]!.locationId] },
        },
        params: next,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });
  it("shows and filters overdue invoices immediately without changing financial evidence", async () => {
    const dueDate = DateTime.now()
      .setZone("America/New_York")
      .minus({ days: 1 })
      .toISODate()!;
    const f = await fixture(dueDate);
    const [before] = await getDb()
      .select()
      .from(partnerInvoices)
      .where(eq(partnerInvoices.partnerAccountId, f.accountId));
    expect(before!.status).toBe("partially_paid");
    const invoices = await listPartnerInvoices({
      accountId: f.accountId,
      access: f.access,
      params: new URLSearchParams("status=overdue"),
    });
    expect(invoices.ok).toBe(true);
    if (!invoices.ok) throw new Error("invoice_read_failed");
    expect(invoices.items).toHaveLength(1);
    expect(invoices.items[0]).toMatchObject({
      id: before!.id,
      status: "overdue",
    });
    const report = await readPartnerServiceReport({
      ...f,
      params: new URLSearchParams("kind=financial&financialStatus=overdue"),
    });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]!.financial).toMatchObject({
      status: "overdue",
      balanceMinor: 7000,
    });
    const notOverdue = await readPartnerServiceReport({
      ...f,
      params: new URLSearchParams(
        "kind=financial&financialStatus=partially_paid",
      ),
    });
    expect(notOverdue.items).toEqual([]);
    const [after] = await getDb()
      .select()
      .from(partnerInvoices)
      .where(eq(partnerInvoices.id, before!.id));
    expect(after).toEqual(before);
  });
  it("keeps the whole due date available across New York's spring DST transition", async () => {
    const f = await fixture("2026-03-08");
    const [row] = await getDb()
      .select({
        beforeMidnight: effectivePartnerInvoiceStatusSql(
          "2026-03-09T03:59:59.999999Z",
        ),
        atMidnight: effectivePartnerInvoiceStatusSql(
          "2026-03-09T04:00:00.000000Z",
        ),
      })
      .from(partnerInvoices)
      .where(eq(partnerInvoices.partnerAccountId, f.accountId));
    expect(row).toEqual({
      beforeMidnight: "partially_paid",
      atMidnight: "overdue",
    });
  });
});
