import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerAuthChallenges,
  partnerAuthTransactions,
  partnerLoginTokens,
  partnerMfaEnrollmentChallenges,
  partnerMfaMethods,
  partnerMfaRecoveryCodes,
  partnerSessions,
  partnerUsers,
} from "@/db";
import { createPartnerActivationChallengeInTransaction } from "@/lib/partner-purpose-auth";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export const PARTNER_IDENTITY_SECURITY_MAX_MEMBERSHIPS = 250;

export type PartnerIdentitySecurityMembership = {
  id: string;
  partnerAccountId: string;
  accountName: string;
  accountStatus: string;
  portalAccessEnabled: boolean;
  roleKey: string;
  status: string;
  isDefault: boolean;
  version: string;
};

export type PartnerIdentitySecurityImpact = {
  identity: {
    id: string;
    name: string;
    email: string;
    normalizedEmail: string | null;
    active: boolean;
    status: string;
    passwordSet: boolean;
    mfaRequired: boolean;
    mfaEnrolledAt: string | null;
    securityVersion: number;
    version: string;
  };
  memberships: PartnerIdentitySecurityMembership[];
  membershipCount: number;
  membershipSnapshot: string;
  allMembershipsEnumerated: boolean;
  activeSessionCount: number;
  enabledMfaMethodCount: number;
  unusedRecoveryCodeCount: number;
  recoveryMembership: PartnerIdentitySecurityMembership | null;
  canDisable: boolean;
  canResetMfa: boolean;
  mfaRecoveryPending: boolean;
};

type IdentityRow = {
  id: string;
  name: string;
  email: string;
  normalizedEmail: string | null;
  active: boolean;
  identityStatus: string;
  passwordHash: string | null;
  mfaRequired: boolean;
  mfaEnrolledAt: Date | null;
  securityVersion: number;
  updatedAt: Date;
};

type MembershipRow = {
  id: string;
  partnerAccountId: string;
  accountName: string;
  accountStatus: string;
  portalAccessEnabled: boolean;
  roleKey: string;
  status: string;
  isDefault: boolean;
  updatedAt: Date;
};

function exactCount(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}

export function partnerIdentityMembershipSnapshot(
  partnerUserId: string,
  memberships: readonly PartnerIdentitySecurityMembership[],
): string {
  const canonical = [...memberships]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((membership) => ({
      id: membership.id,
      partnerAccountId: membership.partnerAccountId,
      roleKey: membership.roleKey,
      status: membership.status,
      isDefault: membership.isDefault,
      version: membership.version,
    }));
  return createHash("sha256")
    .update(JSON.stringify({ partnerUserId, memberships: canonical }), "utf8")
    .digest("hex");
}

function safeMembership(row: MembershipRow): PartnerIdentitySecurityMembership {
  return {
    id: row.id,
    partnerAccountId: row.partnerAccountId,
    accountName: row.accountName,
    accountStatus: row.accountStatus,
    portalAccessEnabled: row.portalAccessEnabled,
    roleKey: row.roleKey,
    status: row.status,
    isDefault: row.isDefault,
    version: row.updatedAt.toISOString(),
  };
}

async function loadImpactInTransaction(
  tx: TeamMutationTransaction,
  partnerUserId: string,
  options: { lock: boolean; now: Date },
): Promise<PartnerIdentitySecurityImpact | null> {
  const identityQuery = tx
    .select({
      id: partnerUsers.id,
      name: partnerUsers.name,
      email: partnerUsers.email,
      normalizedEmail: partnerUsers.normalizedEmail,
      active: partnerUsers.active,
      identityStatus: partnerUsers.identityStatus,
      passwordHash: partnerUsers.passwordHash,
      mfaRequired: partnerUsers.mfaRequired,
      mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
      securityVersion: partnerUsers.securityVersion,
      updatedAt: partnerUsers.updatedAt,
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.id, partnerUserId))
    .limit(1);
  const identityRows = options.lock
    ? await identityQuery.for("update")
    : await identityQuery;
  const identity = identityRows[0] as IdentityRow | undefined;
  if (!identity) return null;

  if (options.lock) {
    // This rare owner-only mutation must compare against every account
    // membership the operator reviewed. SHARE blocks concurrent membership
    // inserts/updates until the identity mutation and its audit receipt commit.
    await tx.execute(sql`LOCK TABLE partner_account_memberships IN SHARE MODE`);
  }

  const memberships = (await tx
    .select({
      id: partnerAccountMemberships.id,
      partnerAccountId: partnerAccountMemberships.partnerAccountId,
      accountName: partnerAccounts.name,
      accountStatus: partnerAccounts.status,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      roleKey: partnerAccountMemberships.roleKey,
      status: partnerAccountMemberships.status,
      isDefault: partnerAccountMemberships.isDefault,
      updatedAt: partnerAccountMemberships.updatedAt,
    })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
    )
    .where(eq(partnerAccountMemberships.partnerUserId, partnerUserId))
    .orderBy(
      desc(partnerAccountMemberships.isDefault),
      asc(partnerAccounts.name),
      asc(partnerAccountMemberships.id),
    )
    .limit(PARTNER_IDENTITY_SECURITY_MAX_MEMBERSHIPS + 1)) as MembershipRow[];

  const allMembershipsEnumerated =
    memberships.length <= PARTNER_IDENTITY_SECURITY_MAX_MEMBERSHIPS;
  const safeMemberships = memberships
    .slice(0, PARTNER_IDENTITY_SECURITY_MAX_MEMBERSHIPS)
    .map(safeMembership);
  const [sessionCountRow] = await tx
    .select({ count: sql<number>`count(*)::integer`.mapWith(Number) })
    .from(partnerSessions)
    .where(
      and(
        eq(partnerSessions.partnerUserId, partnerUserId),
        isNull(partnerSessions.revokedAt),
        gt(partnerSessions.expiresAt, options.now),
      ),
    );
  const [methodCountRow] = await tx
    .select({ count: sql<number>`count(*)::integer`.mapWith(Number) })
    .from(partnerMfaMethods)
    .where(
      and(
        eq(partnerMfaMethods.partnerUserId, partnerUserId),
        eq(partnerMfaMethods.enabled, true),
      ),
    );
  const [recoveryCodeCountRow] = await tx
    .select({ count: sql<number>`count(*)::integer`.mapWith(Number) })
    .from(partnerMfaRecoveryCodes)
    .innerJoin(
      partnerMfaMethods,
      eq(partnerMfaRecoveryCodes.methodId, partnerMfaMethods.id),
    )
    .where(
      and(
        eq(partnerMfaMethods.partnerUserId, partnerUserId),
        isNull(partnerMfaRecoveryCodes.usedAt),
      ),
    );
  const [pendingRecoveryRow] = await tx
    .select({ count: sql<number>`count(*)::integer`.mapWith(Number) })
    .from(partnerAuthChallenges)
    .innerJoin(
      partnerAccountMemberships,
      and(
        eq(
          partnerAuthChallenges.partnerMembershipId,
          partnerAccountMemberships.id,
        ),
        eq(
          partnerAuthChallenges.partnerAccountId,
          partnerAccountMemberships.partnerAccountId,
        ),
      ),
    )
    .where(
      and(
        eq(partnerAuthChallenges.partnerUserId, partnerUserId),
        eq(partnerAuthChallenges.purpose, "account_activation"),
        eq(partnerAuthChallenges.status, "pending"),
        eq(partnerAccountMemberships.status, "active"),
        eq(
          partnerAuthChallenges.securityVersionSnapshot,
          identity.securityVersion,
        ),
      ),
    );

  const recoveryMembership =
    safeMemberships.find(
      (membership) =>
        membership.status === "active" && membership.portalAccessEnabled,
    ) ?? null;
  const enabledMfaMethodCount = exactCount(methodCountRow?.count);
  const mfaRecoveryPending =
    identity.active &&
    identity.identityStatus === "active" &&
    identity.mfaRequired &&
    identity.mfaEnrolledAt === null &&
    enabledMfaMethodCount === 0 &&
    exactCount(pendingRecoveryRow?.count) > 0;
  const mfaWasConfigured =
    enabledMfaMethodCount > 0 ||
    identity.mfaEnrolledAt !== null ||
    identity.mfaRequired;

  return {
    identity: {
      id: identity.id,
      name: identity.name,
      email: identity.email,
      normalizedEmail: identity.normalizedEmail,
      active: identity.active,
      status: identity.identityStatus,
      passwordSet: Boolean(identity.passwordHash),
      mfaRequired: identity.mfaRequired,
      mfaEnrolledAt: identity.mfaEnrolledAt?.toISOString() ?? null,
      securityVersion: identity.securityVersion,
      version: identity.updatedAt.toISOString(),
    },
    memberships: safeMemberships,
    membershipCount: memberships.length,
    membershipSnapshot: partnerIdentityMembershipSnapshot(
      identity.id,
      safeMemberships,
    ),
    allMembershipsEnumerated,
    activeSessionCount: exactCount(sessionCountRow?.count),
    enabledMfaMethodCount,
    unusedRecoveryCodeCount: exactCount(recoveryCodeCountRow?.count),
    recoveryMembership,
    canDisable:
      allMembershipsEnumerated &&
      identity.identityStatus !== "disabled" &&
      identity.identityStatus !== "quarantined",
    canResetMfa:
      allMembershipsEnumerated &&
      identity.active &&
      identity.identityStatus === "active" &&
      Boolean(identity.passwordHash) &&
      Boolean(identity.normalizedEmail) &&
      Boolean(recoveryMembership) &&
      mfaWasConfigured,
    mfaRecoveryPending,
  };
}

export async function getPartnerIdentitySecurityImpact(
  partnerUserId: string,
  now = new Date(),
): Promise<PartnerIdentitySecurityImpact | null> {
  return getDb().transaction((tx) =>
    loadImpactInTransaction(tx, partnerUserId, { lock: false, now }),
  );
}

async function lockPartnerIdentitySecurityImpact(
  tx: TeamMutationTransaction,
  partnerUserId: string,
  now: Date,
): Promise<PartnerIdentitySecurityImpact> {
  const impact = await loadImpactInTransaction(tx, partnerUserId, {
    lock: true,
    now,
  });
  if (!impact) {
    throw new TeamMutationFailure(
      "invalid",
      "The partner identity was not found.",
      { status: 404 },
    );
  }
  return impact;
}

function assertReviewedImpact(
  impact: PartnerIdentitySecurityImpact,
  input: { expectedVersion: string; membershipSnapshot: string },
): void {
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    impact.identity.version,
  );
  if (!impact.allMembershipsEnumerated) {
    throw new TeamMutationFailure(
      "conflict",
      "This identity has too many memberships to enumerate safely in one confirmation. Escalate for an offline owner review.",
    );
  }
  if (impact.membershipSnapshot !== input.membershipSnapshot) {
    throw new TeamMutationFailure(
      "conflict",
      "The person’s account memberships changed after review. Refresh and review every affected company again.",
      {
        status: 412,
        fieldErrors: {
          membershipSnapshot: "Review the current account membership list.",
        },
      },
    );
  }
}

async function invalidatePartnerCredentials(
  tx: TeamMutationTransaction,
  partnerUserId: string,
  now: Date,
): Promise<{
  sessionsRevoked: number;
  loginTokensRevoked: number;
  authTransactionsRevoked: number;
  authChallengesRevoked: number;
  enrollmentChallengesDeleted: number;
}> {
  const sessions = await tx
    .update(partnerSessions)
    .set({ revokedAt: now, lastSeenAt: now })
    .where(
      and(
        eq(partnerSessions.partnerUserId, partnerUserId),
        isNull(partnerSessions.revokedAt),
      ),
    )
    .returning({ id: partnerSessions.id });
  const loginTokens = await tx
    .update(partnerLoginTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(partnerLoginTokens.partnerUserId, partnerUserId),
        isNull(partnerLoginTokens.usedAt),
      ),
    )
    .returning({ id: partnerLoginTokens.id });
  const authTransactions = await tx
    .update(partnerAuthTransactions)
    .set({ consumedAt: now })
    .where(
      and(
        eq(partnerAuthTransactions.partnerUserId, partnerUserId),
        isNull(partnerAuthTransactions.consumedAt),
      ),
    )
    .returning({ id: partnerAuthTransactions.id });
  const authChallenges = await tx
    .update(partnerAuthChallenges)
    .set({
      status: "revoked",
      tokenHash: null,
      revokedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAuthChallenges.partnerUserId, partnerUserId),
        eq(partnerAuthChallenges.status, "pending"),
      ),
    )
    .returning({ id: partnerAuthChallenges.id });
  const enrollmentChallenges = await tx
    .delete(partnerMfaEnrollmentChallenges)
    .where(eq(partnerMfaEnrollmentChallenges.partnerUserId, partnerUserId))
    .returning({ id: partnerMfaEnrollmentChallenges.id });
  return {
    sessionsRevoked: sessions.length,
    loginTokensRevoked: loginTokens.length,
    authTransactionsRevoked: authTransactions.length,
    authChallengesRevoked: authChallenges.length,
    enrollmentChallengesDeleted: enrollmentChallenges.length,
  };
}

export type PartnerIdentityDisableResult = {
  partnerUserId: string;
  status: "disabled";
  active: false;
  version: string;
  securityVersion: number;
  membershipCount: number;
  membershipSnapshot: string;
  membershipsChanged: false;
  recordsPreserved: true;
  sessionsRevoked: number;
  loginTokensRevoked: number;
  authTransactionsRevoked: number;
  authChallengesRevoked: number;
  enrollmentChallengesDeleted: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export async function disablePartnerIdentityAsTeamOwner(
  tx: TeamMutationTransaction,
  input: {
    partnerUserId: string;
    expectedVersion: string;
    membershipSnapshot: string;
    confirmation: string;
    now?: Date;
  },
): Promise<PartnerIdentityDisableResult> {
  const now = input.now ?? new Date();
  const impact = await lockPartnerIdentitySecurityImpact(
    tx,
    input.partnerUserId,
    now,
  );
  assertReviewedImpact(impact, input);
  const expectedConfirmation = `DISABLE ${impact.identity.email}`.normalize(
    "NFKC",
  );
  if (input.confirmation !== expectedConfirmation) {
    throw new TeamMutationFailure(
      "invalid",
      "Type the exact identity disable confirmation shown in the workspace.",
      {
        fieldErrors: {
          confirmation: `Enter ${expectedConfirmation} exactly.`,
        },
      },
    );
  }
  if (!impact.canDisable) {
    throw new TeamMutationFailure(
      "conflict",
      impact.identity.status === "quarantined"
        ? "A quarantined identity cannot be reclassified through global disable. Resolve its tenant binding separately."
        : "This partner identity is already disabled.",
    );
  }

  const nextSecurityVersion = impact.identity.securityVersion + 1;
  const [updated] = await tx
    .update(partnerUsers)
    .set({
      active: false,
      identityStatus: "disabled",
      securityVersion: nextSecurityVersion,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerUsers.id, input.partnerUserId),
        eq(partnerUsers.updatedAt, new Date(impact.identity.version)),
        eq(partnerUsers.securityVersion, impact.identity.securityVersion),
      ),
    )
    .returning({ updatedAt: partnerUsers.updatedAt });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The identity changed during disable. Refresh and review every affected company again.",
      { status: 412, retryable: true },
    );
  }
  const invalidated = await invalidatePartnerCredentials(
    tx,
    input.partnerUserId,
    now,
  );
  const version = updated.updatedAt.toISOString();
  return {
    partnerUserId: input.partnerUserId,
    status: "disabled",
    active: false,
    version,
    securityVersion: nextSecurityVersion,
    membershipCount: impact.membershipCount,
    membershipSnapshot: impact.membershipSnapshot,
    membershipsChanged: false,
    recordsPreserved: true,
    ...invalidated,
    before: {
      active: impact.identity.active,
      status: impact.identity.status,
      securityVersion: impact.identity.securityVersion,
      membershipCount: impact.membershipCount,
      membershipSnapshot: impact.membershipSnapshot,
    },
    after: {
      active: false,
      status: "disabled",
      securityVersion: nextSecurityVersion,
      membershipCount: impact.membershipCount,
      membershipSnapshot: impact.membershipSnapshot,
      membershipsChanged: false,
      recordsPreserved: true,
      version,
    },
  };
}

export type PartnerMfaResetResult = {
  partnerUserId: string;
  status: "re_enrollment_required";
  version: string;
  securityVersion: number;
  membershipCount: number;
  membershipSnapshot: string;
  membershipsChanged: false;
  recordsPreserved: true;
  sessionsRevoked: number;
  loginTokensRevoked: number;
  authTransactionsRevoked: number;
  authChallengesRevoked: number;
  enrollmentChallengesDeleted: number;
  mfaMethodsRevoked: number;
  recoveryCodesRevoked: number;
  recoveryAccountId: string;
  recoveryMembershipId: string;
  recoveryChallengeId: string;
  recoveryChallengeExpiresAt: string;
  recoveryDelivery: "queued";
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export async function resetPartnerMfaAsTeamOwner(
  tx: TeamMutationTransaction,
  input: {
    partnerUserId: string;
    expectedVersion: string;
    membershipSnapshot: string;
    confirmation: string;
    correlationId: string;
    now?: Date;
  },
): Promise<PartnerMfaResetResult> {
  const now = input.now ?? new Date();
  const impact = await lockPartnerIdentitySecurityImpact(
    tx,
    input.partnerUserId,
    now,
  );
  assertReviewedImpact(impact, input);
  const expectedConfirmation = `RESET ${impact.identity.email} MFA`.normalize(
    "NFKC",
  );
  if (input.confirmation !== expectedConfirmation) {
    throw new TeamMutationFailure(
      "invalid",
      "Type the exact MFA reset confirmation shown in the workspace.",
      {
        fieldErrors: {
          confirmation: `Enter ${expectedConfirmation} exactly.`,
        },
      },
    );
  }
  if (!impact.canResetMfa || !impact.recoveryMembership) {
    throw new TeamMutationFailure(
      "conflict",
      "MFA cannot be reset safely for this identity. It must be active, have a password, and have at least one active portal-enabled company membership for purpose-bound re-enrollment.",
    );
  }
  if (!impact.identity.normalizedEmail) {
    throw new TeamMutationFailure(
      "conflict",
      "MFA recovery requires a canonical verified email address.",
    );
  }
  const [recoveryAccount] = await tx
    .select({
      id: partnerAccounts.id,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, impact.recoveryMembership.partnerAccountId))
    .for("update")
    .limit(1);
  if (!recoveryAccount?.portalAccessEnabled) {
    throw new TeamMutationFailure(
      "conflict",
      "The recovery company is no longer portal-enabled. Refresh and choose a safe active membership before resetting MFA.",
      { status: 412 },
    );
  }

  const methodRows = await tx
    .select({ id: partnerMfaMethods.id })
    .from(partnerMfaMethods)
    .where(eq(partnerMfaMethods.partnerUserId, input.partnerUserId))
    .for("update");
  const methodIds = methodRows.map((method) => method.id);
  let recoveryCodesRevoked = 0;
  if (methodIds.length > 0) {
    const recoveryCodes = await tx
      .update(partnerMfaRecoveryCodes)
      .set({ usedAt: now })
      .where(
        and(
          inArray(partnerMfaRecoveryCodes.methodId, methodIds),
          isNull(partnerMfaRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: partnerMfaRecoveryCodes.id });
    recoveryCodesRevoked = recoveryCodes.length;
    await tx
      .update(partnerMfaMethods)
      .set({
        enabled: false,
        disabledAt: now,
        credentialIdHash: null,
        credentialReference: null,
        totpSecretCiphertext: null,
        totpSecretKeyVersion: null,
        lastTotpCounter: null,
        updatedAt: now,
      })
      .where(inArray(partnerMfaMethods.id, methodIds));
  }

  const invalidated = await invalidatePartnerCredentials(
    tx,
    input.partnerUserId,
    now,
  );
  const nextSecurityVersion = impact.identity.securityVersion + 1;
  const [updated] = await tx
    .update(partnerUsers)
    .set({
      mfaRequired: true,
      mfaEnrolledAt: null,
      securityVersion: nextSecurityVersion,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerUsers.id, input.partnerUserId),
        eq(partnerUsers.active, true),
        eq(partnerUsers.identityStatus, "active"),
        eq(partnerUsers.updatedAt, new Date(impact.identity.version)),
        eq(partnerUsers.securityVersion, impact.identity.securityVersion),
      ),
    )
    .returning({ updatedAt: partnerUsers.updatedAt });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The identity changed during MFA reset. Refresh and review it again.",
      { status: 412, retryable: true },
    );
  }

  const recoveryChallenge = await createPartnerActivationChallengeInTransaction(
    tx,
    {
      partnerUserId: input.partnerUserId,
      partnerAccountId: impact.recoveryMembership.partnerAccountId,
      partnerMembershipId: impact.recoveryMembership.id,
      applicationId: null,
      normalizedEmail: impact.identity.normalizedEmail,
      securityVersion: nextSecurityVersion,
      correlationId: input.correlationId,
      now,
    },
  );
  const version = updated.updatedAt.toISOString();
  return {
    partnerUserId: input.partnerUserId,
    status: "re_enrollment_required",
    version,
    securityVersion: nextSecurityVersion,
    membershipCount: impact.membershipCount,
    membershipSnapshot: impact.membershipSnapshot,
    membershipsChanged: false,
    recordsPreserved: true,
    ...invalidated,
    mfaMethodsRevoked: methodIds.length,
    recoveryCodesRevoked,
    recoveryAccountId: impact.recoveryMembership.partnerAccountId,
    recoveryMembershipId: impact.recoveryMembership.id,
    recoveryChallengeId: recoveryChallenge.challengeId,
    recoveryChallengeExpiresAt: recoveryChallenge.expiresAt.toISOString(),
    recoveryDelivery: "queued",
    before: {
      mfaRequired: impact.identity.mfaRequired,
      mfaEnrolledAt: impact.identity.mfaEnrolledAt,
      securityVersion: impact.identity.securityVersion,
      enabledMfaMethodCount: impact.enabledMfaMethodCount,
      unusedRecoveryCodeCount: impact.unusedRecoveryCodeCount,
      membershipCount: impact.membershipCount,
      membershipSnapshot: impact.membershipSnapshot,
    },
    after: {
      mfaRequired: true,
      mfaEnrolledAt: null,
      securityVersion: nextSecurityVersion,
      enabledMfaMethodCount: 0,
      unusedRecoveryCodeCount: 0,
      membershipCount: impact.membershipCount,
      membershipSnapshot: impact.membershipSnapshot,
      membershipsChanged: false,
      recordsPreserved: true,
      reEnrollmentRequired: true,
      recoveryDelivery: "queued",
      version,
    },
  };
}
