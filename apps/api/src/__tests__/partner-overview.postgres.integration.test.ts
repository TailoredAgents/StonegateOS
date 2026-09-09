import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  appointments,
  closeDbForTests,
  contacts,
  getDb,
  partnerAccounts,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerBookingDrafts,
  partnerBookings,
  partnerInvoices,
  partnerMembershipLocationScopes,
  partnerRoleTemplates,
  partnerUsers,
  properties,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (name: string, factory: () => Record<string, unknown>) => void;
const authorization = await import("@/lib/partner-account-authorization");
let principal: PartnerPrincipal | null = null;
// Only session authentication is replaced. Capability derivation, relational
// grants, account/job predicates and every overview SQL query remain real.
mockModule("@/lib/partner-account-authorization", () => ({
  ...authorization,
  requirePartnerCapability: (
    _request: NextRequest,
    capability: Parameters<typeof authorization.hasPartnerCapability>[1],
  ) =>
    Promise.resolve(principal && authorization.hasPartnerCapability(principal, capability)
      ? { ok: true, principal }
      : { ok: false, status: 401, error: "unauthorized" }),
}));
const OverviewResponse = z.object({ ok: z.literal(true),
  nextJob: z.object({ id: z.string().uuid(), status: z.string(), locationName: z.string().nullable(), startAt: z.string().nullable(), endAt: z.string().nullable(), timezone: z.string() }).passthrough().nullable(),
  savedRequest: z.object({ id: z.string().uuid(), locationName: z.string().nullable(), updatedAt: z.string() }).passthrough().nullable(),
  outstandingBalances: z.array(z.object({ currency: z.string(), amountMinor: z.number().int().nonnegative(), minorUnit: z.literal(2) }).passthrough()).nullable(),
}).passthrough();
const { GET } = await import("../../app/api/portal/v2/overview/route");
const local =
  process.env["DATABASE_URL"] &&
  ["127.0.0.1", "localhost"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
async function fixture() {
  const accountId = randomUUID(),
    foreignAccountId = randomUUID(),
    contactId = randomUUID();
  const people = [
    "administrator",
    "billing_approver",
    "operations",
    "operations",
  ].map((roleKey, index) => ({
    userId: randomUUID(),
    membershipId: randomUUID(),
    roleKey,
    scoped: index === 1 || index === 2,
  }));
  const jobs = Array.from({ length: 5 }, () => ({
    id: randomUUID(),
    appointmentId: randomUUID(),
    propertyId: randomUUID(),
    locationId: randomUUID(),
  }));
  const adminDraftId = randomUUID(),
    operationsDraftId = randomUUID();
  const now = Date.now();
  await getDb().transaction(async (tx) => {
    const roles = await tx
      .select()
      .from(partnerRoleTemplates)
      .where(isNull(partnerRoleTemplates.partnerAccountId));
    await tx
      .insert(partnerAccounts)
      .values(
        [accountId, foreignAccountId].map((id) => ({
          id,
          name: "Local overview company",
          normalizedName: id,
          status: "active_partner" as const,
          portalAccessEnabled: true,
        })),
      );
    await tx
      .insert(contacts)
      .values({ id: contactId, firstName: "Local", lastName: "Overview" });
    await tx
      .insert(partnerUsers)
      .values(
        people.map((person) => ({
          id: person.userId,
          email: `${person.userId}@example.test`,
          normalizedEmail: `${person.userId}@example.test`,
          name: "Local overview user",
          active: true,
          identityStatus: "active" as const,
          emailVerifiedAt: new Date(),
        })),
      );
    await tx
      .insert(partnerAccountMemberships)
      .values(
        people.map((person) => ({
          id: person.membershipId,
          partnerAccountId: accountId,
          partnerUserId: person.userId,
          roleKey: person.roleKey,
          roleTemplateId: roles.find((role) => role.key === person.roleKey)!.id,
          status: "active" as const,
          accessLevel: person.scoped
            ? ("scoped" as const)
            : ("account" as const),
          acceptedAt: new Date(),
        })),
      );
    for (const [index, job] of jobs.entries()) {
      const owner = index === 4 ? foreignAccountId : accountId;
      await tx
        .insert(properties)
        .values({
          id: job.propertyId,
          contactId,
          addressLine1: `${index + 1} Local Way`,
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        });
      await tx
        .insert(partnerAccountLocations)
        .values({
          id: job.locationId,
          partnerAccountId: owner,
          propertyId: job.propertyId,
          siteName: `Local site ${index}`,
          addressLine1: `${index + 1} Local Way`,
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        });
      await tx
        .insert(appointments)
        .values({
          id: job.appointmentId,
          contactId,
          propertyId: job.propertyId,
          partnerAccountId: owner,
          type: "job",
          status:
            index === 2 ? "canceled" : index === 3 ? "requested" : "confirmed",
          rescheduleToken: randomUUID(),
        });
      await tx
        .insert(partnerBookings)
        .values({
          id: job.id,
          orgContactId: contactId,
          partnerAccountId: owner,
          appointmentId: job.appointmentId,
          propertyId: job.propertyId,
          publicStatus: index === 3 ? "under_review" : "confirmed",
          arrivalWindowStartAt:
            index === 3
              ? null
              : new Date(
                  now + (index === 0 ? 2 : index === 1 ? 1 : 0.1) * 3600000,
                ),
          arrivalWindowEndAt: index === 3 ? null : new Date(now + 4 * 3600000),
        });
    }
    await tx.insert(partnerMembershipLocationScopes).values(
      people
        .filter((person) => person.scoped)
        .map((person) => ({
          membershipId: person.membershipId,
          partnerAccountId: accountId,
          locationId: jobs[0]!.locationId,
        })),
    );
    const invoiceValues = Array.from({ length: 120 }, (_, index) => {
      const balance = [100, 200, 300][index % 3]!;
      const paid = index % 3 === 1 ? 50 : 0;
      return {
        id: randomUUID(),
        partnerAccountId: accountId,
        partnerBookingId: jobs[0]!.id,
        invoiceNumber: `OVERVIEW-${randomUUID()}`,
        status: ["issued", "partially_paid", "overdue"][index % 3]!,
        currency: "USD",
        subtotalCents: balance + paid,
        totalCents: balance + paid,
        paidCents: paid,
        balanceCents: balance,
        billingContact: {},
        issuedAt: new Date(),
      };
    });
    invoiceValues.push(
      ...Array.from({ length: 7 }, () => ({
        ...invoiceValues[0]!,
        id: randomUUID(),
        invoiceNumber: `OVERVIEW-${randomUUID()}`,
        partnerBookingId: jobs[1]!.id,
        subtotalCents: 700,
        totalCents: 700,
        balanceCents: 700,
      })),
    );
    invoiceValues.push(
      ...["draft", "void"].map((status) => ({
        ...invoiceValues[0]!,
        id: randomUUID(),
        invoiceNumber: `OVERVIEW-${randomUUID()}`,
        status,
        subtotalCents: 999900,
        totalCents: 999900,
        balanceCents: 999900,
      })),
    );
    invoiceValues.push({
      ...invoiceValues[0]!,
      id: randomUUID(),
      invoiceNumber: `OVERVIEW-${randomUUID()}`,
      status: "paid",
      paidCents: 100,
      balanceCents: 0,
    });
    invoiceValues.push({
      ...invoiceValues[0]!,
      id: randomUUID(),
      invoiceNumber: `OVERVIEW-${randomUUID()}`,
      partnerAccountId: foreignAccountId,
      partnerBookingId: jobs[4]!.id,
      subtotalCents: 500000,
      totalCents: 500000,
      balanceCents: 500000,
    });
    await tx.insert(partnerInvoices).values(invoiceValues);
    await tx.insert(partnerBookingDrafts).values(
      [
        {
          id: adminDraftId,
          createdByMembershipId: people[0]!.membershipId,
          locationId: jobs[0]!.locationId,
          state: "draft",
          updatedAt: new Date(now - 30000),
        },
        {
          id: randomUUID(),
          createdByMembershipId: people[0]!.membershipId,
          locationId: jobs[0]!.locationId,
          state: "submitted",
          updatedAt: new Date(now),
        },
        {
          id: operationsDraftId,
          createdByMembershipId: people[2]!.membershipId,
          locationId: jobs[0]!.locationId,
          state: "ready",
          updatedAt: new Date(now - 30000),
        },
        {
          id: randomUUID(),
          createdByMembershipId: people[2]!.membershipId,
          locationId: jobs[1]!.locationId,
          state: "draft",
          updatedAt: new Date(now),
        },
        {
          id: randomUUID(),
          createdByMembershipId: people[3]!.membershipId,
          locationId: jobs[0]!.locationId,
          state: "draft",
          updatedAt: new Date(now + 1),
        },
      ].map((row) => ({
        ...row,
        partnerAccountId: accountId,
        expiresAt: new Date(now + 3600000),
      })),
    );
    await tx
      .insert(partnerBookingDrafts)
      .values({
        partnerAccountId: accountId,
        createdByMembershipId: people[0]!.membershipId,
        locationId: jobs[0]!.locationId,
        state: "draft",
        expiresAt: new Date(now - 1000),
        updatedAt: new Date(now + 1000),
      });
  });
  async function selectPerson(index: number) {
    const person = people[index]!;
    const access = (
      await authorization.loadActiveMembershipAccesses(person.userId)
    ).find((row) => row.membershipId === person.membershipId)!;
    expect(access).toBeDefined();
    principal = {
      ...access,
      type: "partner",
      partnerUserId: person.userId,
      email: `${person.userId}@example.test`,
      name: "Local overview user",
      passwordSet: true,
      accessSource: "membership",
      session: {
        id: randomUUID(),
        authMethod: "password",
        deviceName: null,
        createdAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(now + 3600000),
      },
      availableAccounts: [access],
    };
  }
  return { jobs, adminDraftId, operationsDraftId, selectPerson };
}
suite(
  "real overview SQL with complete balances and role/location visibility",
  () => {
    const originalReads = process.env["PARTNER_PORTAL_V2_READS_ENABLED"],
      originalInternal = process.env["PARTNER_PORTAL_INTERNAL_TEST_MODE"];
    let f: Awaited<ReturnType<typeof fixture>>;
    beforeAll(async () => {
      process.env["PARTNER_PORTAL_V2_READS_ENABLED"] = "true";
      process.env["PARTNER_PORTAL_INTERNAL_TEST_MODE"] = "false";
      f = await fixture();
    });
    afterAll(async () => {
      principal = null;
      if (originalReads === undefined)
        delete process.env["PARTNER_PORTAL_V2_READS_ENABLED"];
      else process.env["PARTNER_PORTAL_V2_READS_ENABLED"] = originalReads;
      if (originalInternal === undefined)
        delete process.env["PARTNER_PORTAL_INTERNAL_TEST_MODE"];
      else process.env["PARTNER_PORTAL_INTERNAL_TEST_MODE"] = originalInternal;
      await closeDbForTests();
    });
    async function request() {
      const response = await GET(
        new NextRequest("https://api.example.test/api/portal/v2/overview"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return OverviewResponse.parse(await response.json());
    }
    it("aggregates all 127 collectible invoices, not a first-page slice, while excluding draft/void/paid and foreign records", async () => {
      await f.selectPerson(0);
      const body = await request();
      expect(body.outstandingBalances).toEqual([
        { currency: "USD", amountMinor: 28900, minorUnit: 2 },
      ]);
      expect(body.nextJob).toMatchObject({
        id: f.jobs[1]!.id,
        locationName: "Local site 1",
      });
      expect(body.nextJob).not.toHaveProperty("appointmentId");
      expect(body.savedRequest).toMatchObject({
        id: f.adminDraftId,
        locationName: "Local site 0",
      });
    });
    it("uses real relational location grants for the Billing/Approver's 120 invoices and next job", async () => {
      await f.selectPerson(1);
      const body = await request();
      expect(principal!.accessScope.locationIds).toEqual([
        f.jobs[0]!.locationId,
      ]);
      expect(body.outstandingBalances).toEqual([
        { currency: "USD", amountMinor: 24000, minorUnit: 2 },
      ]);
      expect(body.nextJob).toMatchObject({ id: f.jobs[0]!.id });
      expect(body.savedRequest).toBeNull();
    });
    it("never gives Operations a financial summary and resumes only their own currently permitted, unexpired request", async () => {
      await f.selectPerson(2);
      const body = await request();
      expect(principal!.capabilities).not.toContain("invoices.read");
      expect(body.outstandingBalances).toBeNull();
      expect(body.nextJob).toMatchObject({ id: f.jobs[0]!.id });
      expect(body.savedRequest).toMatchObject({
        id: f.operationsDraftId,
        locationName: "Local site 0",
      });
    });
    it("removes an additional-service resume link after original-job access is revoked while the draft location remains permitted", async () => {
      await f.selectPerson(2);
      const accountId = principal!.accountId!, membershipId = principal!.membershipId!;
      const additionalDraftId = randomUUID();
      await getDb().insert(partnerMembershipLocationScopes).values({
        membershipId,
        partnerAccountId: accountId,
        locationId: f.jobs[1]!.locationId,
      });
      await getDb().insert(partnerBookingDrafts).values({
        id: additionalDraftId,
        partnerAccountId: accountId,
        createdByMembershipId: membershipId,
        additionalServiceFromPartnerBookingId: f.jobs[1]!.id,
        locationId: f.jobs[0]!.locationId,
        state: "draft",
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      });
      await f.selectPerson(2);
      expect((await request()).savedRequest?.id).toBe(additionalDraftId);
      await getDb().delete(partnerMembershipLocationScopes).where(and(
        eq(partnerMembershipLocationScopes.membershipId, membershipId),
        eq(partnerMembershipLocationScopes.partnerAccountId, accountId),
        eq(partnerMembershipLocationScopes.locationId, f.jobs[1]!.locationId),
      ));
      await f.selectPerson(2);
      expect(principal!.accessScope.locationIds).toEqual([f.jobs[0]!.locationId]);
      const body = await request();
      expect(body.savedRequest?.id).toBe(f.operationsDraftId);
      expect(JSON.stringify(body)).not.toContain(additionalDraftId);
    });
    it("keeps an unscheduled requested/review job visible when no confirmed work remains", async () => {
      await getDb()
        .update(appointments)
        .set({ status: "completed" })
        .where(
          inArray(
            appointments.id,
            f.jobs.slice(0, 2).map((job) => job.appointmentId),
          ),
        );
      await f.selectPerson(0);
      expect((await request()).nextJob).toMatchObject({
        id: f.jobs[3]!.id,
        status: "under_review",
        startAt: null,
        endAt: null,
      });
      await getDb()
        .update(partnerBookings)
        .set({ publicStatus: "requested" })
        .where(eq(partnerBookings.id, f.jobs[3]!.id));
      expect((await request()).nextJob).toMatchObject({
        id: f.jobs[3]!.id,
        status: "requested",
        startAt: null,
      });
    });
  },
);
