import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerAuthChallenges,
  partnerAuthTransactions,
  partnerSessions,
  partnerUsers,
} from "@/db";
import { hashPartnerPassword } from "@/lib/partner-password-crypto";
import { resolvePartnerPrincipal } from "@/lib/partner-account-authorization";
import {
  loginWithPassword,
  requirePartnerSession,
  sha256Base64Url,
} from "@/lib/partner-portal-auth";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

const PASSWORD = "correct horse battery staple";
const REQUEST_IP = "203.0.113.88";
const REQUEST_USER_AGENT = "Stonegate password cutover integration";

type Fixture = {
  accountId: string;
  userId: string;
  membershipId: string;
  sourceChallengeId: string | null;
  authTransactionId: string | null;
  email: string;
  securityVersion: number;
};

const fixtures: Fixture[] = [];
let passwordHash = "";

function authRequest(token?: string): NextRequest {
  return new NextRequest(
    "https://api.stonegate.example/api/portal/v2/session",
    {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        origin: "https://stonegate.example",
        "x-correlation-id": `password-cutover-${randomUUID()}`,
        "x-forwarded-for": REQUEST_IP,
        "user-agent": REQUEST_USER_AGENT,
      },
    },
  );
}

async function createFixture(input?: {
  identityStatus?: "pending_activation" | "active";
  membershipStatus?: "invited" | "active";
  migrationReviewStatus?:
    | "not_required"
    | "pending"
    | "approved"
    | "quarantined";
  securityVersion?: number;
  transactionSecurityVersion?: number;
  withRetiredActivationHandoff?: boolean;
}): Promise<Fixture> {
  const db = getDb();
  const now = new Date();
  const accountId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const sourceChallengeId = input?.withRetiredActivationHandoff
    ? randomUUID()
    : null;
  const authTransactionId = input?.withRetiredActivationHandoff
    ? randomUUID()
    : null;
  const securityVersion = input?.securityVersion ?? 3;
  const identityStatus = input?.identityStatus ?? "pending_activation";
  const membershipStatus = input?.membershipStatus ?? "invited";
  const email = `password-cutover-${userId}@example.test`;

  await db.transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: `Password cutover ${accountId}`,
      normalizedName: `password cutover ${accountId}`,
      status: "active_partner",
      portalAccessEnabled: true,
      portalLifecycleStatus: "active",
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(partnerUsers).values({
      id: userId,
      orgContactId: null,
      email,
      normalizedEmail: email,
      name: "Password Cutover Partner",
      active: identityStatus === "active",
      identityStatus,
      emailVerifiedAt: now,
      passwordHash,
      passwordHashVersion: 2,
      passwordSetAt: now,
      mfaRequired: false,
      mfaEnrolledAt: null,
      securityVersion,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(partnerAccountMemberships).values({
      id: membershipId,
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleKey: "administrator",
      status: membershipStatus,
      persona: "commercial_client",
      accessLevel: "account",
      isDefault: membershipStatus === "active",
      invitedAt: now,
      acceptedAt: membershipStatus === "active" ? now : null,
      migrationReviewStatus: input?.migrationReviewStatus ?? "not_required",
      createdAt: now,
      updatedAt: now,
    });

    if (sourceChallengeId && authTransactionId) {
      await tx.insert(partnerAuthChallenges).values({
        id: sourceChallengeId,
        purpose: "account_activation",
        status: "consumed",
        normalizedEmail: email,
        tokenHash: null,
        generation: 1,
        partnerUserId: userId,
        partnerAccountId: accountId,
        partnerMembershipId: membershipId,
        securityVersionSnapshot:
          input?.transactionSecurityVersion ?? securityVersion,
        requestedIp: REQUEST_IP,
        requestedUserAgent: REQUEST_USER_AGENT,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
        consumedIp: REQUEST_IP,
        consumedUserAgent: REQUEST_USER_AGENT,
        consumedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(partnerAuthTransactions).values({
        id: authTransactionId,
        partnerUserId: userId,
        partnerAccountId: accountId,
        partnerMembershipId: membershipId,
        tokenHash: sha256Base64Url(randomBytes(32).toString("base64url")),
        purpose: "activation_mfa_setup",
        sourceAuthChallengeId: sourceChallengeId,
        securityVersion: input?.transactionSecurityVersion ?? securityVersion,
        rememberMe: false,
        requestedIp: REQUEST_IP,
        requestedUserAgent: REQUEST_USER_AGENT,
        attemptCount: 0,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
        createdAt: now,
      });
    }
  });

  const fixture = {
    accountId,
    userId,
    membershipId,
    sourceChallengeId,
    authTransactionId,
    email,
    securityVersion,
  };
  fixtures.push(fixture);
  return fixture;
}

describeWithDatabase("Partner password cutover PostgreSQL boundary", () => {
  beforeAll(async () => {
    passwordHash = await hashPartnerPassword(PASSWORD);
  });

  afterEach(async () => {
    const pending = fixtures.splice(0);
    if (pending.length === 0) return;
    const db = getDb();
    const userIds = pending.map((fixture) => fixture.userId);
    const accountIds = pending.map((fixture) => fixture.accountId);
    await db.transaction(async (tx) => {
      await tx.delete(partnerUsers).where(inArray(partnerUsers.id, userIds));
      await tx
        .delete(partnerAccounts)
        .where(inArray(partnerAccounts.id, accountIds));
    });
  });

  afterAll(async () => {
    await closeDbForTests();
  });

  it("recovers an eligible pending activation handoff with the verified password", async () => {
    const now = new Date();
    const fixture = await createFixture({ withRetiredActivationHandoff: true });

    const result = await loginWithPassword(
      fixture.email,
      PASSWORD,
      authRequest(),
      { now },
    );

    expect(result).toMatchObject({
      kind: "authenticated",
      partnerUserId: fixture.userId,
    });
    expect(result?.sessionToken).toEqual(expect.any(String));

    const db = getDb();
    const [identity] = await db
      .select({
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        mfaRequired: partnerUsers.mfaRequired,
        mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, fixture.userId));
    const [membership] = await db
      .select({
        status: partnerAccountMemberships.status,
        acceptedAt: partnerAccountMemberships.acceptedAt,
      })
      .from(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId));
    const [handoff] = await db
      .select({ consumedAt: partnerAuthTransactions.consumedAt })
      .from(partnerAuthTransactions)
      .where(eq(partnerAuthTransactions.id, fixture.authTransactionId!));
    const sessions = await db
      .select({
        authMethod: partnerSessions.authMethod,
        assuranceLevel: partnerSessions.assuranceLevel,
        mfaVerifiedAt: partnerSessions.mfaVerifiedAt,
      })
      .from(partnerSessions)
      .where(eq(partnerSessions.partnerUserId, fixture.userId));

    expect(identity).toEqual({
      active: true,
      identityStatus: "active",
      mfaRequired: false,
      mfaEnrolledAt: null,
    });
    expect(membership?.status).toBe("active");
    expect(membership?.acceptedAt).toEqual(now);
    expect(handoff?.consumedAt).toEqual(now);
    expect(sessions).toEqual([
      {
        authMethod: "password",
        assuranceLevel: "aal1",
        mfaVerifiedAt: null,
      },
    ]);
  });

  it.each([
    {
      name: "a security-version mismatch",
      fixture: {
        withRetiredActivationHandoff: true,
        securityVersion: 4,
        transactionSecurityVersion: 3,
      },
    },
    {
      name: "a quarantined membership binding",
      fixture: {
        withRetiredActivationHandoff: true,
        migrationReviewStatus: "quarantined" as const,
      },
    },
  ])("refuses activation for $name", async ({ fixture: fixtureInput }) => {
    const fixture = await createFixture(fixtureInput);

    await expect(
      loginWithPassword(fixture.email, PASSWORD, authRequest()),
    ).resolves.toBeNull();

    const db = getDb();
    const [identity] = await db
      .select({
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, fixture.userId));
    const [membership] = await db
      .select({ status: partnerAccountMemberships.status })
      .from(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId));
    const sessions = await db
      .select({ id: partnerSessions.id })
      .from(partnerSessions)
      .where(eq(partnerSessions.partnerUserId, fixture.userId));

    expect(identity).toEqual({
      active: false,
      identityStatus: "pending_activation",
    });
    expect(membership?.status).toBe("invited");
    expect(sessions).toHaveLength(0);
  });

  it.each(["legacy", "magic_link", "mfa_step_up"] as const)(
    "rejects and revokes a rolling-deploy %s session",
    async (authMethod) => {
      const fixture = await createFixture({
        identityStatus: "active",
        membershipStatus: "active",
      });
      const rawToken = randomBytes(32).toString("base64url");
      const sessionId = randomUUID();
      await getDb()
        .insert(partnerSessions)
        .values({
          id: sessionId,
          partnerUserId: fixture.userId,
          activePartnerAccountId: fixture.accountId,
          activeMembershipId: fixture.membershipId,
          sessionHash: sha256Base64Url(rawToken),
          authMethod,
          assuranceLevel: "aal1",
          securityVersion: fixture.securityVersion,
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        });

      await expect(
        requirePartnerSession(authRequest(rawToken)),
      ).resolves.toEqual({
        ok: false,
        status: 401,
        error: "session_revoked",
      });
      const [session] = await getDb()
        .select({ revokedAt: partnerSessions.revokedAt })
        .from(partnerSessions)
        .where(eq(partnerSessions.id, sessionId));
      expect(session?.revokedAt).toBeInstanceOf(Date);
    },
  );

  it("keeps a feature-flagged magic-link session read-only at the principal boundary", async () => {
    const fixture = await createFixture({
      identityStatus: "active",
      membershipStatus: "active",
    });
    const rawToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    await getDb()
      .insert(partnerSessions)
      .values({
        id: sessionId,
        partnerUserId: fixture.userId,
        activePartnerAccountId: fixture.accountId,
        activeMembershipId: fixture.membershipId,
        sessionHash: sha256Base64Url(rawToken),
        authMethod: "magic_link",
        assuranceLevel: "aal1",
        securityVersion: fixture.securityVersion,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      });

    const previousFlag =
      process.env["PARTNER_PORTAL_ROUTINE_MAGIC_LOGIN_ENABLED"];
    process.env["PARTNER_PORTAL_ROUTINE_MAGIC_LOGIN_ENABLED"] = "true";
    try {
      await expect(
        resolvePartnerPrincipal(
          new NextRequest(
            "https://api.stonegate.example/api/portal/v2/notification-preferences",
            {
              method: "PUT",
              headers: { authorization: `Bearer ${rawToken}` },
            },
          ),
        ),
      ).resolves.toEqual({ ok: false, status: 403, error: "forbidden" });
    } finally {
      if (previousFlag === undefined) {
        delete process.env["PARTNER_PORTAL_ROUTINE_MAGIC_LOGIN_ENABLED"];
      } else {
        process.env["PARTNER_PORTAL_ROUTINE_MAGIC_LOGIN_ENABLED"] =
          previousFlag;
      }
    }

    const [session] = await getDb()
      .select({ revokedAt: partnerSessions.revokedAt })
      .from(partnerSessions)
      .where(eq(partnerSessions.id, sessionId));
    expect(session?.revokedAt).toBeNull();

    await expect(
      loginWithPassword(fixture.email, PASSWORD, authRequest()),
    ).resolves.toMatchObject({ kind: "authenticated" });
    const [retiredSession] = await getDb()
      .select({ revokedAt: partnerSessions.revokedAt })
      .from(partnerSessions)
      .where(eq(partnerSessions.id, sessionId));
    expect(retiredSession?.revokedAt).toBeInstanceOf(Date);
  });

  it("serializes simultaneous password logins through one stranded activation handoff", async () => {
    const fixture = await createFixture({ withRetiredActivationHandoff: true });
    const now = new Date();

    const results = await Promise.all([
      loginWithPassword(fixture.email, PASSWORD, authRequest(), { now }),
      loginWithPassword(fixture.email, PASSWORD, authRequest(), { now }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        kind: "authenticated",
        partnerUserId: fixture.userId,
      }),
      expect.objectContaining({
        kind: "authenticated",
        partnerUserId: fixture.userId,
      }),
    ]);
    expect(new Set(results.map((result) => result?.sessionToken)).size).toBe(2);

    const db = getDb();
    const [identity] = await db
      .select({
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, fixture.userId));
    const [membership] = await db
      .select({ status: partnerAccountMemberships.status })
      .from(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId));
    const [handoff] = await db
      .select({ consumedAt: partnerAuthTransactions.consumedAt })
      .from(partnerAuthTransactions)
      .where(eq(partnerAuthTransactions.id, fixture.authTransactionId!));
    const sessions = await db
      .select({
        authMethod: partnerSessions.authMethod,
        assuranceLevel: partnerSessions.assuranceLevel,
      })
      .from(partnerSessions)
      .where(eq(partnerSessions.partnerUserId, fixture.userId));

    expect(identity).toEqual({ active: true, identityStatus: "active" });
    expect(membership?.status).toBe("active");
    expect(handoff?.consumedAt).toEqual(now);
    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual(
      expect.arrayContaining([
        { authMethod: "password", assuranceLevel: "aal1" },
        { authMethod: "password", assuranceLevel: "aal1" },
      ]),
    );
  });
});
