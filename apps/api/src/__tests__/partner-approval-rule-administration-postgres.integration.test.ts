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
  createPartnerApprovalRuleAsStaff,
  updatePartnerApprovalRuleAsStaff,
} from "@/lib/partner-approval-rule-administration";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

type Fixture = Readonly<{
  accountId: string;
  otherAccountId: string;
  teamMemberId: string;
  membershipId: string;
  otherMembershipId: string;
  partnerUserId: string;
  otherPartnerUserId: string;
  locationId: string;
  draftId: string;
  serviceKey: string;
}>;

type DatabaseError = Readonly<{ code?: unknown; constraint_name?: unknown }>;

function deepestDatabaseError(error: unknown): DatabaseError {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (
    typeof current === "object" &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (!record["cause"]) return record;
    current = record["cause"];
  }
  return {};
}

async function createFixture(): Promise<Fixture> {
  const accountId = randomUUID();
  const otherAccountId = randomUUID();
  const teamMemberId = randomUUID();
  const partnerUserId = randomUUID();
  const otherPartnerUserId = randomUUID();
  const membershipId = randomUUID();
  const otherMembershipId = randomUUID();
  const locationId = randomUUID();
  const draftId = randomUUID();
  const suffix = accountId.replaceAll("-", "").slice(0, 12);
  const serviceKey = `approval-${suffix}`;
  const acceptedAt = new Date("2026-09-01T12:00:00.000Z");

  await getDb().transaction(async (tx) => {
    await tx.insert(teamMembers).values({
      id: teamMemberId,
      name: `Approval operator ${suffix}`,
    });
    await tx.insert(partnerAccounts).values([
      {
        id: accountId,
        name: `Approval account ${suffix}`,
        normalizedName: `approval account ${suffix}`,
      },
      {
        id: otherAccountId,
        name: `Other approval account ${suffix}`,
        normalizedName: `other approval account ${suffix}`,
      },
    ]);
    await tx.insert(partnerUsers).values([
      {
        id: partnerUserId,
        email: `approval-${suffix}@example.test`,
        normalizedEmail: `approval-${suffix}@example.test`,
        name: "Approval requester",
      },
      {
        id: otherPartnerUserId,
        email: `approval-other-${suffix}@example.test`,
        normalizedEmail: `approval-other-${suffix}@example.test`,
        name: "Other approval requester",
      },
    ]);
    await tx.insert(partnerAccountMemberships).values([
      {
        id: membershipId,
        partnerAccountId: accountId,
        partnerUserId,
        roleKey: "operations",
        status: "active",
        acceptedAt,
      },
      {
        id: otherMembershipId,
        partnerAccountId: otherAccountId,
        partnerUserId: otherPartnerUserId,
        roleKey: "operations",
        status: "active",
        acceptedAt,
      },
    ]);
    await tx.insert(partnerServiceCatalog).values({
      key: serviceKey,
      label: `Approval service ${suffix}`,
      description: "Disposable integration-test service.",
      active: true,
    });
    await tx.insert(partnerAccountLocations).values({
      id: locationId,
      partnerAccountId: accountId,
      siteName: "Approval test location",
      addressLine1: "1 Test Way",
      city: "New York",
      state: "NY",
      postalCode: "10001",
      active: true,
    });
    await tx.insert(partnerBookingDrafts).values({
      id: draftId,
      partnerAccountId: accountId,
      createdByMembershipId: membershipId,
      locationId,
      serviceKey,
    });
  });

  return {
    accountId,
    otherAccountId,
    teamMemberId,
    membershipId,
    otherMembershipId,
    partnerUserId,
    otherPartnerUserId,
    locationId,
    draftId,
    serviceKey,
  };
}

async function deleteFixture(fixture: Fixture): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .delete(partnerApprovalRequests)
      .where(eq(partnerApprovalRequests.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerApprovalRules)
      .where(eq(partnerApprovalRules.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerBookingDrafts)
      .where(eq(partnerBookingDrafts.partnerAccountId, fixture.accountId));
    await tx
      .update(partnerAccounts)
      .set({ defaultPartnerLocationId: null })
      .where(eq(partnerAccounts.id, fixture.accountId));
    await tx
      .delete(partnerAccountLocations)
      .where(eq(partnerAccountLocations.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerAccountMemberships)
      .where(
        and(
          eq(partnerAccountMemberships.partnerAccountId, fixture.accountId),
          eq(partnerAccountMemberships.id, fixture.membershipId),
        ),
      );
    await tx
      .delete(partnerAccountMemberships)
      .where(
        and(
          eq(
            partnerAccountMemberships.partnerAccountId,
            fixture.otherAccountId,
          ),
          eq(partnerAccountMemberships.id, fixture.otherMembershipId),
        ),
      );
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.accountId));
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.otherAccountId));
    await tx
      .delete(partnerUsers)
      .where(eq(partnerUsers.id, fixture.partnerUserId));
    await tx
      .delete(partnerUsers)
      .where(eq(partnerUsers.id, fixture.otherPartnerUserId));
    await tx
      .delete(partnerServiceCatalog)
      .where(eq(partnerServiceCatalog.key, fixture.serviceKey));
    await tx
      .delete(teamMembers)
      .where(eq(teamMembers.id, fixture.teamMemberId));
  });
}

function ruleValues(fixture: Fixture, name: string) {
  return {
    name,
    conditions: {
      serviceKeys: [fixture.serviceKey],
      locationIds: [fixture.locationId],
      requesterRoleKeys: ["operations"],
    },
    requiredDecisionCount: 1,
    active: true,
  } as const;
}

describeWithDatabase("Partner approval-rule PostgreSQL integrity", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await deleteFixture(fixture);
    }
  });

  afterAll(async () => {
    await closeDbForTests();
  });

  it("records Team provenance and rejects mixed or cross-account creators", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const created = await getDb().transaction((tx) =>
      createPartnerApprovalRuleAsStaff(tx, {
        partnerAccountId: fixture.accountId,
        values: ruleValues(fixture, "Team-authored rule"),
        teamMemberId: fixture.teamMemberId,
      }),
    );
    expect(created.rule.creator).toEqual({
      type: "team_member",
      id: fixture.teamMemberId,
    });
    expect(created.rule.updatedByTeamMemberId).toBe(fixture.teamMemberId);

    let mixedCreatorError: DatabaseError = {};
    try {
      await getDb()
        .insert(partnerApprovalRules)
        .values({
          partnerAccountId: fixture.accountId,
          name: "Mixed creator",
          conditions: {},
          requiredApproverCapabilities: ["approvals.decide"],
          createdByMembershipId: fixture.membershipId,
          createdByTeamMemberId: fixture.teamMemberId,
        });
    } catch (error) {
      mixedCreatorError = deepestDatabaseError(error);
    }
    expect(mixedCreatorError.code).toBe("23514");
    expect(mixedCreatorError.constraint_name).toBe(
      "partner_approval_rules_creator_provenance_check",
    );

    let crossAccountCreatorError: DatabaseError = {};
    try {
      await getDb()
        .insert(partnerApprovalRules)
        .values({
          partnerAccountId: fixture.accountId,
          name: "Cross-account creator",
          conditions: {},
          requiredApproverCapabilities: ["approvals.decide"],
          createdByMembershipId: fixture.otherMembershipId,
        });
    } catch (error) {
      crossAccountCreatorError = deepestDatabaseError(error);
    }
    expect(crossAccountCreatorError.code).toBe("23503");
    expect(crossAccountCreatorError.constraint_name).toBe(
      "partner_approval_rules_creator_membership_account_fk",
    );
  });

  it("serializes concurrent activation at the 50-rule account cap", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await getDb()
      .insert(partnerApprovalRules)
      .values(
        Array.from({ length: 49 }, (_, index) => ({
          partnerAccountId: fixture.accountId,
          name: `Existing rule ${index + 1}`,
          conditions: {},
          requiredApproverCapabilities: ["approvals.decide"],
          createdByTeamMemberId: fixture.teamMemberId,
          updatedByTeamMemberId: fixture.teamMemberId,
        })),
      );

    const attempts = await Promise.allSettled([
      getDb().transaction((tx) =>
        createPartnerApprovalRuleAsStaff(tx, {
          partnerAccountId: fixture.accountId,
          values: ruleValues(fixture, "Concurrent rule A"),
          teamMemberId: fixture.teamMemberId,
        }),
      ),
      getDb().transaction((tx) =>
        createPartnerApprovalRuleAsStaff(tx, {
          partnerAccountId: fixture.accountId,
          values: ruleValues(fixture, "Concurrent rule B"),
          teamMemberId: fixture.teamMemberId,
        }),
      ),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    const active = await getDb()
      .select({ id: partnerApprovalRules.id })
      .from(partnerApprovalRules)
      .where(
        and(
          eq(partnerApprovalRules.partnerAccountId, fixture.accountId),
          eq(partnerApprovalRules.active, true),
        ),
      );
    expect(active).toHaveLength(50);
  });

  it("keeps captured request evidence immutable across later rule revisions", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const created = await getDb().transaction((tx) =>
      createPartnerApprovalRuleAsStaff(tx, {
        partnerAccountId: fixture.accountId,
        values: ruleValues(fixture, "Captured rule"),
        teamMemberId: fixture.teamMemberId,
      }),
    );
    const requestId = randomUUID();
    const capturedRules = [
      {
        id: created.rule.id,
        name: created.rule.name,
        version: created.rule.revision,
        conditions: created.rule.conditions,
        requiredApproverRoleKeys: [],
        requiredApproverCapabilities: ["approvals.decide"],
        requiredDecisionCount: 1,
      },
    ];
    const capturedRequest = {
      serviceKey: fixture.serviceKey,
      locationId: fixture.locationId,
      amountMinor: 75_000,
    };
    await getDb().insert(partnerApprovalRequests).values({
      id: requestId,
      partnerAccountId: fixture.accountId,
      bookingDraftId: fixture.draftId,
      requestedByMembershipId: fixture.membershipId,
      ruleSnapshot: capturedRules,
      requestSnapshot: capturedRequest,
      requiredDecisionCount: 1,
    });

    await getDb().transaction((tx) =>
      updatePartnerApprovalRuleAsStaff(tx, {
        partnerAccountId: fixture.accountId,
        ruleId: created.rule.id,
        values: {
          ...ruleValues(fixture, "Revised rule"),
          active: false,
        },
        expectedVersion: "1",
        teamMemberId: fixture.teamMemberId,
      }),
    );
    const [request] = await getDb()
      .select({
        ruleSnapshot: partnerApprovalRequests.ruleSnapshot,
        requestSnapshot: partnerApprovalRequests.requestSnapshot,
      })
      .from(partnerApprovalRequests)
      .where(eq(partnerApprovalRequests.id, requestId))
      .limit(1);
    expect(request?.ruleSnapshot).toEqual(capturedRules);
    expect(request?.requestSnapshot).toEqual(capturedRequest);

    let immutableError: DatabaseError = {};
    try {
      await getDb()
        .update(partnerApprovalRequests)
        .set({ requestSnapshot: { ...capturedRequest, amountMinor: 80_000 } })
        .where(eq(partnerApprovalRequests.id, requestId));
    } catch (error) {
      immutableError = deepestDatabaseError(error);
    }
    expect(immutableError.code).toBe("23514");
  });
});
