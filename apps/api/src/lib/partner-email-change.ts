import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerAuthChallenges,
  partnerAuthTransactions,
  partnerLoginTokens,
  partnerSessions,
  partnerUsers,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { isRecentPartnerPasswordAuthentication } from "@/lib/partner-password-management";
import { verifyPartnerPassword } from "@/lib/partner-password-crypto";
import {
  getClientIp,
  getUserAgent,
  normalizeEmail,
} from "@/lib/partner-portal-auth";
import { createPartnerPurposeChallengeInTransaction } from "@/lib/partner-purpose-auth";

const RECENT_EMAIL_CHANGE_ASSURANCE_MS = 15 * 60 * 1_000;

type PartnerEmailChangeActor = {
  partnerUserId: string;
  email: string;
  roleKey: string;
  accountId: string;
  membershipId: string;
  sessionId: string;
  mfaRequired: boolean;
  correlationId: string;
};

export type RequestPartnerEmailChangeResult =
  | { kind: "accepted"; expiresAt: Date | null }
  | {
      kind:
        | "same_email"
        | "current_password_required"
        | "invalid_current_password"
        | "recent_authentication_required"
        | "recent_mfa_required"
        | "session_unavailable"
        | "user_unavailable";
    };

export type ConfirmPartnerEmailChangeResult =
  | {
      kind: "success";
      changedAt: Date;
      sessionsRevoked: number;
    }
  | { kind: "invalid" | "expired" | "reconciliation_required" };

function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function emailFingerprint(value: string): string {
  return createHash("sha256")
    .update("partner-email-change\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;
  return candidate.cause !== error && isUniqueViolation(candidate.cause);
}

export function isRecentPartnerEmailChangeAuthentication(input: {
  mfaRequired: boolean;
  authMethod: string;
  assuranceLevel: string;
  sessionCreatedAt: Date;
  mfaVerifiedAt: Date | null;
  now: Date;
}): boolean {
  if (input.mfaRequired) {
    return Boolean(
      input.assuranceLevel === "aal2" &&
        input.mfaVerifiedAt &&
        input.now.getTime() - input.mfaVerifiedAt.getTime() <=
          RECENT_EMAIL_CHANGE_ASSURANCE_MS,
    );
  }
  return isRecentPartnerPasswordAuthentication(input);
}

function requestAudit(
  actor: PartnerEmailChangeActor,
  input: {
    outcome: "attempted" | "denied";
    targetEmail: string;
    reason?: string;
    challengeId?: string | null;
    meta?: Record<string, unknown>;
  },
) {
  const id = randomUUID();
  return {
    id,
    actorType: "human" as const,
    actorId: actor.partnerUserId,
    actorLabel: actor.email,
    actorRole: actor.roleKey,
    sessionId: actor.sessionId,
    authMethod: "partner_session",
    correlationId: actor.correlationId,
    requiredPermissions: ["portal.session.read"],
    outcome: input.outcome,
    surface: "/partners/settings",
    action: "partner.auth.email_change.requested",
    entityType: "partner_auth_challenge",
    entityId: input.challengeId ?? null,
    meta: sanitizeAuditMetadata({
      eventId: id,
      partnerAccountId: actor.accountId,
      partnerMembershipId: actor.membershipId,
      targetEmailHash: emailFingerprint(input.targetEmail),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.meta ?? {}),
    }),
  };
}

export async function requestPartnerEmailChange(input: {
  actor: PartnerEmailChangeActor;
  newEmail: string;
  currentPassword?: string;
  request: NextRequest;
  now?: Date;
}): Promise<RequestPartnerEmailChangeResult> {
  const now = input.now ?? new Date();
  const targetEmail = normalizeEmail(input.newEmail);
  if (!targetEmail || targetEmail.length > 254) {
    throw new TypeError("partner_email_change_target_invalid");
  }
  const db = getDb();
  const [previewUser] = await db
    .select({
      id: partnerUsers.id,
      active: partnerUsers.active,
      identityStatus: partnerUsers.identityStatus,
      normalizedEmail: partnerUsers.normalizedEmail,
      passwordHash: partnerUsers.passwordHash,
      securityVersion: partnerUsers.securityVersion,
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.id, input.actor.partnerUserId))
    .limit(1);
  if (
    !previewUser?.active ||
    previewUser.identityStatus !== "active" ||
    !previewUser.normalizedEmail
  ) {
    return { kind: "user_unavailable" };
  }
  const currentPasswordVerification =
    previewUser.passwordHash && input.currentPassword
      ? await verifyPartnerPassword(
          input.currentPassword,
          previewUser.passwordHash,
        )
      : null;

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({
        id: partnerUsers.id,
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        normalizedEmail: partnerUsers.normalizedEmail,
        passwordHash: partnerUsers.passwordHash,
        securityVersion: partnerUsers.securityVersion,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, input.actor.partnerUserId))
      .for("update")
      .limit(1);
    if (
      !user?.active ||
      user.identityStatus !== "active" ||
      !user.normalizedEmail ||
      user.passwordHash !== previewUser.passwordHash ||
      user.securityVersion !== previewUser.securityVersion
    ) {
      return { kind: "user_unavailable" } as const;
    }

    const [session] = await tx
      .select({
        id: partnerSessions.id,
        authMethod: partnerSessions.authMethod,
        assuranceLevel: partnerSessions.assuranceLevel,
        mfaVerifiedAt: partnerSessions.mfaVerifiedAt,
        createdAt: partnerSessions.createdAt,
      })
      .from(partnerSessions)
      .where(
        and(
          eq(partnerSessions.id, input.actor.sessionId),
          eq(partnerSessions.partnerUserId, user.id),
          eq(partnerSessions.activePartnerAccountId, input.actor.accountId),
          eq(partnerSessions.activeMembershipId, input.actor.membershipId),
          eq(partnerSessions.securityVersion, user.securityVersion),
          isNull(partnerSessions.revokedAt),
          gt(partnerSessions.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!session?.id) return { kind: "session_unavailable" } as const;

    const [access] = await tx
      .select({ membershipId: partnerAccountMemberships.id })
      .from(partnerAccountMemberships)
      .innerJoin(
        partnerAccounts,
        eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
      )
      .where(
        and(
          eq(partnerAccountMemberships.id, input.actor.membershipId),
          eq(partnerAccountMemberships.partnerAccountId, input.actor.accountId),
          eq(partnerAccountMemberships.partnerUserId, user.id),
          eq(partnerAccountMemberships.status, "active"),
          eq(partnerAccounts.portalAccessEnabled, true),
        ),
      )
      .limit(1);
    if (!access?.membershipId) return { kind: "user_unavailable" } as const;

    if (targetEmail === user.normalizedEmail) {
      return { kind: "same_email" } as const;
    }
    const recentlyAuthenticated = isRecentPartnerEmailChangeAuthentication({
      mfaRequired: input.actor.mfaRequired,
      authMethod: session.authMethod,
      assuranceLevel: session.assuranceLevel,
      sessionCreatedAt: session.createdAt,
      mfaVerifiedAt: session.mfaVerifiedAt,
      now,
    });
    if (input.currentPassword && user.passwordHash) {
      if (!currentPasswordVerification?.valid) {
        await tx.insert(auditLogs).values(
          requestAudit(input.actor, {
            outcome: "denied",
            targetEmail,
            reason: "invalid_current_password",
          }),
        );
        return { kind: "invalid_current_password" } as const;
      }
    }
    if (input.actor.mfaRequired && !recentlyAuthenticated) {
      await tx.insert(auditLogs).values(
        requestAudit(input.actor, {
          outcome: "denied",
          targetEmail,
          reason: "recent_mfa_required",
        }),
      );
      return { kind: "recent_mfa_required" } as const;
    }
    if (!input.actor.mfaRequired && !recentlyAuthenticated) {
      if (!user.passwordHash) {
        await tx.insert(auditLogs).values(
          requestAudit(input.actor, {
            outcome: "denied",
            targetEmail,
            reason: "recent_authentication_required",
          }),
        );
        return { kind: "recent_authentication_required" } as const;
      }
      if (!input.currentPassword) {
        await tx.insert(auditLogs).values(
          requestAudit(input.actor, {
            outcome: "denied",
            targetEmail,
            reason: "current_password_required",
          }),
        );
        return { kind: "current_password_required" } as const;
      }
    }

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`partner-auth:email-change-target:${targetEmail}`}))`,
    );
    const [collision] = await tx
      .select({ id: partnerUsers.id })
      .from(partnerUsers)
      .where(
        and(
          eq(partnerUsers.normalizedEmail, targetEmail),
          ne(partnerUsers.id, user.id),
        ),
      )
      .limit(1);
    if (collision?.id) {
      await tx.insert(auditLogs).values(
        requestAudit(input.actor, {
          outcome: "denied",
          targetEmail,
          reason: "target_identity_unavailable",
        }),
      );
      // Deliberately neutral: an authenticated partner cannot use this route
      // as an identity-directory oracle.
      return { kind: "accepted", expiresAt: null } as const;
    }

    const challenge = await createPartnerPurposeChallengeInTransaction(tx, {
      purpose: "email_change",
      normalizedEmail: targetEmail,
      correlationId: input.actor.correlationId,
      request: input.request,
      subject: {
        partnerUserId: user.id,
        partnerAccountId: input.actor.accountId,
        partnerMembershipId: input.actor.membershipId,
        securityVersionSnapshot: user.securityVersion,
      },
      now,
    });
    await tx.insert(auditLogs).values(
      requestAudit(input.actor, {
        outcome: "attempted",
        targetEmail,
        challengeId: challenge.challengeId,
        meta: {
          assurance: input.actor.mfaRequired
            ? "recent_mfa"
            : recentlyAuthenticated
              ? "recent_session"
              : "current_password",
          expiresAt: challenge.expiresAt.toISOString(),
        },
      }),
    );
    return { kind: "accepted", expiresAt: challenge.expiresAt } as const;
  });
}

async function revokeChallengeForReconciliation(input: {
  digest: string;
  correlationId: string;
  now: Date;
}): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [challenge] = await tx
      .select({
        id: partnerAuthChallenges.id,
        partnerUserId: partnerAuthChallenges.partnerUserId,
        normalizedEmail: partnerAuthChallenges.normalizedEmail,
      })
      .from(partnerAuthChallenges)
      .where(
        and(
          eq(partnerAuthChallenges.tokenHash, input.digest),
          eq(partnerAuthChallenges.purpose, "email_change"),
          eq(partnerAuthChallenges.status, "pending"),
        ),
      )
      .for("update")
      .limit(1);
    if (!challenge) return;
    await tx
      .update(partnerAuthChallenges)
      .set({
        status: "revoked",
        tokenHash: null,
        revokedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(partnerAuthChallenges.id, challenge.id));
    await tx.insert(auditLogs).values({
      actorType: "system",
      actorId: challenge.partnerUserId,
      actorLabel: "partner-purpose-auth",
      authMethod: "service",
      correlationId: input.correlationId,
      outcome: "failed",
      surface: "/partners/confirm-email",
      action: "partner.auth.email_change.reconciliation_required",
      entityType: "partner_auth_challenge",
      entityId: challenge.id,
      meta: sanitizeAuditMetadata({
        targetEmailHash: emailFingerprint(challenge.normalizedEmail),
        reason: "normalized_email_unique_conflict",
      }),
    });
  });
}

export async function confirmPartnerEmailChange(input: {
  rawToken: string;
  request: NextRequest;
  correlationId: string;
  now?: Date;
}): Promise<ConfirmPartnerEmailChangeResult> {
  const now = input.now ?? new Date();
  const digest = tokenHash(input.rawToken);
  try {
    return await getDb().transaction(async (tx) => {
      const [hint] = await tx
        .select({
          id: partnerAuthChallenges.id,
          partnerUserId: partnerAuthChallenges.partnerUserId,
        })
        .from(partnerAuthChallenges)
        .where(
          and(
            eq(partnerAuthChallenges.tokenHash, digest),
            eq(partnerAuthChallenges.purpose, "email_change"),
            eq(partnerAuthChallenges.status, "pending"),
          ),
        )
        .limit(1);
      if (!hint?.id || !hint.partnerUserId) return { kind: "invalid" } as const;

      const [user] = await tx
        .select({
          id: partnerUsers.id,
          email: partnerUsers.email,
          normalizedEmail: partnerUsers.normalizedEmail,
          active: partnerUsers.active,
          identityStatus: partnerUsers.identityStatus,
          securityVersion: partnerUsers.securityVersion,
        })
        .from(partnerUsers)
        .where(eq(partnerUsers.id, hint.partnerUserId))
        .for("update")
        .limit(1);
      if (!user?.id) return { kind: "invalid" } as const;

      const [challenge] = await tx
        .select()
        .from(partnerAuthChallenges)
        .where(
          and(
            eq(partnerAuthChallenges.id, hint.id),
            eq(partnerAuthChallenges.partnerUserId, user.id),
            eq(partnerAuthChallenges.tokenHash, digest),
            eq(partnerAuthChallenges.purpose, "email_change"),
            eq(partnerAuthChallenges.status, "pending"),
          ),
        )
        .for("update")
        .limit(1);
      if (!challenge) return { kind: "invalid" } as const;
      if (challenge.expiresAt <= now) {
        await tx
          .update(partnerAuthChallenges)
          .set({
            status: "expired",
            tokenHash: null,
            expiredAt: now,
            updatedAt: now,
          })
          .where(eq(partnerAuthChallenges.id, challenge.id));
        return { kind: "expired" } as const;
      }

      const [access] =
        challenge.partnerAccountId && challenge.partnerMembershipId
          ? await tx
              .select({ membershipId: partnerAccountMemberships.id })
              .from(partnerAccountMemberships)
              .innerJoin(
                partnerAccounts,
                eq(
                  partnerAccountMemberships.partnerAccountId,
                  partnerAccounts.id,
                ),
              )
              .where(
                and(
                  eq(
                    partnerAccountMemberships.id,
                    challenge.partnerMembershipId,
                  ),
                  eq(
                    partnerAccountMemberships.partnerAccountId,
                    challenge.partnerAccountId,
                  ),
                  eq(partnerAccountMemberships.partnerUserId, user.id),
                  eq(partnerAccountMemberships.status, "active"),
                  eq(partnerAccounts.portalAccessEnabled, true),
                ),
              )
              .limit(1)
          : [];
      if (
        !user.active ||
        user.identityStatus !== "active" ||
        !user.normalizedEmail ||
        challenge.applicationId ||
        challenge.securityVersionSnapshot !== user.securityVersion ||
        !access?.membershipId
      ) {
        await tx
          .update(partnerAuthChallenges)
          .set({
            status: "revoked",
            tokenHash: null,
            revokedAt: now,
            updatedAt: now,
          })
          .where(eq(partnerAuthChallenges.id, challenge.id));
        return { kind: "invalid" } as const;
      }

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`partner-auth:email-change-target:${challenge.normalizedEmail}`}))`,
      );
      const [collision] = await tx
        .select({ id: partnerUsers.id })
        .from(partnerUsers)
        .where(
          and(
            eq(partnerUsers.normalizedEmail, challenge.normalizedEmail),
            ne(partnerUsers.id, user.id),
          ),
        )
        .limit(1);
      if (collision?.id) {
        await tx
          .update(partnerAuthChallenges)
          .set({
            status: "revoked",
            tokenHash: null,
            revokedAt: now,
            updatedAt: now,
          })
          .where(eq(partnerAuthChallenges.id, challenge.id));
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorId: user.id,
          actorLabel: "partner-purpose-auth",
          authMethod: "partner_pre_auth",
          correlationId: input.correlationId,
          outcome: "failed",
          surface: "/partners/confirm-email",
          action: "partner.auth.email_change.reconciliation_required",
          entityType: "partner_auth_challenge",
          entityId: challenge.id,
          meta: sanitizeAuditMetadata({
            partnerAccountId: challenge.partnerAccountId,
            partnerMembershipId: challenge.partnerMembershipId,
            targetEmailHash: emailFingerprint(challenge.normalizedEmail),
            reason: "target_identity_unavailable",
          }),
        });
        return { kind: "reconciliation_required" } as const;
      }

      const [consumed] = await tx
        .update(partnerAuthChallenges)
        .set({
          status: "consumed",
          tokenHash: null,
          consumedAt: now,
          consumedIp: getClientIp(input.request),
          consumedUserAgent: getUserAgent(input.request),
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAuthChallenges.id, challenge.id),
            eq(partnerAuthChallenges.status, "pending"),
            eq(partnerAuthChallenges.tokenHash, digest),
          ),
        )
        .returning({ id: partnerAuthChallenges.id });
      if (!consumed?.id) return { kind: "invalid" } as const;

      const nextSecurityVersion = user.securityVersion + 1;
      const [updatedUser] = await tx
        .update(partnerUsers)
        .set({
          email: challenge.normalizedEmail,
          normalizedEmail: challenge.normalizedEmail,
          emailVerifiedAt: now,
          securityVersion: nextSecurityVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerUsers.id, user.id),
            eq(partnerUsers.securityVersion, user.securityVersion),
            eq(partnerUsers.active, true),
            eq(partnerUsers.identityStatus, "active"),
          ),
        )
        .returning({ id: partnerUsers.id });
      if (!updatedUser?.id)
        throw new Error("partner_email_change_user_changed");

      const revokedSessions = await tx
        .update(partnerSessions)
        .set({ revokedAt: now, lastSeenAt: now })
        .where(
          and(
            eq(partnerSessions.partnerUserId, user.id),
            isNull(partnerSessions.revokedAt),
          ),
        )
        .returning({ id: partnerSessions.id });
      await tx
        .update(partnerLoginTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(partnerLoginTokens.partnerUserId, user.id),
            isNull(partnerLoginTokens.usedAt),
          ),
        );
      await tx
        .update(partnerAuthTransactions)
        .set({ consumedAt: now })
        .where(
          and(
            eq(partnerAuthTransactions.partnerUserId, user.id),
            isNull(partnerAuthTransactions.consumedAt),
          ),
        );
      await tx
        .update(partnerAuthChallenges)
        .set({
          status: "revoked",
          tokenHash: null,
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAuthChallenges.partnerUserId, user.id),
            eq(partnerAuthChallenges.status, "pending"),
            ne(partnerAuthChallenges.id, challenge.id),
          ),
        );
      await tx.insert(auditLogs).values({
        actorType: "human",
        actorId: user.id,
        actorLabel: challenge.normalizedEmail,
        authMethod: "partner_pre_auth",
        correlationId: input.correlationId,
        outcome: "succeeded",
        surface: "/partners/confirm-email",
        action: "partner.auth.email_change.completed",
        entityType: "partner_user",
        entityId: user.id,
        meta: sanitizeAuditMetadata({
          partnerAccountId: challenge.partnerAccountId,
          partnerMembershipId: challenge.partnerMembershipId,
          sourceEmailHash: emailFingerprint(user.normalizedEmail),
          targetEmailHash: emailFingerprint(challenge.normalizedEmail),
          securityVersion: nextSecurityVersion,
          sessionsRevoked: revokedSessions.length,
          autoLoginIssued: false,
        }),
      });
      return {
        kind: "success",
        changedAt: now,
        sessionsRevoked: revokedSessions.length,
      } as const;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await revokeChallengeForReconciliation({
      digest,
      correlationId: input.correlationId,
      now,
    });
    return { kind: "reconciliation_required" };
  }
}
