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
import { resolveMultiServiceApproval } from "@/lib/partner-multi-service-domain";
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
  it("evaluates every combined service and requires exact service-set approval at a confirmed quote total", async () => {
    const combinedId = randomUUID();
    const keys = ["junk-removal", "painting"] as const;
    await getDb()
      .update(partnerApprovalRules)
      .set({ active: false })
      .where(eq(partnerApprovalRules.id, ruleId));
    await getDb()
      .insert(partnerBookingDrafts)
      .values({
        id: combinedId,
        partnerAccountId: accountId,
        createdByMembershipId: membershipId,
        modelVersion: 2,
        locationId,
        serviceKey: null,
        commercial: {},
        serviceLines: keys.map((key) => ({
          id: randomUUID(),
          serviceKey: key,
          description: "Combined requested work",
          scope: {},
          selectedAddOns: [],
          proofRequirements: {},
        })),
      });
    await getDb()
      .insert(partnerApprovalRules)
      .values({
        id: randomUUID(),
        partnerAccountId: accountId,
        name: "Painting needs approval",
        conditions: { serviceKey: "painting" },
        requiredApproverCapabilities: ["approvals.decide"],
        requiredApproverRoleKeys: [],
        requiredDecisionCount: 1,
        createdByTeamMemberId: teamMemberId,
      });
    const check = (
      overrides: { totalMinCents?: number; totalMaxCents?: number } = {},
    ) =>
      getDb().transaction((tx) =>
        partnerQuoteApprovalAllowsAcceptance(tx, {
          accountId,
          bookingId: null,
          bookingDraftId: combinedId,
          totalMinCents: 25000,
          totalMaxCents: 25000,
          currency: "USD",
          ...overrides,
        }),
      );
    expect(await check()).toBe(false);
    await getDb().transaction(async (tx) => {
      const resolution = await resolveMultiServiceApproval({
        tx,
        partnerAccountId: accountId,
        requestedByMembershipId: membershipId,
        serviceKeys: keys,
        locationId,
        amountMinor: 25000,
        currency: "USD",
        poNumber: null,
        costCenter: null,
      });
      if (!resolution.required)
        throw new Error("Second selected service must require approval");
      const values = buildPartnerApprovalRequestInsert({
        resolution,
        target: {
          kind: "booking_draft",
          id: combinedId,
          partnerAccountId: accountId,
        },
        now,
      });
      const [row] = await tx
        .insert(partnerApprovalRequests)
        .values({
          ...values,
          requestSnapshot: {
            ...values.requestSnapshot,
            modelVersion: 2,
            serviceKeys: keys,
          },
          state: "approved_needs_reschedule",
          resolvedAt: now,
        })
        .returning({ id: partnerApprovalRequests.id });
      return row!.id;
    });
    expect(await check()).toBe(true);
    expect(await check({ totalMaxCents: 26000 })).toBe(false);
    expect(await check({ totalMinCents: 26000, totalMaxCents: 26000 })).toBe(
      false,
    );
    // A later service edit cannot borrow the previously approved amount/rules.
    const [draft] = await getDb()
      .select()
      .from(partnerBookingDrafts)
      .where(eq(partnerBookingDrafts.id, combinedId));
    await getDb()
      .update(partnerBookingDrafts)
      .set({
        serviceLines: [
          ...draft!.serviceLines,
          {
            id: randomUUID(),
            serviceKey: "soft-washing",
            description: "Wash the additional building exterior",
            scope: {},
            selectedAddOns: [],
            proofRequirements: {},
          },
        ],
      })
      .where(eq(partnerBookingDrafts.id, combinedId));
    expect(await check()).toBe(false);
  });
});
