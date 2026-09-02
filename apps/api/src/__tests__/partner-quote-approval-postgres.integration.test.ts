import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerApprovalRequests,
  partnerApprovalRules,
  partnerBookingDrafts,
  partnerServiceCatalog,
  partnerUsers,
  teamMembers,
} from "@/db";
import {
  buildPartnerApprovalRequestInsert,
  resolvePartnerApprovalRequirement,
} from "@/lib/partner-portal-v2-approvals";
import { partnerQuoteApprovalAllowsAcceptance } from "@/lib/partner-quote-v2-approval";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

describeWithDatabase("Quote V2 canonical Partner approval gate", () => {
  const accountId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const teamMemberId = randomUUID();
  const locationId = randomUUID();
  const otherLocationId = randomUUID();
  const draftId = randomUUID();
  const unrelatedDraftId = randomUUID();
  const ruleId = randomUUID();
  const suffix = accountId.replaceAll("-", "").slice(0, 12);
  const serviceKey = `quote-approval-${suffix}`;
  const now = new Date("2035-09-01T14:00:00.000Z");

  beforeAll(async () => {
    await getDb().transaction(async (tx) => {
      await tx.insert(teamMembers).values({
        id: teamMemberId,
        name: `Quote approval staff ${suffix}`,
      });
      await tx.insert(partnerAccounts).values({
        id: accountId,
        name: `Quote approval account ${suffix}`,
        normalizedName: `quote approval account ${suffix}`,
        status: "active_partner",
        portalAccessEnabled: true,
      });
      await tx.insert(partnerUsers).values({
        id: userId,
        email: `quote-approval-${suffix}@example.test`,
        normalizedEmail: `quote-approval-${suffix}@example.test`,
        name: "Quote approval requester",
        identityStatus: "active",
        emailVerifiedAt: now,
      });
      await tx.insert(partnerAccountMemberships).values({
        id: membershipId,
        partnerAccountId: accountId,
        partnerUserId: userId,
        roleKey: "operations",
        status: "active",
        accessLevel: "account",
        acceptedAt: now,
      });
      await tx.insert(partnerServiceCatalog).values({
        key: serviceKey,
        label: `Quote approval service ${suffix}`,
        description: "Disposable Quote V2 approval test service.",
      });
      await tx.insert(partnerAccountLocations).values([
        {
          id: locationId,
          partnerAccountId: accountId,
          siteName: "Quoted location",
          addressLine1: "1 Quote Way",
          city: "New York",
          state: "NY",
          postalCode: "10001",
        },
        {
          id: otherLocationId,
          partnerAccountId: accountId,
          siteName: "Other location",
          addressLine1: "2 Quote Way",
          city: "New York",
          state: "NY",
          postalCode: "10002",
        },
      ]);
      await tx.insert(partnerBookingDrafts).values([
        {
          id: draftId,
          partnerAccountId: accountId,
          createdByMembershipId: membershipId,
          locationId,
          serviceKey,
          commercial: { poNumber: "PO-100", costCenter: "FACILITIES" },
        },
        {
          id: unrelatedDraftId,
          partnerAccountId: accountId,
          createdByMembershipId: membershipId,
          locationId,
          serviceKey,
          commercial: { poNumber: "PO-100", costCenter: "FACILITIES" },
        },
      ]);
      await tx.insert(partnerApprovalRules).values({
        id: ruleId,
        partnerAccountId: accountId,
        name: "Conditional Quote approval",
        conditions: { locationId: otherLocationId },
        requiredApproverCapabilities: ["approvals.decide"],
        requiredApproverRoleKeys: [],
        requiredDecisionCount: 1,
        createdByTeamMemberId: teamMemberId,
        version: 1,
      });
    });
  });

  afterAll(async () => {
    await getDb().transaction(async (tx) => {
      await tx
        .delete(partnerApprovalRequests)
        .where(eq(partnerApprovalRequests.partnerAccountId, accountId));
      await tx
        .delete(partnerApprovalRules)
        .where(eq(partnerApprovalRules.partnerAccountId, accountId));
      await tx
        .delete(partnerBookingDrafts)
        .where(eq(partnerBookingDrafts.partnerAccountId, accountId));
      await tx
        .update(partnerAccounts)
        .set({ defaultPartnerLocationId: null })
        .where(eq(partnerAccounts.id, accountId));
      await tx
        .delete(partnerAccountLocations)
        .where(eq(partnerAccountLocations.partnerAccountId, accountId));
      await tx
        .delete(partnerAccountMemberships)
        .where(
          and(
            eq(partnerAccountMemberships.partnerAccountId, accountId),
            eq(partnerAccountMemberships.id, membershipId),
          ),
        );
      await tx.delete(partnerAccounts).where(eq(partnerAccounts.id, accountId));
      await tx.delete(partnerUsers).where(eq(partnerUsers.id, userId));
      await tx
        .delete(partnerServiceCatalog)
        .where(eq(partnerServiceCatalog.key, serviceKey));
      await tx.delete(teamMembers).where(eq(teamMembers.id, teamMemberId));
    });
    await closeDbForTests();
  });

  async function allowed(targetDraftId = draftId): Promise<boolean> {
    return getDb().transaction((tx) =>
      partnerQuoteApprovalAllowsAcceptance(tx, {
        accountId,
        bookingId: null,
        bookingDraftId: targetDraftId,
        totalMinCents: 25_000,
        totalMaxCents: 25_000,
        currency: "USD",
      }),
    );
  }

  async function approve(targetDraftId: string): Promise<void> {
    await getDb().transaction(async (tx) => {
      const resolution = await resolvePartnerApprovalRequirement({
        tx,
        partnerAccountId: accountId,
        requestedByMembershipId: membershipId,
        serviceKey,
        locationId,
        amountMinor: 25_000,
        currency: "USD",
        poNumber: "PO-100",
        costCenter: "FACILITIES",
      });
      if (!resolution.required) throw new Error("approval_rule_did_not_match");
      await tx.insert(partnerApprovalRequests).values({
        ...buildPartnerApprovalRequestInsert({
          resolution,
          target: {
            kind: "booking_draft",
            id: targetDraftId,
            partnerAccountId: accountId,
          },
          now,
        }),
        state: "approved",
        resolvedAt: now,
      });
    });
  }

  it("does not block a nonmatching conditional rule", async () => {
    await expect(allowed()).resolves.toBe(true);
  });

  it("rejects missing, unrelated, and stale approval evidence before accepting exact evidence", async () => {
    await getDb()
      .update(partnerApprovalRules)
      .set({
        conditions: {
          serviceKey,
          locationId,
          requesterRoleKey: "operations",
          minimumAmountMinor: 20_000,
          maximumAmountMinor: 30_000,
          poNumberState: "present",
          costCenterState: "present",
        },
        version: 2,
      })
      .where(eq(partnerApprovalRules.id, ruleId));

    await expect(allowed()).resolves.toBe(false);
    await approve(unrelatedDraftId);
    await expect(allowed()).resolves.toBe(false);
    await approve(draftId);
    await expect(allowed()).resolves.toBe(true);

    await getDb()
      .update(partnerApprovalRules)
      .set({ version: 3 })
      .where(eq(partnerApprovalRules.id, ruleId));
    await expect(allowed()).resolves.toBe(false);
  });
});
