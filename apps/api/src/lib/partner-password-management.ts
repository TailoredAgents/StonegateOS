import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAuthChallenges,
  partnerLoginTokens,
  partnerSessions,
  partnerUsers,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  hashPartnerPassword,
  PARTNER_PASSWORD_HASH_VERSION_ARGON2ID,
  verifyPartnerPassword,
} from "@/lib/partner-password-crypto";

export const PARTNER_PASSWORD_MIN_LENGTH = 15;
export const PARTNER_PASSWORD_MAX_LENGTH = 128;
const RECENT_PASSWORD_MS = 15 * 60 * 1_000;

class PartnerPasswordMutationUnavailable extends Error {}

type PasswordActor = {
  partnerUserId: string;
  email: string;
  roleKey: string;
  accountId: string | null;
  membershipId: string | null;
  sessionId: string;
  correlationId: string;
};

export type PartnerPasswordChangeResult =
  | {
      kind: "success";
      passwordPreviouslySet: boolean;
      otherSessionsRevoked: number;
      changedAt: Date;
    }
  | {
      kind:
        | "current_password_required"
        | "invalid_current_password"
        | "recent_authentication_required"
        | "password_reused"
        | "session_unavailable"
        | "user_unavailable";
    };

export function isRecentPartnerPasswordAuthentication(input: {
  authMethod: string;
  sessionCreatedAt: Date;
  now: Date;
}): boolean {
  return (
    input.authMethod === "password" &&
    input.now.getTime() - input.sessionCreatedAt.getTime() <= RECENT_PASSWORD_MS
  );
}

function auditRecord(
  actor: PasswordActor,
  input: {
    outcome: "succeeded" | "denied";
    reason?: string;
    meta?: Record<string, unknown>;
  },
) {
  const auditId = randomUUID();
  return {
    id: auditId,
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
    action: "partner.password.changed",
    entityType: "partner_user",
    entityId: actor.partnerUserId,
    meta: sanitizeAuditMetadata({
      eventId: auditId,
      partnerAccountId: actor.accountId,
      partnerMembershipId: actor.membershipId,
      ...(input.reason ? { reason: input.reason } : {}),
      ...input.meta,
    }),
  };
}

export async function changePartnerPassword(input: {
  actor: PasswordActor;
  currentPassword?: string;
  newPassword: string;
  now?: Date;
}): Promise<PartnerPasswordChangeResult> {
  const now = input.now ?? new Date();
  const db = getDb();
  const [previewUser] = await db
    .select({
      id: partnerUsers.id,
      active: partnerUsers.active,
      passwordHash: partnerUsers.passwordHash,
      securityVersion: partnerUsers.securityVersion,
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.id, input.actor.partnerUserId))
    .limit(1);
  if (!previewUser?.active) return { kind: "user_unavailable" };
  const reuseVerification = previewUser.passwordHash
    ? await verifyPartnerPassword(input.newPassword, previewUser.passwordHash)
    : null;
  const currentVerification =
    previewUser.passwordHash && input.currentPassword
      ? await verifyPartnerPassword(
          input.currentPassword,
          previewUser.passwordHash,
        )
      : null;
  // Argon2 runs before identity/session row locks are acquired.
  const nextPasswordHash = await hashPartnerPassword(input.newPassword);

  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .select({
          id: partnerUsers.id,
          active: partnerUsers.active,
          passwordHash: partnerUsers.passwordHash,
          securityVersion: partnerUsers.securityVersion,
        })
        .from(partnerUsers)
        .where(eq(partnerUsers.id, input.actor.partnerUserId))
        .for("update")
        .limit(1);
      if (
        !user?.id ||
        !user.active ||
        user.passwordHash !== previewUser.passwordHash ||
        user.securityVersion !== previewUser.securityVersion
      ) {
        return { kind: "user_unavailable" };
      }

      const [session] = await tx
        .select({
          id: partnerSessions.id,
          authMethod: partnerSessions.authMethod,
          createdAt: partnerSessions.createdAt,
        })
        .from(partnerSessions)
        .where(
          and(
            eq(partnerSessions.id, input.actor.sessionId),
            eq(partnerSessions.partnerUserId, input.actor.partnerUserId),
            eq(partnerSessions.securityVersion, user.securityVersion),
            isNull(partnerSessions.revokedAt),
            gt(partnerSessions.expiresAt, now),
          ),
        )
        .for("update")
        .limit(1);
      if (!session?.id) return { kind: "session_unavailable" };

      const recentlyAuthenticated = isRecentPartnerPasswordAuthentication({
        authMethod: session.authMethod,
        sessionCreatedAt: session.createdAt,
        now,
      });
      const hadPassword = Boolean(user.passwordHash);

      if (user.passwordHash) {
        if (reuseVerification?.valid) {
          await tx.insert(auditLogs).values(
            auditRecord(input.actor, {
              outcome: "denied",
              reason: "password_reused",
            }),
          );
          return { kind: "password_reused" };
        }
        if (!recentlyAuthenticated && !input.currentPassword) {
          await tx.insert(auditLogs).values(
            auditRecord(input.actor, {
              outcome: "denied",
              reason: "current_password_required",
            }),
          );
          return { kind: "current_password_required" };
        }
        if (input.currentPassword && !currentVerification?.valid) {
          await tx.insert(auditLogs).values(
            auditRecord(input.actor, {
              outcome: "denied",
              reason: "invalid_current_password",
            }),
          );
          return { kind: "invalid_current_password" };
        }
      } else if (!recentlyAuthenticated) {
        await tx.insert(auditLogs).values(
          auditRecord(input.actor, {
            outcome: "denied",
            reason: "recent_authentication_required",
          }),
        );
        return { kind: "recent_authentication_required" };
      }

      const nextSecurityVersion = user.securityVersion + 1;
      const [passwordUpdated] = await tx
        .update(partnerUsers)
        .set({
          passwordHash: nextPasswordHash,
          passwordHashVersion: PARTNER_PASSWORD_HASH_VERSION_ARGON2ID,
          passwordSetAt: now,
          securityVersion: nextSecurityVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerUsers.id, user.id),
            eq(partnerUsers.securityVersion, user.securityVersion),
            eq(partnerUsers.active, true),
          ),
        )
        .returning({ id: partnerUsers.id });
      if (!passwordUpdated) return { kind: "user_unavailable" };

      const revokedSessions = await tx
        .update(partnerSessions)
        .set({ revokedAt: now, lastSeenAt: now })
        .where(
          and(
            eq(partnerSessions.partnerUserId, user.id),
            ne(partnerSessions.id, session.id),
            isNull(partnerSessions.revokedAt),
          ),
        )
        .returning({ id: partnerSessions.id });
      const [updatedSession] = await tx
        .update(partnerSessions)
        .set({ securityVersion: nextSecurityVersion, lastSeenAt: now })
        .where(
          and(
            eq(partnerSessions.id, session.id),
            eq(partnerSessions.partnerUserId, user.id),
            isNull(partnerSessions.revokedAt),
            gt(partnerSessions.expiresAt, now),
          ),
        )
        .returning({ id: partnerSessions.id });
      if (!updatedSession?.id) {
        throw new PartnerPasswordMutationUnavailable(
          "partner_password_session_changed",
        );
      }

      // Credential changes invalidate any unconsumed links issued under the old
      // security posture, while the authenticated current session is preserved.
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
          ),
        );
      await tx.insert(auditLogs).values(
        auditRecord(input.actor, {
          outcome: "succeeded",
          meta: {
            passwordPreviouslySet: hadPassword,
            otherSessionsRevoked: revokedSessions.length,
            outstandingMagicLinksInvalidated: true,
            outstandingPurposeLinksInvalidated: true,
          },
        }),
      );

      return {
        kind: "success",
        passwordPreviouslySet: hadPassword,
        otherSessionsRevoked: revokedSessions.length,
        changedAt: now,
      };
    });
  } catch (error) {
    if (error instanceof PartnerPasswordMutationUnavailable) {
      return { kind: "session_unavailable" };
    }
    throw error;
  }
}
