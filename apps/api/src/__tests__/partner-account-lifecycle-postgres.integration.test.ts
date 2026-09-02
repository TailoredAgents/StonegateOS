import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerLoginTokens,
  partnerRoleTemplates,
  partnerSessions,
  partnerUsers,
  teamMembers,
} from "@/db";
import {
  mutatePartnerAccountLifecycleAsStaff,
  recoverPartnerAdministratorAsTeamOwner,
} from "@/lib/partner-account-lifecycle-administration";
import { prunePartnerAuthenticationMetadata } from "@/lib/partner-auth-retention";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

type Fixture = {
  accountId: string;
  teamMemberId: string;
  userId: string;
  membershipId: string;
};

function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

async function createFixture(): Promise<Fixture> {
  const accountId = randomUUID();
  const teamMemberId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const now = new Date();
  const suffix = accountId.slice(0, 8);
  const [operationsRole] = await getDb()
    .select({ id: partnerRoleTemplates.id })
    .from(partnerRoleTemplates)
    .where(
      and(
        eq(partnerRoleTemplates.key, "operations"),
        eq(partnerRoleTemplates.isSystem, true),
      ),
    )
    .limit(1);
  if (!operationsRole) throw new Error("operations_role_missing");
  await getDb().transaction(async (tx) => {
    await tx.insert(teamMembers).values({
      id: teamMemberId,
      name: `Partner lifecycle owner ${suffix}`,
    });
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: `Partner lifecycle account ${suffix}`,
      normalizedName: `partner lifecycle account ${suffix}`,
      portalAccessEnabled: true,
    });
    await tx.insert(partnerUsers).values({
      id: userId,
      email: `lifecycle-${suffix}@example.test`,
      normalizedEmail: `lifecycle-${suffix}@example.test`,
      name: `Lifecycle member ${suffix}`,
      identityStatus: "active",
      active: true,
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$fixture$fixture",
      passwordSetAt: now,
      mfaRequired: false,
      mfaEnrolledAt: now,
    });
    await tx.insert(partnerAccountMemberships).values({
      id: membershipId,
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleTemplateId: operationsRole.id,
      roleKey: "operations",
      status: "active",
      acceptedAt: now,
      migrationReviewStatus: "not_required",
    });
  });
  return { accountId, teamMemberId, userId, membershipId };
}

async function deleteFixture(fixture: Fixture): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .delete(partnerSessions)
      .where(eq(partnerSessions.partnerUserId, fixture.userId));
    await tx
      .delete(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId));
    await tx.delete(partnerUsers).where(eq(partnerUsers.id, fixture.userId));
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.accountId));
    await tx
      .delete(teamMembers)
      .where(eq(teamMembers.id, fixture.teamMemberId));
  });
}

describeWithDatabase("Partner account lifecycle PostgreSQL integrity", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await deleteFixture(fixture);
  });

  afterAll(async () => {
    await closeDbForTests();
  });

  it("suspends, reactivates, and closes without deleting the tenant", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const sessionId = randomUUID();
    await getDb()
      .insert(partnerSessions)
      .values({
        id: sessionId,
        partnerUserId: fixture.userId,
        activePartnerAccountId: fixture.accountId,
        activeMembershipId: fixture.membershipId,
        sessionHash: `lifecycle-${randomUUID()}`,
        authMethod: "password",
        securityVersion: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });

    const suspended = await getDb().transaction((tx) =>
      mutatePartnerAccountLifecycleAsStaff(tx, {
        partnerAccountId: fixture.accountId,
        action: "suspend",
        expectedVersion: "1",
        reason: "Security review requires temporary account containment.",
        changedByTeamMemberId: fixture.teamMemberId,
      }),
    );
    expect(suspended.account).toMatchObject({
      portalLifecycleStatus: "suspended",
      portalAccessEnabled: false,
      portalLifecycleRevision: 2,
    });
    expect(suspended.sessionsRevoked).toBe(1);

    const reactivated = await getDb().transaction((tx) =>
      mutatePartnerAccountLifecycleAsStaff(tx, {
        partnerAccountId: fixture.accountId,
        action: "reactivate",
        expectedVersion: "2",
        reason: "Security review completed and account access may resume.",
        changedByTeamMemberId: fixture.teamMemberId,
      }),
    );
    expect(reactivated.account).toMatchObject({
      portalLifecycleStatus: "active",
      portalAccessEnabled: true,
      portalLifecycleRevision: 3,
    });

    const closed = await getDb().transaction((tx) =>
      mutatePartnerAccountLifecycleAsStaff(tx, {
        partnerAccountId: fixture.accountId,
        action: "close",
        expectedVersion: "3",
        reason: "Contract ended and Team Owner approved portal closure.",
        changedByTeamMemberId: fixture.teamMemberId,
      }),
    );
    expect(closed.account).toMatchObject({
      id: fixture.accountId,
      portalLifecycleStatus: "closed",
      portalAccessEnabled: false,
      portalLifecycleRevision: 4,
    });
    await expect(
      getDb()
        .select({ id: partnerAccounts.id })
        .from(partnerAccounts)
        .where(eq(partnerAccounts.id, fixture.accountId)),
    ).resolves.toHaveLength(1);
  });

  it("recovers exactly one reviewed MFA-enrolled member when no Administrator exists", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    // PostgreSQL retains microseconds while JavaScript Date retains only
    // milliseconds. The service locks and revision-checks the row before the
    // update, so its write must not rely on a lossy timestamp equality check.
    await getDb().execute(sql`
      UPDATE "partner_account_memberships"
      SET "updated_at" = date_trunc('milliseconds', clock_timestamp())
        + interval '123 microseconds'
      WHERE "id" = ${fixture.membershipId}
    `);
    const [membership] = await getDb()
      .select({ updatedAt: partnerAccountMemberships.updatedAt })
      .from(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId))
      .limit(1);
    if (!membership) throw new Error("membership_missing");

    const result = await getDb().transaction((tx) =>
      recoverPartnerAdministratorAsTeamOwner(tx, {
        partnerAccountId: fixture.accountId,
        membershipId: fixture.membershipId,
        expectedVersion: membership.updatedAt.toISOString(),
        changedByTeamMemberId: fixture.teamMemberId,
      }),
    );
    expect(result).toMatchObject({
      partnerAccountId: fixture.accountId,
      membershipId: fixture.membershipId,
      roleKey: "administrator",
      accessLevel: "account",
    });
    const [updated] = await getDb()
      .select({
        roleKey: partnerAccountMemberships.roleKey,
        accessLevel: partnerAccountMemberships.accessLevel,
        mfaRequired: partnerUsers.mfaRequired,
      })
      .from(partnerAccountMemberships)
      .innerJoin(
        partnerUsers,
        eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
      )
      .where(eq(partnerAccountMemberships.id, fixture.membershipId))
      .limit(1);
    expect(updated).toEqual({
      roleKey: "administrator",
      accessLevel: "account",
      mfaRequired: true,
    });
  });

  it("prunes old session/token details while retaining identities and accounts", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const old = new Date("2025-01-01T00:00:00.000Z");
    const tokenId = randomUUID();
    const sessionId = randomUUID();
    await getDb()
      .insert(partnerLoginTokens)
      .values({
        id: tokenId,
        partnerUserId: fixture.userId,
        tokenHash: `${randomUUID()}${randomUUID()}`
          .replaceAll("-", "")
          .slice(0, 64),
        expiresAt: old,
        usedAt: old,
        createdAt: old,
      });
    await getDb()
      .insert(partnerSessions)
      .values({
        id: sessionId,
        partnerUserId: fixture.userId,
        activePartnerAccountId: fixture.accountId,
        activeMembershipId: fixture.membershipId,
        sessionHash: `old-${randomUUID()}`,
        authMethod: "password",
        securityVersion: 1,
        deviceName: "Old browser",
        ip: "192.0.2.1",
        userAgent: "Old test agent",
        expiresAt: old,
        revokedAt: old,
        createdAt: old,
        lastSeenAt: old,
      });

    const result = await prunePartnerAuthenticationMetadata({
      now: new Date("2026-09-02T12:00:00.000Z"),
      limit: 100,
    });
    expect(result.sessionsSanitized).toBeGreaterThanOrEqual(1);
    expect(result.loginTokensDeleted).toBeGreaterThanOrEqual(1);
    const [session] = await getDb()
      .select({
        hash: partnerSessions.sessionHash,
        device: partnerSessions.deviceName,
        ip: partnerSessions.ip,
        userAgent: partnerSessions.userAgent,
      })
      .from(partnerSessions)
      .where(eq(partnerSessions.id, sessionId))
      .limit(1);
    expect(session).toMatchObject({ device: null, ip: null, userAgent: null });
    expect(session?.hash.startsWith("archived:")).toBe(true);
    const tokenRows = await getDb()
      .select({ id: partnerLoginTokens.id })
      .from(partnerLoginTokens)
      .where(eq(partnerLoginTokens.id, tokenId));
    expect(tokenRows).toHaveLength(0);
    const retained = await getDb().execute(sql`
      SELECT
        EXISTS (SELECT 1 FROM "partner_users" WHERE "id" = ${fixture.userId}) AS "userExists",
        EXISTS (SELECT 1 FROM "partner_accounts" WHERE "id" = ${fixture.accountId}) AS "accountExists"
    `);
    const row = resultRows(retained)[0];
    expect(row).toMatchObject({ userExists: true, accountExists: true });
  });
});
