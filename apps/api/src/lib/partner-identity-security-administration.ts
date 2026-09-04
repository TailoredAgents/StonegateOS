import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerAuthChallenges,
  partnerLoginTokens,
  partnerSessions,
  partnerUsers,
} from "@/db";
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
    securityVersion: number;
    version: string;
  };
  memberships: PartnerIdentitySecurityMembership[];
  membershipCount: number;
  membershipSnapshot: string;
  allMembershipsEnumerated: boolean;
  activeSessionCount: number;
  canDisable: boolean;
};

type IdentityRow = {
  id: string;
  name: string;
  email: string;
  normalizedEmail: string | null;
  active: boolean;
  identityStatus: string;
  passwordHash: string | null;
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
  return {
    identity: {
      id: identity.id,
      name: identity.name,
      email: identity.email,
      normalizedEmail: identity.normalizedEmail,
      active: identity.active,
      status: identity.identityStatus,
      passwordSet: Boolean(identity.passwordHash),
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
    canDisable:
      allMembershipsEnumerated &&
      identity.identityStatus !== "disabled" &&
      identity.identityStatus !== "quarantined",
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
  authChallengesRevoked: number;
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
  return {
    sessionsRevoked: sessions.length,
    loginTokensRevoked: loginTokens.length,
    authChallengesRevoked: authChallenges.length,
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
  authChallengesRevoked: number;
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
