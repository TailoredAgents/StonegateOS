import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerAuthTransactions,
  partnerMfaMethods,
  partnerMfaRecoveryCodes,
  partnerSessions,
  partnerUsers,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  decryptPartnerTotpSecret,
  verifyPartnerMfaRecoveryCode,
  verifyPartnerTotp,
} from "@/lib/partner-mfa";
import {
  getPartnerAuthRequestBinding,
  PARTNER_PASSWORD_MFA_MAX_ATTEMPTS,
  randomToken,
  sha256Base64Url,
} from "@/lib/partner-portal-auth";

const STANDARD_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type CompletePartnerPasswordMfaResult =
  | {
      kind: "success";
      sessionToken: string;
      expiresAt: Date;
      recoveryCodeUsed: boolean;
    }
  | { kind: "invalid_transaction" }
  | { kind: "expired" }
  | { kind: "invalid_code"; attemptsRemaining: number }
  | { kind: "mfa_enrollment_required" };

export function partnerAuthRequestBindingsMatch(
  left: {
    requestedIp: string | null;
    requestedUserAgent: string | null;
  },
  right: {
    requestedIp: string | null;
    requestedUserAgent: string | null;
  },
): boolean {
  return (
    left.requestedIp === right.requestedIp &&
    left.requestedUserAgent === right.requestedUserAgent
  );
}

function auditValues(input: {
  action: string;
  outcome: "succeeded" | "denied";
  partnerUserId: string;
  email: string;
  roleKey: string;
  correlationId: string;
  transactionId: string;
  accountId: string;
  membershipId: string;
  sessionId?: string | null;
  meta?: Record<string, unknown>;
}) {
  const id = randomUUID();
  return {
    id,
    actorType: "human" as const,
    actorId: input.partnerUserId,
    actorLabel: input.email,
    actorRole: input.roleKey,
    sessionId: input.sessionId ?? null,
    authMethod: "partner_pre_auth",
    correlationId: input.correlationId,
    requiredPermissions: [] as string[],
    outcome: input.outcome,
    surface: "/partners/login/mfa",
    action: input.action,
    entityType: "partner_auth_transaction",
    entityId: input.transactionId,
    meta: sanitizeAuditMetadata({
      eventId: id,
      correlationId: input.correlationId,
      partnerAccountId: input.accountId,
      partnerMembershipId: input.membershipId,
      ...input.meta,
    }),
  };
}

export async function completePartnerPasswordMfa(input: {
  transactionToken: string;
  request: NextRequest;
  correlationId: string;
  code?: string;
  recoveryCode?: string;
  now?: Date;
}): Promise<CompletePartnerPasswordMfaResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  const tokenHash = sha256Base64Url(input.transactionToken);
  const currentBinding = getPartnerAuthRequestBinding(input.request);

  return db.transaction(async (tx) => {
    // Resolve an untrusted hint first, then preserve the global identity-first
    // lock order used by password login and security mutations.
    const [hint] = await tx
      .select({
        id: partnerAuthTransactions.id,
        partnerUserId: partnerAuthTransactions.partnerUserId,
      })
      .from(partnerAuthTransactions)
      .where(eq(partnerAuthTransactions.tokenHash, tokenHash))
      .limit(1);
    if (!hint?.id) return { kind: "invalid_transaction" } as const;

    const [user] = await tx
      .select({
        id: partnerUsers.id,
        email: partnerUsers.email,
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        securityVersion: partnerUsers.securityVersion,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, hint.partnerUserId))
      .for("update")
      .limit(1);
    if (!user?.id) return { kind: "invalid_transaction" } as const;

    const [transaction] = await tx
      .select()
      .from(partnerAuthTransactions)
      .where(
        and(
          eq(partnerAuthTransactions.id, hint.id),
          eq(partnerAuthTransactions.partnerUserId, user.id),
          eq(partnerAuthTransactions.tokenHash, tokenHash),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !transaction ||
      transaction.purpose !== "password_login_mfa" ||
      transaction.consumedAt
    ) {
      return { kind: "invalid_transaction" } as const;
    }

    const [binding] = await tx
      .select({
        accountId: partnerAccounts.id,
        membershipId: partnerAccountMemberships.id,
        roleKey: partnerAccountMemberships.roleKey,
      })
      .from(partnerAccountMemberships)
      .innerJoin(
        partnerAccounts,
        eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
      )
      .where(
        and(
          eq(partnerAccountMemberships.id, transaction.partnerMembershipId),
          eq(
            partnerAccountMemberships.partnerAccountId,
            transaction.partnerAccountId,
          ),
          eq(partnerAccountMemberships.partnerUserId, user.id),
          eq(partnerAccountMemberships.status, "active"),
          eq(partnerAccounts.portalAccessEnabled, true),
        ),
      )
      .limit(1);
    const auditBinding = {
      partnerUserId: user.id,
      email: user.email,
      roleKey: binding?.roleKey ?? "unavailable",
      correlationId: input.correlationId,
      transactionId: transaction.id,
      accountId: transaction.partnerAccountId,
      membershipId: transaction.partnerMembershipId,
    };

    if (transaction.expiresAt <= now) {
      await tx
        .update(partnerAuthTransactions)
        .set({ consumedAt: now })
        .where(
          and(
            eq(partnerAuthTransactions.id, transaction.id),
            isNull(partnerAuthTransactions.consumedAt),
          ),
        );
      await tx.insert(auditLogs).values(
        auditValues({
          ...auditBinding,
          action: "partner.auth.password_mfa_expired",
          outcome: "denied",
        }),
      );
      return { kind: "expired" } as const;
    }

    const requestBound = partnerAuthRequestBindingsMatch(
      {
        requestedIp: transaction.requestedIp,
        requestedUserAgent: transaction.requestedUserAgent,
      },
      currentBinding,
    );
    if (
      !requestBound ||
      !user.active ||
      user.identityStatus !== "active" ||
      user.securityVersion !== transaction.securityVersion ||
      !binding?.membershipId
    ) {
      await tx
        .update(partnerAuthTransactions)
        .set({ consumedAt: now })
        .where(
          and(
            eq(partnerAuthTransactions.id, transaction.id),
            isNull(partnerAuthTransactions.consumedAt),
          ),
        );
      await tx.insert(auditLogs).values(
        auditValues({
          ...auditBinding,
          action: "partner.auth.password_mfa_binding_denied",
          outcome: "denied",
          meta: {
            requestBound,
            identityEligible: user.active && user.identityStatus === "active",
            securityVersionMatched:
              user.securityVersion === transaction.securityVersion,
            membershipEligible: Boolean(binding?.membershipId),
          },
        }),
      );
      return { kind: "invalid_transaction" } as const;
    }

    const [method] = await tx
      .select()
      .from(partnerMfaMethods)
      .where(
        and(
          eq(partnerMfaMethods.partnerUserId, user.id),
          eq(partnerMfaMethods.methodType, "totp"),
          eq(partnerMfaMethods.enabled, true),
        ),
      )
      .orderBy(desc(partnerMfaMethods.enrolledAt), desc(partnerMfaMethods.id))
      .for("update")
      .limit(1);
    if (
      !method?.id ||
      !method.totpSecretCiphertext ||
      !method.totpSecretKeyVersion
    ) {
      await tx
        .update(partnerAuthTransactions)
        .set({ consumedAt: now })
        .where(eq(partnerAuthTransactions.id, transaction.id));
      await tx.insert(auditLogs).values(
        auditValues({
          ...auditBinding,
          action: "partner.auth.password_mfa_enrollment_required",
          outcome: "denied",
          meta: { reason: "active_totp_method_missing" },
        }),
      );
      return { kind: "mfa_enrollment_required" } as const;
    }

    let acceptedCounter: number | null = null;
    let recoveryCodeId: string | null = null;
    if (input.code) {
      const secret = decryptPartnerTotpSecret({
        partnerUserId: user.id,
        ciphertext: method.totpSecretCiphertext,
        keyVersion: method.totpSecretKeyVersion,
      });
      acceptedCounter = verifyPartnerTotp({
        secret,
        code: input.code,
        at: now,
        lastAcceptedCounter: method.lastTotpCounter,
      });
    } else if (input.recoveryCode) {
      const candidates = await tx
        .select()
        .from(partnerMfaRecoveryCodes)
        .where(
          and(
            eq(partnerMfaRecoveryCodes.methodId, method.id),
            isNull(partnerMfaRecoveryCodes.usedAt),
          ),
        )
        .for("update");
      for (const candidate of candidates) {
        if (
          verifyPartnerMfaRecoveryCode({
            code: input.recoveryCode,
            expectedHash: candidate.codeHash,
            partnerUserId: user.id,
            methodId: method.id,
            keyVersion: candidate.keyVersion,
          })
        ) {
          recoveryCodeId = candidate.id;
        }
      }
    }

    if (acceptedCounter === null && !recoveryCodeId) {
      const nextAttemptCount = Math.min(
        PARTNER_PASSWORD_MFA_MAX_ATTEMPTS,
        transaction.attemptCount + 1,
      );
      const attemptsRemaining = Math.max(
        0,
        PARTNER_PASSWORD_MFA_MAX_ATTEMPTS - nextAttemptCount,
      );
      await tx
        .update(partnerAuthTransactions)
        .set({
          attemptCount: nextAttemptCount,
          consumedAt: attemptsRemaining === 0 ? now : null,
        })
        .where(
          and(
            eq(partnerAuthTransactions.id, transaction.id),
            isNull(partnerAuthTransactions.consumedAt),
          ),
        );
      await tx.insert(auditLogs).values(
        auditValues({
          ...auditBinding,
          action: "partner.auth.password_mfa_verification_denied",
          outcome: "denied",
          meta: {
            attemptsRemaining,
            method: input.recoveryCode ? "recovery_code" : "totp",
          },
        }),
      );
      return { kind: "invalid_code", attemptsRemaining } as const;
    }

    const [consumedTransaction] = await tx
      .update(partnerAuthTransactions)
      .set({ consumedAt: now })
      .where(
        and(
          eq(partnerAuthTransactions.id, transaction.id),
          isNull(partnerAuthTransactions.consumedAt),
          gt(partnerAuthTransactions.expiresAt, now),
        ),
      )
      .returning({ id: partnerAuthTransactions.id });
    if (!consumedTransaction?.id) {
      return { kind: "invalid_transaction" } as const;
    }

    if (recoveryCodeId) {
      const [consumedRecovery] = await tx
        .update(partnerMfaRecoveryCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(partnerMfaRecoveryCodes.id, recoveryCodeId),
            isNull(partnerMfaRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: partnerMfaRecoveryCodes.id });
      if (!consumedRecovery?.id) {
        throw new Error("partner_mfa_recovery_code_changed");
      }
    }

    await tx
      .update(partnerMfaMethods)
      .set({
        lastUsedAt: now,
        ...(acceptedCounter === null
          ? {}
          : { lastTotpCounter: acceptedCounter }),
        updatedAt: now,
      })
      .where(eq(partnerMfaMethods.id, method.id));

    const sessionId = randomUUID();
    const sessionToken = randomToken(32);
    const expiresAt = new Date(
      now.getTime() +
        (transaction.rememberMe
          ? REMEMBERED_SESSION_TTL_MS
          : STANDARD_SESSION_TTL_MS),
    );
    await tx.insert(partnerSessions).values({
      id: sessionId,
      partnerUserId: user.id,
      activePartnerAccountId: binding.accountId,
      activeMembershipId: binding.membershipId,
      sessionHash: sha256Base64Url(sessionToken),
      authMethod: "mfa_step_up",
      assuranceLevel: "aal2",
      mfaVerifiedAt: now,
      securityVersion: user.securityVersion,
      accountSelectedAt: now,
      ip: currentBinding.requestedIp,
      userAgent: currentBinding.requestedUserAgent,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
    });
    const [completed] = await tx
      .update(partnerAuthTransactions)
      .set({ completedSessionId: sessionId })
      .where(eq(partnerAuthTransactions.id, transaction.id))
      .returning({ id: partnerAuthTransactions.id });
    if (!completed?.id) {
      throw new Error("partner_auth_transaction_completion_failed");
    }
    await tx.insert(auditLogs).values(
      auditValues({
        ...auditBinding,
        action: "partner.auth.password_mfa_completed",
        outcome: "succeeded",
        sessionId,
        meta: {
          recoveryCodeUsed: Boolean(recoveryCodeId),
          assuranceLevel: "aal2",
          rememberMe: transaction.rememberMe,
        },
      }),
    );
    return {
      kind: "success",
      sessionToken,
      expiresAt,
      recoveryCodeUsed: Boolean(recoveryCodeId),
    } as const;
  });
}
