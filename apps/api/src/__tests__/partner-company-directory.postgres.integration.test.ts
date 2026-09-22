import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  partnerAccounts,
  contacts,
  properties,
  appointments,
  partnerBookings,
  partnerInvoices,
  partnerRateCards,
  partnerRateItems,
  partnerRateCardVersions,
} from "@/db";
import { listPartnerManagementResource } from "@/lib/partner-management-directory";
import { parsePartnerManagementListQuery } from "@/lib/partner-management-list";

const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;

suite("exact company lookup in local PostgreSQL", () => {
  const prefix = `Company lookup ${randomUUID()}`;
  const ids = Array.from({ length: 102 }, () => randomUUID());
  beforeAll(async () => {
    await getDb()
      .insert(partnerAccounts)
      .values(
        ids.map((id, index) => ({
          id,
          name: `${prefix} ${index}`,
          normalizedName: `${prefix.toLowerCase()} ${index}`,
          createdAt: new Date(Date.UTC(2020, 0, index + 1)),
        })),
      );
  });
  afterAll(async () => {
    await getDb()
      .delete(partnerAccounts)
      .where(inArray(partnerAccounts.id, ids));
    await closeDbForTests();
  });

  it("opens an explicitly selected company beyond the first 100 without matching by name", async () => {
    const first = await listPartnerManagementResource(
      "accounts",
      parsePartnerManagementListQuery(
        new URLSearchParams({ q: prefix, limit: "100" }),
        "accounts",
      ),
    );
    expect(first.items).toHaveLength(100);
    expect(first.page.hasMore).toBe(true);
    expect(first.items.some((item) => item.id === ids[0])).toBe(false);
    const exact = await listPartnerManagementResource(
      "accounts",
      parsePartnerManagementListQuery(
        new URLSearchParams({ accountId: ids[0]!, limit: "1" }),
        "accounts",
      ),
    );
    expect(exact.items).toHaveLength(1);
    expect(exact.items[0]).toMatchObject({ id: ids[0], name: `${prefix} 0` });
    expect(exact.page.hasMore).toBe(false);
  });

  it("does not replace an unavailable company with another directory result", async () => {
    const result = await listPartnerManagementResource(
      "accounts",
      parsePartnerManagementListQuery(
        new URLSearchParams({ accountId: randomUUID(), limit: "1" }),
        "accounts",
      ),
    );
    expect(result.items).toEqual([]);
    expect(result.page.nextCursor).toBeNull();
  });

  it("rejects a global directory cursor on an exact company lookup", async () => {
    const first = await listPartnerManagementResource(
      "accounts",
      parsePartnerManagementListQuery(
        new URLSearchParams({ q: prefix, limit: "1" }),
        "accounts",
      ),
    );
    expect(first.page.nextCursor).toEqual(expect.any(String));
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({
          accountId: ids[0]!,
          limit: "1",
          cursor: first.page.nextCursor!,
        }),
        "accounts",
      ),
    ).toThrow("different list or filter set");
  });
});

suite("commercial directory account correlations in local PostgreSQL", () => {
  afterAll(closeDbForTests);
  it("reads distinct current rates and invoice balances for historical and multi-service parents", async () => {
    const prefix = `Commercial correlation ${randomUUID()}`;
    const accountIds = [randomUUID(), randomUUID()];
    await getDb().transaction(async (tx) => {
      for (const [index, accountId] of accountIds.entries()) {
        const contactId = randomUUID(),
          propertyId = randomUUID(),
          jobId = randomUUID(),
          appointmentId = randomUUID(),
          cardId = randomUUID();
        await tx
          .insert(partnerAccounts)
          .values({
            id: accountId,
            name: `${prefix} ${index}`,
            normalizedName: `${prefix.toLowerCase()} ${index}`,
            status: "active_partner",
            portalAccessEnabled: true,
          });
        await tx
          .insert(contacts)
          .values({
            id: contactId,
            partnerAccountId: accountId,
            firstName: "Synthetic",
            lastName: "Commercial",
          });
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
        if (index === 0)
          await tx
            .insert(appointments)
            .values({
              id: appointmentId,
              partnerAccountId: accountId,
              contactId,
              propertyId,
              type: "job",
              status: "completed",
              finalTotalCents: 10000,
              rescheduleToken: randomUUID(),
            });
        await tx
          .insert(partnerBookings)
          .values({
            id: jobId,
            partnerAccountId: accountId,
            orgContactId: contactId,
            propertyId,
            appointmentId: index === 0 ? appointmentId : null,
            modelVersion: index === 0 ? 1 : 2,
            publicStatus: "completed",
            quotedTotalCents: index === 1 ? 50000 : null,
            finalTotalCents: index === 1 ? 50000 : null,
            pricedAt: index === 1 ? new Date() : null,
          });
        await tx
          .insert(partnerRateCards)
          .values({
            id: cardId,
            orgContactId: contactId,
            partnerAccountId: accountId,
            version: index + 3,
            effectiveFrom: new Date("2020-01-01T00:00:00Z"),
            currency: "USD",
          });
        await tx
          .insert(partnerRateItems)
          .values(
            Array.from({ length: index + 1 }, (_, item) => ({
              rateCardId: cardId,
              serviceKey: "junk-removal",
              tierKey: item === 0 ? "half" : "full",
              label: "Saved legacy option",
              amountCents: 10000 * (item + 1),
            })),
          );
        await tx
          .insert(partnerRateCardVersions)
          .values(
            Array.from({ length: index === 0 ? 1 : 3 }, (_, version) => ({
              partnerAccountId: accountId,
              version: version + 1,
              status: version === 0 && index === 1 ? "superseded" : "active",
              effectiveFrom: new Date(
                version === 2 ? "2099-01-01T00:00:00Z" : "2020-01-01T00:00:00Z",
              ),
              currency: "USD",
            })),
          );
        for (let invoice = 0; invoice <= index; invoice++) {
          const amount = index === 0 ? 10000 : 20000 + invoice * 10000;
          await tx
            .insert(partnerInvoices)
            .values({
              partnerAccountId: accountId,
              partnerBookingId: jobId,
              invoiceNumber: `SYNTHETIC-${randomUUID()}`,
              status: "issued",
              currency: "USD",
              subtotalCents: amount,
              totalCents: amount,
              paidCents: 0,
              balanceCents: amount,
              dueDate: index === 0 ? "2020-01-01" : "2099-01-01",
              issuedAt: new Date(),
              billingContact: {},
            });
        }
      }
    });
    const expected = accountIds.map((id, index) => ({
      id,
      status: "ready",
      pricingCurrency: "USD",
      totalRateCardCount: 1,
      currentRateCardCount: 1,
      currentRateItemCount: index + 1,
      versionedRateCardCount: index === 0 ? 1 : 3,
      activeVersionedRateCardCount: 1,
      invoiceCount: index + 1,
      openInvoiceCount: index + 1,
      overdueInvoiceCount: index === 0 ? 1 : 0,
      outstandingBalanceCents: index === 0 ? 10000 : 50000,
      approvalRuleCount: 0,
      pendingApprovalRequestCount: 0,
      quoteCount: 0,
      pendingPaymentAllocationCount: 0,
      readinessIssues: [],
    }));
    const result = await listPartnerManagementResource(
      "commercial",
      parsePartnerManagementListQuery(
        new URLSearchParams({ q: prefix, limit: "10" }),
        "commercial",
      ),
    );
    expect(result.items).toHaveLength(2);
    for (const item of expected)
      expect(result.items.find((row) => row.id === item.id)).toMatchObject(
        item,
      );
    for (const item of expected) {
      const exact = await listPartnerManagementResource(
        "commercial",
        parsePartnerManagementListQuery(
          new URLSearchParams({
            accountId: item.id,
            status: "ready",
            limit: "1",
          }),
          "commercial",
        ),
      );
      expect(exact.items).toHaveLength(1);
      expect(exact.items[0]).toMatchObject(item);
    }
  });
});
