import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  closeDbForTests,
  getDb,
  partnerAccountCancellationPolicies,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccountMergeCases,
  partnerAccountSchedulingPolicies,
  partnerAccounts,
  partnerBookingDrafts,
  partnerUsers,
  teamMembers,
} from "@/db";
import {
  completePartnerAccountMergeCase,
  initiatePartnerAccountMergeCase,
} from "@/lib/partner-account-merge-administration";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import {
  mergeDuplicatePartnerLocation,
  restoreMergedPartnerLocation,
} from "@/lib/partner-location-merge";
import type { TeamMutationFailure } from "@/lib/team-mutation";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

type LocationMergeFixture = Readonly<{
  accountId: string;
  otherAccountId: string;
  membershipId: string;
  otherMembershipId: string;
  partnerUserId: string;
  otherPartnerUserId: string;
  sourceLocationId: string;
  targetLocationId: string;
  otherLocationId: string;
  principal: PartnerPrincipal;
}>;

type AccountMergeFixture = Readonly<{
  teamMemberId: string;
  emptySourceAccountId: string;
  populatedSourceAccountId: string;
  targetAccountId: string;
  populatedUserId: string;
  populatedMembershipId: string;
  populatedLocationId: string;
  populatedDraftId: string;
}>;

function partnerPrincipal(input: {
  accountId: string;
  accountName: string;
  membershipId: string;
  partnerUserId: string;
  email: string;
  now: Date;
}): PartnerPrincipal {
  const accountAccess = Object.freeze({
    accountId: input.accountId,
    accountName: input.accountName,
    accountStatus: "active_partner",
    membershipId: input.membershipId,
    membershipStatus: "active" as const,
    roleKey: "operations",
    persona: "property_manager" as const,
    accessLevel: "account" as const,
    accessScope: Object.freeze({}),
    preferences: Object.freeze({}),
    capabilities: Object.freeze(["properties.manage" as const]),
    isDefault: true,
    legacyOrgContactId: null,
    source: "membership" as const,
  });
  return Object.freeze({
    type: "partner",
    partnerUserId: input.partnerUserId,
    email: input.email,
    name: "Location merge operator",
    passwordSet: true,
    accountId: input.accountId,
    accountName: input.accountName,
    membershipId: input.membershipId,
    roleKey: "operations",
    persona: "property_manager",
    accessLevel: "account",
    accessScope: Object.freeze({}),
    preferences: Object.freeze({}),
    legacyOrgContactId: null,
    capabilities: ["properties.manage"],
    accessSource: "membership",
    session: Object.freeze({
      id: randomUUID(),
      authMethod: "password",
      assuranceLevel: "aal1",
      mfaVerifiedAt: null,
      deviceName: "PostgreSQL merge test",
      createdAt: input.now,
      lastSeenAt: input.now,
      expiresAt: new Date(input.now.getTime() + 12 * 60 * 60 * 1_000),
    }),
    security: Object.freeze({
      mfaRequired: false,
      mfaEnrolled: false,
      mfaSatisfied: true,
    }),
    availableAccounts: [accountAccess],
  });
}

async function createLocationMergeFixture(): Promise<LocationMergeFixture> {
  const accountId = randomUUID();
  const otherAccountId = randomUUID();
  const membershipId = randomUUID();
  const otherMembershipId = randomUUID();
  const partnerUserId = randomUUID();
  const otherPartnerUserId = randomUUID();
  const sourceLocationId = randomUUID();
  const targetLocationId = randomUUID();
  const otherLocationId = randomUUID();
  const now = new Date("2026-09-10T12:00:00.000Z");
  const suffix = accountId.replaceAll("-", "").slice(0, 12);
  const accountName = `Merge portfolio ${suffix}`;
  const email = `merge-location-${suffix}@example.test`;
  await getDb().transaction(async (tx) => {
    await tx.insert(partnerAccounts).values([
      {
        id: accountId,
        name: accountName,
        normalizedName: accountName.toLowerCase(),
        status: "active_partner",
        portalAccessEnabled: true,
      },
      {
        id: otherAccountId,
        name: `Other merge portfolio ${suffix}`,
        normalizedName: `other merge portfolio ${suffix}`,
        status: "active_partner",
        portalAccessEnabled: true,
      },
    ]);
    await tx.insert(partnerUsers).values([
      {
        id: partnerUserId,
        email,
        normalizedEmail: email,
        name: "Location merge operator",
        identityStatus: "active",
      },
      {
        id: otherPartnerUserId,
        email: `merge-location-other-${suffix}@example.test`,
        normalizedEmail: `merge-location-other-${suffix}@example.test`,
        name: "Other location operator",
        identityStatus: "active",
      },
    ]);
    await tx.insert(partnerAccountMemberships).values([
      {
        id: membershipId,
        partnerAccountId: accountId,
        partnerUserId,
        roleKey: "operations",
        status: "active",
        acceptedAt: now,
      },
      {
        id: otherMembershipId,
        partnerAccountId: otherAccountId,
        partnerUserId: otherPartnerUserId,
        roleKey: "operations",
        status: "active",
        acceptedAt: now,
      },
    ]);
    await tx.insert(partnerAccountLocations).values([
      {
        id: sourceLocationId,
        partnerAccountId: accountId,
        siteName: "North warehouse duplicate",
        externalPropertyId: `SOURCE-${suffix}`,
        addressLine1: "10 North Main Street",
        addressLine2: "Suite 200",
        city: "Atlanta",
        state: "GA",
        postalCode: "30303",
        createdByMembershipId: membershipId,
      },
      {
        id: targetLocationId,
        partnerAccountId: accountId,
        siteName: "North warehouse",
        externalPropertyId: `TARGET-${suffix}`,
        addressLine1: "10 N Main St",
        addressLine2: "Suite 200",
        city: "Atlanta",
        state: "GA",
        postalCode: "30303-1234",
        createdByMembershipId: membershipId,
      },
      {
        id: otherLocationId,
        partnerAccountId: otherAccountId,
        siteName: "Other tenant warehouse",
        externalPropertyId: `OTHER-${suffix}`,
        addressLine1: "10 North Main Street",
        addressLine2: "Suite 200",
        city: "Atlanta",
        state: "GA",
        postalCode: "30303",
        createdByMembershipId: otherMembershipId,
      },
    ]);
    await tx
      .update(partnerAccounts)
      .set({ defaultPartnerLocationId: sourceLocationId })
      .where(eq(partnerAccounts.id, accountId));
    await tx
      .update(partnerAccounts)
      .set({ defaultPartnerLocationId: otherLocationId })
      .where(eq(partnerAccounts.id, otherAccountId));
  });
  return {
    accountId,
    otherAccountId,
    membershipId,
    otherMembershipId,
    partnerUserId,
    otherPartnerUserId,
    sourceLocationId,
    targetLocationId,
    otherLocationId,
    principal: partnerPrincipal({
      accountId,
      accountName,
      membershipId,
      partnerUserId,
      email,
      now,
    }),
  };
}

async function deleteLocationMergeFixture(
  fixture: LocationMergeFixture,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL session_replication_role = 'replica'"));
    await tx
      .delete(auditLogs)
      .where(eq(auditLogs.actorId, fixture.partnerUserId));
    await tx.execute(sql.raw("SET LOCAL session_replication_role = 'origin'"));
    await tx
      .update(partnerAccounts)
      .set({ defaultPartnerLocationId: null })
      .where(
        inArray(partnerAccounts.id, [
          fixture.accountId,
          fixture.otherAccountId,
        ]),
      );
    await tx
      .delete(partnerAccountLocations)
      .where(
        inArray(partnerAccountLocations.partnerAccountId, [
          fixture.accountId,
          fixture.otherAccountId,
        ]),
      );
    await tx
      .delete(partnerAccountMemberships)
      .where(
        inArray(partnerAccountMemberships.id, [
          fixture.membershipId,
          fixture.otherMembershipId,
        ]),
      );
    await tx
      .delete(partnerAccounts)
      .where(
        inArray(partnerAccounts.id, [
          fixture.accountId,
          fixture.otherAccountId,
        ]),
      );
    await tx
      .delete(partnerUsers)
      .where(
        inArray(partnerUsers.id, [
          fixture.partnerUserId,
          fixture.otherPartnerUserId,
        ]),
      );
  });
}

async function createAccountMergeFixture(): Promise<AccountMergeFixture> {
  const teamMemberId = randomUUID();
  const emptySourceAccountId = randomUUID();
  const populatedSourceAccountId = randomUUID();
  const targetAccountId = randomUUID();
  const populatedUserId = randomUUID();
  const populatedMembershipId = randomUUID();
  const populatedLocationId = randomUUID();
  const populatedDraftId = randomUUID();
  const now = new Date("2026-09-10T12:00:00.000Z");
  const suffix = emptySourceAccountId.replaceAll("-", "").slice(0, 12);
  await getDb().transaction(async (tx) => {
    await tx.insert(teamMembers).values({
      id: teamMemberId,
      name: `Partner merge owner ${suffix}`,
    });
    await tx.insert(partnerAccounts).values([
      {
        id: emptySourceAccountId,
        name: `Empty merge source ${suffix}`,
        normalizedName: `empty merge source ${suffix}`,
        status: "active_partner",
        portalAccessEnabled: true,
      },
      {
        id: populatedSourceAccountId,
        name: `Populated merge source ${suffix}`,
        normalizedName: `populated merge source ${suffix}`,
        status: "active_partner",
        portalAccessEnabled: true,
      },
      {
        id: targetAccountId,
        name: `Merge destination ${suffix}`,
        normalizedName: `merge destination ${suffix}`,
        status: "active_partner",
        portalAccessEnabled: true,
      },
    ]);
    const populatedEmail = `populated-merge-${suffix}@example.test`;
    await tx.insert(partnerUsers).values({
      id: populatedUserId,
      email: populatedEmail,
      normalizedEmail: populatedEmail,
      name: "Populated source operator",
      identityStatus: "active",
    });
    await tx.insert(partnerAccountMemberships).values({
      id: populatedMembershipId,
      partnerAccountId: populatedSourceAccountId,
      partnerUserId: populatedUserId,
      roleKey: "operations",
      status: "active",
      acceptedAt: now,
    });
    await tx.insert(partnerAccountLocations).values({
      id: populatedLocationId,
      partnerAccountId: populatedSourceAccountId,
      siteName: "Populated source warehouse",
      externalPropertyId: `POPULATED-${suffix}`,
      addressLine1: "30 Merge Safety Way",
      city: "Atlanta",
      state: "GA",
      postalCode: "30303",
      createdByMembershipId: populatedMembershipId,
    });
    await tx
      .update(partnerAccounts)
      .set({ defaultPartnerLocationId: populatedLocationId })
      .where(eq(partnerAccounts.id, populatedSourceAccountId));
    await tx.insert(partnerBookingDrafts).values({
      id: populatedDraftId,
      partnerAccountId: populatedSourceAccountId,
      createdByMembershipId: populatedMembershipId,
      locationId: populatedLocationId,
      state: "draft",
    });
  });
  return {
    teamMemberId,
    emptySourceAccountId,
    populatedSourceAccountId,
    targetAccountId,
    populatedUserId,
    populatedMembershipId,
    populatedLocationId,
    populatedDraftId,
  };
}

async function deleteAccountMergeFixture(
  fixture: AccountMergeFixture,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .delete(partnerAccountMergeCases)
      .where(
        inArray(partnerAccountMergeCases.sourcePartnerAccountId, [
          fixture.emptySourceAccountId,
          fixture.populatedSourceAccountId,
        ]),
      );
    await tx
      .delete(partnerBookingDrafts)
      .where(eq(partnerBookingDrafts.id, fixture.populatedDraftId));
    await tx
      .update(partnerAccounts)
      .set({ defaultPartnerLocationId: null })
      .where(eq(partnerAccounts.id, fixture.populatedSourceAccountId));
    await tx
      .delete(partnerAccountLocations)
      .where(eq(partnerAccountLocations.id, fixture.populatedLocationId));
    await tx
      .delete(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.populatedMembershipId));
    await tx
      .delete(partnerUsers)
      .where(eq(partnerUsers.id, fixture.populatedUserId));
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.emptySourceAccountId));
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.populatedSourceAccountId));
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.targetAccountId));
    await tx
      .delete(teamMembers)
      .where(eq(teamMembers.id, fixture.teamMemberId));
  });
}

describeWithDatabase(
  "Partner location and account merge PostgreSQL behavior",
  () => {
    const locationFixtures: LocationMergeFixture[] = [];
    const accountFixtures: AccountMergeFixture[] = [];

    afterEach(async () => {
      for (const fixture of locationFixtures.splice(0)) {
        await deleteLocationMergeFixture(fixture);
      }
      for (const fixture of accountFixtures.splice(0)) {
        await deleteAccountMergeFixture(fixture);
      }
    });

    afterAll(async () => {
      await closeDbForTests();
    });

    it("merges and restores a duplicate location without rewriting or deleting either location", async () => {
      const fixture = await createLocationMergeFixture();
      locationFixtures.push(fixture);

      const merged = await getDb().transaction((tx) =>
        mergeDuplicatePartnerLocation(tx, {
          principal: fixture.principal,
          sourceLocationId: fixture.sourceLocationId,
          targetLocationId: fixture.targetLocationId,
          expectedVersion: 1,
          reason: "Duplicate created during the account location import.",
          correlationId: `merge-location-${fixture.sourceLocationId}`,
          idempotencyKeyHash: "a".repeat(64),
        }),
      );
      expect(merged).toMatchObject({
        kind: "success",
        defaultLocationId: fixture.targetLocationId,
        duplicateConfidence: 94,
        row: {
          id: fixture.sourceLocationId,
          active: false,
          mergedIntoLocationId: fixture.targetLocationId,
          mergedByMembershipId: fixture.membershipId,
          version: 2,
        },
      });

      const restored = await getDb().transaction((tx) =>
        restoreMergedPartnerLocation(tx, {
          principal: fixture.principal,
          locationId: fixture.sourceLocationId,
          expectedVersion: 2,
          reason:
            "Restore the duplicate source while the portfolio is reviewed.",
          correlationId: `restore-location-${fixture.sourceLocationId}`,
          idempotencyKeyHash: "b".repeat(64),
        }),
      );
      expect(restored).toMatchObject({
        kind: "success",
        defaultLocationId: fixture.targetLocationId,
        row: {
          id: fixture.sourceLocationId,
          active: true,
          addressLine1: "10 North Main Street",
          addressLine2: "Suite 200",
          mergedIntoLocationId: null,
          mergedAt: null,
          mergedByMembershipId: null,
          mergeReason: null,
          version: 3,
        },
      });
      const rows = await getDb()
        .select({ id: partnerAccountLocations.id })
        .from(partnerAccountLocations)
        .where(eq(partnerAccountLocations.partnerAccountId, fixture.accountId));
      expect(new Set(rows.map(({ id }) => id))).toEqual(
        new Set([fixture.sourceLocationId, fixture.targetLocationId]),
      );
    });

    it("returns an opaque miss without changing a cross-account merge target", async () => {
      const fixture = await createLocationMergeFixture();
      locationFixtures.push(fixture);

      const result = await getDb().transaction((tx) =>
        mergeDuplicatePartnerLocation(tx, {
          principal: fixture.principal,
          sourceLocationId: fixture.sourceLocationId,
          targetLocationId: fixture.otherLocationId,
          expectedVersion: 1,
          reason:
            "Attempted duplicate merge must remain inside the selected account.",
          correlationId: `cross-account-location-${fixture.sourceLocationId}`,
          idempotencyKeyHash: "c".repeat(64),
        }),
      );
      expect(result).toEqual({ kind: "not_found" });
      const rows = await getDb()
        .select({
          id: partnerAccountLocations.id,
          active: partnerAccountLocations.active,
          mergedIntoLocationId: partnerAccountLocations.mergedIntoLocationId,
          version: partnerAccountLocations.version,
        })
        .from(partnerAccountLocations)
        .where(
          inArray(partnerAccountLocations.id, [
            fixture.sourceLocationId,
            fixture.otherLocationId,
          ]),
        );
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            id: fixture.sourceLocationId,
            active: true,
            mergedIntoLocationId: null,
            version: 1,
          },
          {
            id: fixture.otherLocationId,
            active: true,
            mergedIntoLocationId: null,
            version: 1,
          },
        ]),
      );
    });

    it("marks an otherwise empty source ready and completes the non-destructive account merge", async () => {
      const fixture = await createAccountMergeFixture();
      accountFixtures.push(fixture);

      const prepared = await getDb().transaction((tx) =>
        initiatePartnerAccountMergeCase(tx, {
          sourcePartnerAccountId: fixture.emptySourceAccountId,
          targetPartnerAccountId: fixture.targetAccountId,
          sourceExpectedVersion: "1",
          reason:
            "This empty duplicate account should be retained as merged evidence.",
          teamMemberId: fixture.teamMemberId,
        }),
      );
      expect(prepared.counts).toEqual({});
      expect(prepared.mergeCase).toMatchObject({
        sourcePartnerAccountId: fixture.emptySourceAccountId,
        targetPartnerAccountId: fixture.targetAccountId,
        state: "ready",
        version: 1,
      });

      const completed = await getDb().transaction((tx) =>
        completePartnerAccountMergeCase(tx, {
          mergeCaseId: prepared.mergeCase.id,
          expectedVersion: String(prepared.mergeCase.version),
          resolutionNote:
            "Confirmed the source has no access or business bindings to reconcile.",
          teamMemberId: fixture.teamMemberId,
        }),
      );
      expect(completed.mergeCase).toMatchObject({
        state: "completed",
        version: 2,
      });
      expect(completed.sourceAccount).toMatchObject({
        id: fixture.emptySourceAccountId,
        portalLifecycleStatus: "merged",
        portalAccessEnabled: false,
        portalLifecyclePriorAccessEnabled: true,
        portalLifecycleRevision: 2,
        mergedIntoPartnerAccountId: fixture.targetAccountId,
      });
      const [retainedSource, schedulingPolicy, cancellationPolicy] =
        await Promise.all([
          getDb()
            .select({ id: partnerAccounts.id })
            .from(partnerAccounts)
            .where(eq(partnerAccounts.id, fixture.emptySourceAccountId)),
          getDb()
            .select({ id: partnerAccountSchedulingPolicies.partnerAccountId })
            .from(partnerAccountSchedulingPolicies)
            .where(
              eq(
                partnerAccountSchedulingPolicies.partnerAccountId,
                fixture.emptySourceAccountId,
              ),
            ),
          getDb()
            .select({ id: partnerAccountCancellationPolicies.partnerAccountId })
            .from(partnerAccountCancellationPolicies)
            .where(
              eq(
                partnerAccountCancellationPolicies.partnerAccountId,
                fixture.emptySourceAccountId,
              ),
            ),
        ]);
      expect(retainedSource).toHaveLength(1);
      expect(schedulingPolicy).toHaveLength(1);
      expect(cancellationPolicy).toHaveLength(1);
    });

    it("keeps membership, location, and booking bindings in reconciliation", async () => {
      const fixture = await createAccountMergeFixture();
      accountFixtures.push(fixture);

      const prepared = await getDb().transaction((tx) =>
        initiatePartnerAccountMergeCase(tx, {
          sourcePartnerAccountId: fixture.populatedSourceAccountId,
          targetPartnerAccountId: fixture.targetAccountId,
          sourceExpectedVersion: "1",
          reason:
            "This populated source must remain contained until every binding is reconciled.",
          teamMemberId: fixture.teamMemberId,
        }),
      );
      expect(prepared.mergeCase.state).toBe("needs_reconciliation");
      expect(prepared.counts).toMatchObject({
        partner_account_memberships: 1,
        partner_account_locations: 1,
        partner_booking_drafts: 1,
      });
      expect(prepared.counts).not.toHaveProperty(
        "partner_account_scheduling_policies",
      );
      expect(prepared.counts).not.toHaveProperty(
        "partner_account_cancellation_policies",
      );
      await expect(
        getDb().transaction((tx) =>
          completePartnerAccountMergeCase(tx, {
            mergeCaseId: prepared.mergeCase.id,
            expectedVersion: String(prepared.mergeCase.version),
            resolutionNote:
              "Completion must be denied because account bindings still remain.",
            teamMemberId: fixture.teamMemberId,
          }),
        ),
      ).rejects.toMatchObject<TeamMutationFailure>({ code: "conflict" });
    });
  },
);
