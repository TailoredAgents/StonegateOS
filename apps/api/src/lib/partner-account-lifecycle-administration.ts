import { and, eq, isNull, sql } from "drizzle-orm";
import {
  partnerAccountInvitations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerAuthChallenges,
  partnerAuthTransactions,
  partnerMembershipCostCenterScopes,
  partnerMembershipLocationScopes,
  partnerRoleTemplates,
  partnerSessions,
  partnerUsers,
} from "@/db";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export type PartnerAccountLifecycleAction = "suspend" | "reactivate" | "close";

type AccountRow = typeof partnerAccounts.$inferSelect;

function accountLifecycleSnapshot(row: AccountRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    portalAccessEnabled: row.portalAccessEnabled,
    portalLifecycleStatus: row.portalLifecycleStatus,
    portalLifecycleRevision: row.portalLifecycleRevision,
    portalLifecycleChangedAt:
      row.portalLifecycleChangedAt?.toISOString() ?? null,
    portalLifecycleChangedByTeamMemberId:
      row.portalLifecycleChangedByTeamMemberId,
    portalLifecycleReason: row.portalLifecycleReason,
    mergedIntoPartnerAccountId: row.mergedIntoPartnerAccountId,
  };
}

function assertLifecycleTransition(
  status: AccountRow["portalLifecycleStatus"],
  action: PartnerAccountLifecycleAction,
): void {
  const valid =
    (action === "suspend" && status === "active") ||
    (action === "reactivate" && status === "suspended") ||
    (action === "close" && (status === "active" || status === "suspended"));
  if (valid) return;
  throw new TeamMutationFailure(
    "conflict",
    status === "merged"
      ? "A merged account cannot be changed through lifecycle controls."
      : `This account cannot transition from ${status} with ${action}.`,
  );
}

export async function mutatePartnerAccountLifecycleAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    action: PartnerAccountLifecycleAction;
    expectedVersion: string;
    reason: string;
    changedByTeamMemberId: string;
    now?: Date;
  },
): Promise<{
  account: AccountRow;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  sessionsRevoked: number;
  authTransactionsRevoked: number;
  authChallengesRevoked: number;
  invitationsRevoked: number;
}> {
  const reason = input.reason.normalize("NFKC").trim();
  if (reason.length < 20 || reason.length > 1_000) {
    throw new TeamMutationFailure(
      "invalid",
      "Explain the account lifecycle decision in 20 to 1,000 characters.",
      { fieldErrors: { reason: "A durable lifecycle reason is required." } },
    );
  }
  const [current] = await tx
    .select()
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, input.partnerAccountId))
    .for("update")
    .limit(1);
  if (!current) {
    throw new TeamMutationFailure(
      "invalid",
      "The partner account was not found.",
      {
        status: 404,
      },
    );
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    current.portalLifecycleRevision,
  );
  assertLifecycleTransition(current.portalLifecycleStatus, input.action);

  const now = input.now ?? new Date();
  const isReactivation = input.action === "reactivate";
  const previousEligible =
    current.portalLifecycleStatus === "active"
      ? current.portalAccessEnabled
      : (current.portalLifecyclePriorAccessEnabled ?? false);
  const nextStatus = isReactivation
    ? "active"
    : input.action === "close"
      ? "closed"
      : "suspended";
  const [updated] = await tx
    .update(partnerAccounts)
    .set({
      portalLifecycleStatus: nextStatus,
      portalAccessEnabled: isReactivation ? previousEligible : false,
      portalLifecyclePriorAccessEnabled: isReactivation
        ? null
        : previousEligible,
      portalLifecycleRevision: sql`${partnerAccounts.portalLifecycleRevision} + 1`,
      portalLifecycleChangedAt: now,
      portalLifecycleChangedByTeamMemberId: input.changedByTeamMemberId,
      portalLifecycleReason: reason,
      mergedIntoPartnerAccountId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccounts.id, input.partnerAccountId),
        eq(
          partnerAccounts.portalLifecycleRevision,
          current.portalLifecycleRevision,
        ),
      ),
    )
    .returning();
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The account lifecycle changed while it was being saved. Refresh and try again.",
      { retryable: true },
    );
  }

  let sessionsRevoked = 0;
  let authTransactionsRevoked = 0;
  let authChallengesRevoked = 0;
  let invitationsRevoked = 0;
  if (!isReactivation) {
    const revokedSessions = await tx
      .update(partnerSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(partnerSessions.activePartnerAccountId, input.partnerAccountId),
          isNull(partnerSessions.revokedAt),
        ),
      )
      .returning({ id: partnerSessions.id });
    sessionsRevoked = revokedSessions.length;

    const consumedTransactions = await tx
      .update(partnerAuthTransactions)
      .set({ consumedAt: now })
      .where(
        and(
          eq(partnerAuthTransactions.partnerAccountId, input.partnerAccountId),
          isNull(partnerAuthTransactions.consumedAt),
        ),
      )
      .returning({ id: partnerAuthTransactions.id });
    authTransactionsRevoked = consumedTransactions.length;

    const revokedChallenges = await tx
      .update(partnerAuthChallenges)
      .set({
        status: "revoked",
        tokenHash: null,
        revokedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerAuthChallenges.partnerAccountId, input.partnerAccountId),
          eq(partnerAuthChallenges.status, "pending"),
        ),
      )
      .returning({ id: partnerAuthChallenges.id });
    authChallengesRevoked = revokedChallenges.length;

    if (input.action === "close") {
      const revokedInvitations = await tx
        .update(partnerAccountInvitations)
        .set({
          status: "revoked",
          tokenHash: null,
          revokedAt: now,
          updatedAt: now,
          version: sql`${partnerAccountInvitations.version} + 1`,
        })
        .where(
          and(
            eq(
              partnerAccountInvitations.partnerAccountId,
              input.partnerAccountId,
            ),
            eq(partnerAccountInvitations.status, "pending"),
          ),
        )
        .returning({ id: partnerAccountInvitations.id });
      invitationsRevoked = revokedInvitations.length;
    }
  }

  return {
    account: updated,
    before: accountLifecycleSnapshot(current),
    after: accountLifecycleSnapshot(updated),
    sessionsRevoked,
    authTransactionsRevoked,
    authChallengesRevoked,
    invitationsRevoked,
  };
}

export async function recoverPartnerAdministratorAsTeamOwner(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    membershipId: string;
    expectedVersion: string;
    changedByTeamMemberId: string;
    now?: Date;
  },
): Promise<{
  partnerAccountId: string;
  membershipId: string;
  partnerUserId: string;
  roleKey: "administrator";
  accessLevel: "account";
  sessionsRevoked: number;
  securityVersion: number;
  previousVersion: string;
  version: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}> {
  const now = input.now ?? new Date();
  const [account] = await tx
    .select({
      id: partnerAccounts.id,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      portalLifecycleStatus: partnerAccounts.portalLifecycleStatus,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, input.partnerAccountId))
    .for("update")
    .limit(1);
  if (!account) {
    throw new TeamMutationFailure(
      "invalid",
      "The partner account was not found.",
      {
        status: 404,
      },
    );
  }
  if (
    account.portalLifecycleStatus !== "active" ||
    !account.portalAccessEnabled
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Restore the partner account before recovering its Administrator.",
    );
  }

  const [target] = await tx
    .select({
      membershipId: partnerAccountMemberships.id,
      partnerUserId: partnerAccountMemberships.partnerUserId,
      roleKey: partnerAccountMemberships.roleKey,
      status: partnerAccountMemberships.status,
      accessLevel: partnerAccountMemberships.accessLevel,
      migrationReviewStatus: partnerAccountMemberships.migrationReviewStatus,
      updatedAt: partnerAccountMemberships.updatedAt,
      identityStatus: partnerUsers.identityStatus,
      active: partnerUsers.active,
      passwordHash: partnerUsers.passwordHash,
      mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
      securityVersion: partnerUsers.securityVersion,
    })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerUsers,
      eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
    )
    .where(
      and(
        eq(partnerAccountMemberships.id, input.membershipId),
        eq(partnerAccountMemberships.partnerAccountId, input.partnerAccountId),
      ),
    )
    .for("update")
    .limit(1);
  if (!target) {
    throw new TeamMutationFailure(
      "invalid",
      "The recovery membership was not found in that account.",
      { status: 404 },
    );
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    target.updatedAt,
  );
  if (
    target.status !== "active" ||
    target.identityStatus !== "active" ||
    !target.active ||
    !target.passwordHash ||
    !target.mfaEnrolledAt ||
    target.migrationReviewStatus === "pending" ||
    target.migrationReviewStatus === "quarantined"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Administrator recovery requires an active, reviewed membership with a password and enrolled MFA.",
      {
        fieldErrors: {
          membershipId:
            "Finish activation, migration review, and MFA recovery first.",
        },
      },
    );
  }

  const [existingAdministrator] = await tx
    .select({ id: partnerAccountMemberships.id })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerUsers,
      eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
    )
    .where(
      and(
        eq(partnerAccountMemberships.partnerAccountId, input.partnerAccountId),
        eq(partnerAccountMemberships.roleKey, "administrator"),
        eq(partnerAccountMemberships.status, "active"),
        eq(partnerUsers.identityStatus, "active"),
        eq(partnerUsers.active, true),
      ),
    )
    .for("update")
    .limit(1);
  if (existingAdministrator) {
    throw new TeamMutationFailure(
      "conflict",
      "An active Administrator still exists. Recover that identity or use the normal role workflow.",
    );
  }

  const [administratorRole] = await tx
    .select({ id: partnerRoleTemplates.id })
    .from(partnerRoleTemplates)
    .where(
      and(
        eq(partnerRoleTemplates.key, "administrator"),
        eq(partnerRoleTemplates.isSystem, true),
        eq(partnerRoleTemplates.active, true),
        isNull(partnerRoleTemplates.partnerAccountId),
      ),
    )
    .limit(1);
  if (!administratorRole) {
    throw new TeamMutationFailure(
      "conflict",
      "The canonical Administrator role is unavailable. Restore role configuration before recovery.",
    );
  }

  const previousVersion = target.updatedAt.toISOString();
  const [updatedMembership] = await tx
    .update(partnerAccountMemberships)
    .set({
      roleTemplateId: administratorRole.id,
      roleKey: "administrator",
      capabilityGrants: [],
      capabilityDenies: [],
      accessLevel: "account",
      accessScope: {},
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccountMemberships.id, target.membershipId),
        eq(partnerAccountMemberships.partnerAccountId, input.partnerAccountId),
      ),
    )
    .returning({
      id: partnerAccountMemberships.id,
      updatedAt: partnerAccountMemberships.updatedAt,
    });
  if (!updatedMembership) {
    throw new TeamMutationFailure(
      "conflict",
      "The recovery membership changed while it was being saved. Refresh and review it again.",
      { retryable: true },
    );
  }
  await tx
    .delete(partnerMembershipLocationScopes)
    .where(
      and(
        eq(
          partnerMembershipLocationScopes.partnerAccountId,
          input.partnerAccountId,
        ),
        eq(partnerMembershipLocationScopes.membershipId, target.membershipId),
      ),
    );
  await tx
    .delete(partnerMembershipCostCenterScopes)
    .where(
      and(
        eq(
          partnerMembershipCostCenterScopes.partnerAccountId,
          input.partnerAccountId,
        ),
        eq(partnerMembershipCostCenterScopes.membershipId, target.membershipId),
      ),
    );

  const [updatedUser] = await tx
    .update(partnerUsers)
    .set({
      mfaRequired: true,
      securityVersion: sql`${partnerUsers.securityVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerUsers.id, target.partnerUserId),
        eq(partnerUsers.securityVersion, target.securityVersion),
      ),
    )
    .returning({ securityVersion: partnerUsers.securityVersion });
  if (!updatedUser) {
    throw new TeamMutationFailure(
      "conflict",
      "The recovery identity security state changed. Refresh and review it again.",
      { retryable: true },
    );
  }
  const revokedSessions = await tx
    .update(partnerSessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(partnerSessions.partnerUserId, target.partnerUserId),
        isNull(partnerSessions.revokedAt),
      ),
    )
    .returning({ id: partnerSessions.id });

  const version = updatedMembership.updatedAt.toISOString();
  return {
    partnerAccountId: input.partnerAccountId,
    membershipId: target.membershipId,
    partnerUserId: target.partnerUserId,
    roleKey: "administrator",
    accessLevel: "account",
    sessionsRevoked: revokedSessions.length,
    securityVersion: updatedUser.securityVersion,
    previousVersion,
    version,
    before: {
      roleKey: target.roleKey,
      accessLevel: target.accessLevel,
      securityVersion: target.securityVersion,
      version: previousVersion,
    },
    after: {
      roleKey: "administrator",
      accessLevel: "account",
      securityVersion: updatedUser.securityVersion,
      version,
    },
  };
}
