import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerAuthChallenges,
  partnerAuthTransactions,
  partnerMfaEnrollmentChallenges,
  partnerMfaMethods,
  partnerMfaRecoveryCodes,
  partnerSessions,
  partnerUsers,
} from "@/db";
import {
  completePartnerActivationMfa,
  startPartnerActivationMfa,
} from "@/lib/partner-activation-mfa-auth";
import { partnerTotpCodeAt } from "@/lib/partner-mfa";
import { sha256Base64Url } from "@/lib/partner-portal-auth";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;
const NOW = new Date("2035-09-01T16:00:00.000Z");
const IP = "203.0.113.71";
const USER_AGENT = "Stonegate activation integration";

type Fixture = {
  accountId: string;
  userId: string;
  membershipId: string;
  sourceChallengeId: string;
  authTransactionId: string;
  transactionToken: string;
};

const fixtures: Fixture[] = [];

function request(ip = IP, userAgent = USER_AGENT): NextRequest {
  return new NextRequest(
    "https://api.stonegate.example/api/portal/v2/onboarding/activation/mfa/confirm",
    {
      method: "POST",
      headers: {
        origin: "https://stonegate.example",
        "x-forwarded-for": ip,
        "user-agent": userAgent,
      },
    },
  );
}

async function createFixture(input?: {
  createdAt?: Date;
  expiresAt?: Date;
  recovery?: boolean;
}): Promise<Fixture> {
  const db = getDb();
  const accountId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const sourceChallengeId = randomUUID();
  const authTransactionId = randomUUID();
  const transactionToken = randomBytes(32).toString("base64url");
  const createdAt = input?.createdAt ?? NOW;
  const expiresAt =
    input?.expiresAt ?? new Date(createdAt.getTime() + 10 * 60 * 1_000);
  const recovery = input?.recovery ?? false;
  const email = `activation-${userId}@example.test`;

  await db.transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: `Activation ${accountId}`,
      normalizedName: `activation ${accountId}`,
      status: "active_partner",
      portalAccessEnabled: true,
      createdAt,
      updatedAt: createdAt,
    });
    await tx.insert(partnerUsers).values({
      id: userId,
      orgContactId: null,
      email,
      normalizedEmail: email,
      name: "Activation Partner",
      active: recovery,
      identityStatus: recovery ? "active" : "pending_activation",
      emailVerifiedAt: createdAt,
      passwordHash: "test-password-hash-not-used-by-mfa-completion",
      passwordHashVersion: 2,
      passwordSetAt: createdAt,
      mfaRequired: true,
      securityVersion: 2,
      createdAt,
      updatedAt: createdAt,
    });
    await tx.insert(partnerAccountMemberships).values({
      id: membershipId,
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleKey: "administrator",
      status: recovery ? "active" : "invited",
      persona: "commercial_client",
      accessLevel: "account",
      isDefault: true,
      invitedAt: createdAt,
      acceptedAt: recovery ? createdAt : null,
      createdAt,
      updatedAt: createdAt,
    });
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
      securityVersionSnapshot: 1,
      requestedIp: IP,
      requestedUserAgent: USER_AGENT,
      expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1_000),
      consumedIp: IP,
      consumedUserAgent: USER_AGENT,
      consumedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });
    await tx.insert(partnerAuthTransactions).values({
      id: authTransactionId,
      partnerUserId: userId,
      partnerAccountId: accountId,
      partnerMembershipId: membershipId,
      tokenHash: sha256Base64Url(transactionToken),
      purpose: "activation_mfa_setup",
      sourceAuthChallengeId: sourceChallengeId,
      securityVersion: 2,
      rememberMe: false,
      requestedIp: IP,
      requestedUserAgent: USER_AGENT,
      attemptCount: 0,
      expiresAt,
      createdAt,
    });
  });
  const fixture = {
    accountId,
    userId,
    membershipId,
    sourceChallengeId,
    authTransactionId,
    transactionToken,
  };
  fixtures.push(fixture);
  return fixture;
}

describeWithDatabase("privileged activation PostgreSQL boundary", () => {
  const previousMfaKey = process.env["PARTNER_MFA_SECRET_KEY_BASE64"];

  beforeAll(() => {
    process.env["PARTNER_MFA_SECRET_KEY_BASE64"] = Buffer.alloc(
      32,
      17,
    ).toString("base64");
  });

  afterAll(async () => {
    const db = getDb();
    const userIds = fixtures.map((fixture) => fixture.userId);
    const accountIds = fixtures.map((fixture) => fixture.accountId);
    if (userIds.length > 0) {
      await db.delete(partnerUsers).where(inArray(partnerUsers.id, userIds));
    }
    if (accountIds.length > 0) {
      await db
        .delete(partnerAccounts)
        .where(inArray(partnerAccounts.id, accountIds));
    }
    if (previousMfaKey === undefined) {
      delete process.env["PARTNER_MFA_SECRET_KEY_BASE64"];
    } else {
      process.env["PARTNER_MFA_SECRET_KEY_BASE64"] = previousMfaKey;
    }
    await closeDbForTests();
  });

  it("keeps authority inactive until TOTP confirmation commits AAL2 atomically", async () => {
    const fixture = await createFixture();
    const started = await startPartnerActivationMfa({
      transactionToken: fixture.transactionToken,
      request: request(),
      correlationId: `activation-start-${randomUUID()}`,
      now: NOW,
    });
    expect(started.kind).toBe("enrollment");
    if (started.kind !== "enrollment") throw new Error("enrollment missing");

    const db = getDb();
    const [beforeUser] = await db
      .select({ active: partnerUsers.active })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, fixture.userId));
    const [beforeMembership] = await db
      .select({ status: partnerAccountMemberships.status })
      .from(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId));
    const sessionsBefore = await db
      .select({ id: partnerSessions.id })
      .from(partnerSessions)
      .where(eq(partnerSessions.partnerUserId, fixture.userId));
    expect(beforeUser?.active).toBe(false);
    expect(beforeMembership?.status).toBe("invited");
    expect(sessionsBefore).toHaveLength(0);

    const completed = await completePartnerActivationMfa({
      transactionToken: fixture.transactionToken,
      request: request(),
      correlationId: `activation-confirm-${randomUUID()}`,
      challengeId: started.challengeId,
      code: partnerTotpCodeAt(started.secret, NOW),
      now: NOW,
    });
    expect(completed.kind).toBe("success");
    if (completed.kind !== "success") throw new Error("activation failed");
    expect(completed.recoveryCodes.length).toBeGreaterThan(0);

    const [afterUser] = await db
      .select({
        active: partnerUsers.active,
        status: partnerUsers.identityStatus,
        mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
        securityVersion: partnerUsers.securityVersion,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, fixture.userId));
    const [afterMembership] = await db
      .select({
        status: partnerAccountMemberships.status,
        acceptedAt: partnerAccountMemberships.acceptedAt,
      })
      .from(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId));
    const [transaction] = await db
      .select({
        consumedAt: partnerAuthTransactions.consumedAt,
        completedSessionId: partnerAuthTransactions.completedSessionId,
      })
      .from(partnerAuthTransactions)
      .where(eq(partnerAuthTransactions.id, fixture.authTransactionId));
    const sessionsAfter = await db
      .select({
        id: partnerSessions.id,
        assuranceLevel: partnerSessions.assuranceLevel,
        securityVersion: partnerSessions.securityVersion,
      })
      .from(partnerSessions)
      .where(eq(partnerSessions.partnerUserId, fixture.userId));
    const methods = await db
      .select({ id: partnerMfaMethods.id })
      .from(partnerMfaMethods)
      .where(
        and(
          eq(partnerMfaMethods.partnerUserId, fixture.userId),
          eq(partnerMfaMethods.enabled, true),
        ),
      );
    const recovery = methods[0]
      ? await db
          .select({ id: partnerMfaRecoveryCodes.id })
          .from(partnerMfaRecoveryCodes)
          .where(eq(partnerMfaRecoveryCodes.methodId, methods[0].id))
      : [];
    expect(afterUser).toEqual(
      expect.objectContaining({
        active: true,
        status: "active",
        securityVersion: 3,
      }),
    );
    expect(afterUser?.mfaEnrolledAt).toEqual(NOW);
    expect(afterMembership?.status).toBe("active");
    expect(afterMembership?.acceptedAt).toEqual(NOW);
    expect(transaction?.consumedAt).toEqual(NOW);
    expect(transaction?.completedSessionId).toBe(sessionsAfter[0]?.id);
    expect(sessionsAfter).toEqual([
      expect.objectContaining({ assuranceLevel: "aal2", securityVersion: 3 }),
    ]);
    expect(methods).toHaveLength(1);
    expect(recovery.length).toBe(completed.recoveryCodes.length);

    const replay = await completePartnerActivationMfa({
      transactionToken: fixture.transactionToken,
      request: request(),
      correlationId: `activation-replay-${randomUUID()}`,
      challengeId: started.challengeId,
      code: partnerTotpCodeAt(started.secret, NOW),
      now: NOW,
    });
    expect(replay.kind).toBe("invalid_transaction");
    const sessionsAfterReplay = await db
      .select({ id: partnerSessions.id })
      .from(partnerSessions)
      .where(eq(partnerSessions.partnerUserId, fixture.userId));
    expect(sessionsAfterReplay).toHaveLength(1);
  });

  it("re-enrolls an active recovery membership without changing its account authority", async () => {
    const fixture = await createFixture({ recovery: true });
    const started = await startPartnerActivationMfa({
      transactionToken: fixture.transactionToken,
      request: request(),
      correlationId: `activation-recovery-start-${randomUUID()}`,
      now: NOW,
    });
    expect(started.kind).toBe("enrollment");
    if (started.kind !== "enrollment") throw new Error("enrollment missing");

    const completed = await completePartnerActivationMfa({
      transactionToken: fixture.transactionToken,
      request: request(),
      correlationId: `activation-recovery-confirm-${randomUUID()}`,
      challengeId: started.challengeId,
      code: partnerTotpCodeAt(started.secret, NOW),
      now: NOW,
    });
    expect(completed.kind).toBe("success");
    if (completed.kind !== "success") throw new Error("recovery failed");

    const db = getDb();
    const [user] = await db
      .select({
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
        securityVersion: partnerUsers.securityVersion,
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
    const sessions = await db
      .select({
        assuranceLevel: partnerSessions.assuranceLevel,
        securityVersion: partnerSessions.securityVersion,
      })
      .from(partnerSessions)
      .where(eq(partnerSessions.partnerUserId, fixture.userId));
    const enabledMethods = await db
      .select({ id: partnerMfaMethods.id })
      .from(partnerMfaMethods)
      .where(
        and(
          eq(partnerMfaMethods.partnerUserId, fixture.userId),
          eq(partnerMfaMethods.enabled, true),
        ),
      );

    expect(user).toEqual(
      expect.objectContaining({
        active: true,
        identityStatus: "active",
        mfaEnrolledAt: NOW,
        securityVersion: 3,
      }),
    );
    expect(membership).toEqual({ status: "active", acceptedAt: NOW });
    expect(sessions).toEqual([
      expect.objectContaining({ assuranceLevel: "aal2", securityVersion: 3 }),
    ]);
    expect(enabledMethods).toHaveLength(1);
  });

  it("consumes a request-binding mismatch without activating authority", async () => {
    const fixture = await createFixture();
    const result = await startPartnerActivationMfa({
      transactionToken: fixture.transactionToken,
      request: request("203.0.113.99"),
      correlationId: `activation-binding-${randomUUID()}`,
      now: NOW,
    });
    expect(result.kind).toBe("invalid_transaction");
    const db = getDb();
    const [transaction] = await db
      .select({ consumedAt: partnerAuthTransactions.consumedAt })
      .from(partnerAuthTransactions)
      .where(eq(partnerAuthTransactions.id, fixture.authTransactionId));
    const [user] = await db
      .select({ active: partnerUsers.active })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, fixture.userId));
    const [membership] = await db
      .select({ status: partnerAccountMemberships.status })
      .from(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId));
    expect(transaction?.consumedAt).toEqual(NOW);
    expect(user?.active).toBe(false);
    expect(membership?.status).toBe("invited");
  });

  it("exhausts bounded attempts without activating or issuing a session", async () => {
    const fixture = await createFixture();
    const started = await startPartnerActivationMfa({
      transactionToken: fixture.transactionToken,
      request: request(),
      correlationId: `activation-attempt-start-${randomUUID()}`,
      now: NOW,
    });
    if (started.kind !== "enrollment") throw new Error("enrollment missing");
    const validCode = partnerTotpCodeAt(started.secret, NOW);
    const invalidCode = validCode === "000000" ? "111111" : "000000";
    let attemptsRemaining = 8;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await completePartnerActivationMfa({
        transactionToken: fixture.transactionToken,
        request: request(),
        correlationId: `activation-attempt-${attempt}-${randomUUID()}`,
        challengeId: started.challengeId,
        code: invalidCode,
        now: NOW,
      });
      expect(result.kind).toBe("invalid_code");
      if (result.kind === "invalid_code") {
        attemptsRemaining = result.attemptsRemaining;
      }
    }
    expect(attemptsRemaining).toBe(0);
    const db = getDb();
    const [transaction] = await db
      .select({
        attemptCount: partnerAuthTransactions.attemptCount,
        consumedAt: partnerAuthTransactions.consumedAt,
      })
      .from(partnerAuthTransactions)
      .where(eq(partnerAuthTransactions.id, fixture.authTransactionId));
    const [enrollment] = await db
      .select({ consumedAt: partnerMfaEnrollmentChallenges.consumedAt })
      .from(partnerMfaEnrollmentChallenges)
      .where(
        eq(
          partnerMfaEnrollmentChallenges.authTransactionId,
          fixture.authTransactionId,
        ),
      );
    const sessions = await db
      .select({ id: partnerSessions.id })
      .from(partnerSessions)
      .where(eq(partnerSessions.partnerUserId, fixture.userId));
    expect(transaction?.attemptCount).toBe(8);
    expect(transaction?.consumedAt).toEqual(NOW);
    expect(enrollment?.consumedAt).toEqual(NOW);
    expect(sessions).toHaveLength(0);
  });
});
