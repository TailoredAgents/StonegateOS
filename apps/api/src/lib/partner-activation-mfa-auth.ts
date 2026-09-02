import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  auditLogs,
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
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  createPartnerTotpUri,
  decryptPartnerTotpSecret,
  encryptPartnerTotpSecret,
  generatePartnerMfaRecoveryCodes,
  generatePartnerTotpSecret,
  hashPartnerMfaRecoveryCode,
  verifyPartnerMfaRecoveryCode,
  verifyPartnerTotp,
} from "@/lib/partner-mfa";
import { partnerAuthRequestBindingsMatch } from "@/lib/partner-password-mfa-auth";
import { partnerActivationStateKind } from "@/lib/partner-purpose-auth";
import {
  getPartnerAuthRequestBinding,
  PARTNER_PASSWORD_MFA_MAX_ATTEMPTS,
  randomToken,
  sha256Base64Url,
} from "@/lib/partner-portal-auth";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const ENROLLMENT_TTL_MS = 10 * 60 * 1_000;
const STANDARD_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

type LockedActivationContext = {
  transaction: typeof partnerAuthTransactions.$inferSelect;
  user: {
    id: string;
    email: string;
    active: boolean;
    identityStatus: (typeof partnerUsers.$inferSelect)["identityStatus"];
    securityVersion: number;
    mfaRequired: boolean;
    mfaEnrolledAt: Date | null;
    passwordHash: string | null;
  };
  account: { id: string };
  membership: { id: string; roleKey: string; status: string };
  recovery: boolean;
};

export type StartPartnerActivationMfaResult =
  | {
      kind: "enrollment";
      challengeId: string;
      secret: string;
      otpauthUri: string;
      expiresAt: Date;
    }
  | { kind: "verification_required"; expiresAt: Date }
  | { kind: "invalid_transaction" }
  | { kind: "expired" };

export type CompletePartnerActivationMfaResult =
  | {
      kind: "success";
      sessionToken: string;
      expiresAt: Date;
      recoveryCodes: string[];
      recoveryCodeUsed: boolean;
      enrolled: boolean;
    }
  | { kind: "invalid_transaction" }
  | { kind: "expired" }
  | { kind: "invalid_code"; attemptsRemaining: number }
  | { kind: "enrollment_required" };

function auditValues(
  context: LockedActivationContext,
  input: {
    action: string;
    outcome: "attempted" | "succeeded" | "denied";
    correlationId: string;
    sessionId?: string | null;
    meta?: Record<string, unknown>;
  },
) {
  const id = randomUUID();
  return {
    id,
    actorType: "human" as const,
    actorId: context.user.id,
    actorLabel: context.user.email,
    actorRole: context.membership.roleKey,
    sessionId: input.sessionId ?? null,
    authMethod: "partner_pre_auth",
    correlationId: input.correlationId,
    requiredPermissions: [] as string[],
    outcome: input.outcome,
    surface: "/partners/activate/mfa",
    action: input.action,
    entityType: "partner_auth_transaction",
    entityId: context.transaction.id,
    meta: sanitizeAuditMetadata({
      eventId: id,
      correlationId: input.correlationId,
      partnerAccountId: context.account.id,
      partnerMembershipId: context.membership.id,
      sourceAuthChallengeId: context.transaction.sourceAuthChallengeId,
      ...input.meta,
    }),
  };
}

async function loadLockedActivationContext(
  tx: TeamMutationTransaction,
  tokenHash: string,
): Promise<LockedActivationContext | null> {
  const [hint] = await tx
    .select({
      id: partnerAuthTransactions.id,
      partnerUserId: partnerAuthTransactions.partnerUserId,
    })
    .from(partnerAuthTransactions)
    .where(eq(partnerAuthTransactions.tokenHash, tokenHash))
    .limit(1);
  if (!hint?.id) return null;

  const [user] = await tx
    .select({
      id: partnerUsers.id,
      email: partnerUsers.email,
      active: partnerUsers.active,
      identityStatus: partnerUsers.identityStatus,
      securityVersion: partnerUsers.securityVersion,
      mfaRequired: partnerUsers.mfaRequired,
      mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
      passwordHash: partnerUsers.passwordHash,
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.id, hint.partnerUserId))
    .for("update")
    .limit(1);
  if (!user?.id) return null;

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
    transaction.purpose !== "activation_mfa_setup" ||
    !transaction.sourceAuthChallengeId ||
    transaction.consumedAt
  ) {
    return null;
  }

  const [binding] = await tx
    .select({
      account: { id: partnerAccounts.id },
      membership: {
        id: partnerAccountMemberships.id,
        roleKey: partnerAccountMemberships.roleKey,
        status: partnerAccountMemberships.status,
      },
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
        or(
          eq(partnerAccountMemberships.status, "invited"),
          eq(partnerAccountMemberships.status, "active"),
        ),
        eq(partnerAccounts.portalAccessEnabled, true),
      ),
    )
    .limit(1);
  if (!binding) return null;

  const [enabledMfaMethod] = await tx
    .select({ id: partnerMfaMethods.id })
    .from(partnerMfaMethods)
    .where(
      and(
        eq(partnerMfaMethods.partnerUserId, user.id),
        eq(partnerMfaMethods.enabled, true),
      ),
    )
    .for("update")
    .limit(1);
  const activationKind = partnerActivationStateKind({
    user,
    membershipStatus: binding.membership.status,
    hasEnabledMfaMethod: Boolean(enabledMfaMethod?.id),
  });
  if (!activationKind) return null;

  const [source] = await tx
    .select({ id: partnerAuthChallenges.id })
    .from(partnerAuthChallenges)
    .where(
      and(
        eq(partnerAuthChallenges.id, transaction.sourceAuthChallengeId),
        eq(partnerAuthChallenges.purpose, "account_activation"),
        eq(partnerAuthChallenges.status, "consumed"),
        eq(partnerAuthChallenges.partnerUserId, user.id),
        eq(partnerAuthChallenges.partnerAccountId, binding.account.id),
        eq(partnerAuthChallenges.partnerMembershipId, binding.membership.id),
      ),
    )
    .limit(1);
  if (!source?.id) return null;

  return {
    transaction,
    user,
    ...binding,
    recovery: activationKind === "mfa_recovery",
  };
}

async function consumeInvalidTransaction(
  tx: TeamMutationTransaction,
  context: LockedActivationContext,
  now: Date,
  input: {
    action: string;
    correlationId: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await tx
    .update(partnerAuthTransactions)
    .set({ consumedAt: now })
    .where(
      and(
        eq(partnerAuthTransactions.id, context.transaction.id),
        isNull(partnerAuthTransactions.consumedAt),
      ),
    );
  await tx
    .update(partnerMfaEnrollmentChallenges)
    .set({ consumedAt: now })
    .where(
      and(
        eq(
          partnerMfaEnrollmentChallenges.authTransactionId,
          context.transaction.id,
        ),
        isNull(partnerMfaEnrollmentChallenges.consumedAt),
      ),
    );
  await tx.insert(auditLogs).values(
    auditValues(context, {
      action: input.action,
      outcome: "denied",
      correlationId: input.correlationId,
      meta: input.meta,
    }),
  );
}

export function partnerActivationMfaContextIsEligible(input: {
  user: Pick<
    LockedActivationContext["user"],
    "active" | "identityStatus" | "securityVersion"
  >;
  transaction: Pick<
    LockedActivationContext["transaction"],
    "securityVersion" | "requestedIp" | "requestedUserAgent"
  >;
  currentBinding: {
    requestedIp: string | null;
    requestedUserAgent: string | null;
  };
}): boolean {
  const identityEligible =
    (input.user.identityStatus === "pending_activation" &&
      !input.user.active) ||
    (input.user.identityStatus === "active" && input.user.active);
  return (
    identityEligible &&
    input.user.securityVersion === input.transaction.securityVersion &&
    partnerAuthRequestBindingsMatch(
      {
        requestedIp: input.transaction.requestedIp,
        requestedUserAgent: input.transaction.requestedUserAgent,
      },
      input.currentBinding,
    )
  );
}

function contextIsEligible(
  context: LockedActivationContext,
  request: NextRequest,
): boolean {
  return partnerActivationMfaContextIsEligible({
    user: context.user,
    transaction: context.transaction,
    currentBinding: getPartnerAuthRequestBinding(request),
  });
}

export async function startPartnerActivationMfa(input: {
  transactionToken: string;
  request: NextRequest;
  correlationId: string;
  now?: Date;
}): Promise<StartPartnerActivationMfaResult> {
  const now = input.now ?? new Date();
  const digest = sha256Base64Url(input.transactionToken);
  return getDb().transaction(async (tx) => {
    const context = await loadLockedActivationContext(tx, digest);
    if (!context) return { kind: "invalid_transaction" } as const;
    if (context.transaction.expiresAt <= now) {
      await consumeInvalidTransaction(tx, context, now, {
        action: "partner.auth.activation_mfa.expired",
        correlationId: input.correlationId,
      });
      return { kind: "expired" } as const;
    }
    if (!contextIsEligible(context, input.request)) {
      await consumeInvalidTransaction(tx, context, now, {
        action: "partner.auth.activation_mfa.binding_denied",
        correlationId: input.correlationId,
      });
      return { kind: "invalid_transaction" } as const;
    }

    const [activeMethod] = await tx
      .select({
        id: partnerMfaMethods.id,
        totpSecretCiphertext: partnerMfaMethods.totpSecretCiphertext,
        totpSecretKeyVersion: partnerMfaMethods.totpSecretKeyVersion,
      })
      .from(partnerMfaMethods)
      .where(
        and(
          eq(partnerMfaMethods.partnerUserId, context.user.id),
          eq(partnerMfaMethods.methodType, "totp"),
          eq(partnerMfaMethods.enabled, true),
        ),
      )
      .for("update")
      .limit(1);
    if (
      activeMethod?.id &&
      activeMethod.totpSecretCiphertext &&
      activeMethod.totpSecretKeyVersion
    ) {
      await tx.insert(auditLogs).values(
        auditValues(context, {
          action: "partner.auth.activation_mfa.verification_requested",
          outcome: "attempted",
          correlationId: input.correlationId,
        }),
      );
      return {
        kind: "verification_required" as const,
        expiresAt: context.transaction.expiresAt,
      };
    }

    const [existing] = await tx
      .select()
      .from(partnerMfaEnrollmentChallenges)
      .where(
        and(
          eq(
            partnerMfaEnrollmentChallenges.authTransactionId,
            context.transaction.id,
          ),
          eq(partnerMfaEnrollmentChallenges.partnerUserId, context.user.id),
          isNull(partnerMfaEnrollmentChallenges.consumedAt),
          gt(partnerMfaEnrollmentChallenges.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (existing) {
      const secret = decryptPartnerTotpSecret({
        partnerUserId: context.user.id,
        ciphertext: existing.secretCiphertext,
        keyVersion: existing.secretKeyVersion,
      });
      return {
        kind: "enrollment" as const,
        challengeId: existing.id,
        secret,
        otpauthUri: createPartnerTotpUri({ email: context.user.email, secret }),
        expiresAt: existing.expiresAt,
      };
    }

    await tx
      .update(partnerMfaEnrollmentChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(partnerMfaEnrollmentChallenges.partnerUserId, context.user.id),
          isNull(partnerMfaEnrollmentChallenges.consumedAt),
        ),
      );
    const secret = generatePartnerTotpSecret();
    const encrypted = encryptPartnerTotpSecret({
      partnerUserId: context.user.id,
      secret,
    });
    const expiresAt = new Date(
      Math.min(
        context.transaction.expiresAt.getTime(),
        now.getTime() + ENROLLMENT_TTL_MS,
      ),
    );
    const challengeId = randomUUID();
    await tx.insert(partnerMfaEnrollmentChallenges).values({
      id: challengeId,
      partnerUserId: context.user.id,
      authTransactionId: context.transaction.id,
      secretCiphertext: encrypted.ciphertext,
      secretKeyVersion: encrypted.keyVersion,
      attemptCount: 0,
      expiresAt,
      createdAt: now,
    });
    await tx.insert(auditLogs).values(
      auditValues(context, {
        action: "partner.auth.activation_mfa.enrollment_started",
        outcome: "attempted",
        correlationId: input.correlationId,
        meta: { challengeId, expiresAt: expiresAt.toISOString() },
      }),
    );
    return {
      kind: "enrollment" as const,
      challengeId,
      secret,
      otpauthUri: createPartnerTotpUri({ email: context.user.email, secret }),
      expiresAt,
    };
  });
}

export async function completePartnerActivationMfa(input: {
  transactionToken: string;
  request: NextRequest;
  correlationId: string;
  challengeId?: string;
  code?: string;
  recoveryCode?: string;
  label?: string;
  now?: Date;
}): Promise<CompletePartnerActivationMfaResult> {
  const now = input.now ?? new Date();
  const digest = sha256Base64Url(input.transactionToken);
  return getDb().transaction(async (tx) => {
    const context = await loadLockedActivationContext(tx, digest);
    if (!context) return { kind: "invalid_transaction" } as const;
    if (context.transaction.expiresAt <= now) {
      await consumeInvalidTransaction(tx, context, now, {
        action: "partner.auth.activation_mfa.expired",
        correlationId: input.correlationId,
      });
      return { kind: "expired" } as const;
    }
    if (!contextIsEligible(context, input.request)) {
      await consumeInvalidTransaction(tx, context, now, {
        action: "partner.auth.activation_mfa.binding_denied",
        correlationId: input.correlationId,
      });
      return { kind: "invalid_transaction" } as const;
    }

    const [activeMethod] = await tx
      .select()
      .from(partnerMfaMethods)
      .where(
        and(
          eq(partnerMfaMethods.partnerUserId, context.user.id),
          eq(partnerMfaMethods.methodType, "totp"),
          eq(partnerMfaMethods.enabled, true),
        ),
      )
      .orderBy(desc(partnerMfaMethods.enrolledAt), desc(partnerMfaMethods.id))
      .for("update")
      .limit(1);

    let enrollment: typeof partnerMfaEnrollmentChallenges.$inferSelect | null =
      null;
    let acceptedCounter: number | null = null;
    let recoveryCodeId: string | null = null;
    let enrolled = false;
    let encryptedSecret: {
      ciphertext: string;
      keyVersion: number;
    } | null = null;

    if (
      activeMethod?.id &&
      activeMethod.totpSecretCiphertext &&
      activeMethod.totpSecretKeyVersion
    ) {
      if (input.code) {
        const secret = decryptPartnerTotpSecret({
          partnerUserId: context.user.id,
          ciphertext: activeMethod.totpSecretCiphertext,
          keyVersion: activeMethod.totpSecretKeyVersion,
        });
        acceptedCounter = verifyPartnerTotp({
          secret,
          code: input.code,
          at: now,
          lastAcceptedCounter: activeMethod.lastTotpCounter,
        });
      } else if (input.recoveryCode) {
        const candidates = await tx
          .select()
          .from(partnerMfaRecoveryCodes)
          .where(
            and(
              eq(partnerMfaRecoveryCodes.methodId, activeMethod.id),
              isNull(partnerMfaRecoveryCodes.usedAt),
            ),
          )
          .for("update");
        for (const candidate of candidates) {
          if (
            verifyPartnerMfaRecoveryCode({
              code: input.recoveryCode,
              expectedHash: candidate.codeHash,
              partnerUserId: context.user.id,
              methodId: activeMethod.id,
              keyVersion: candidate.keyVersion,
            })
          ) {
            recoveryCodeId = candidate.id;
          }
        }
      }
    } else {
      if (!input.challengeId || !input.code) {
        return { kind: "enrollment_required" } as const;
      }
      const [challenge] = await tx
        .select()
        .from(partnerMfaEnrollmentChallenges)
        .where(
          and(
            eq(partnerMfaEnrollmentChallenges.id, input.challengeId),
            eq(
              partnerMfaEnrollmentChallenges.authTransactionId,
              context.transaction.id,
            ),
            eq(partnerMfaEnrollmentChallenges.partnerUserId, context.user.id),
            isNull(partnerMfaEnrollmentChallenges.consumedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!challenge) return { kind: "enrollment_required" } as const;
      if (challenge.expiresAt <= now) {
        await consumeInvalidTransaction(tx, context, now, {
          action: "partner.auth.activation_mfa.enrollment_expired",
          correlationId: input.correlationId,
          meta: { challengeId: challenge.id },
        });
        return { kind: "expired" } as const;
      }
      enrollment = challenge;
      const secret = decryptPartnerTotpSecret({
        partnerUserId: context.user.id,
        ciphertext: challenge.secretCiphertext,
        keyVersion: challenge.secretKeyVersion,
      });
      acceptedCounter = verifyPartnerTotp({
        secret,
        code: input.code,
        at: now,
      });
      if (acceptedCounter !== null) {
        enrolled = true;
        encryptedSecret = {
          ciphertext: challenge.secretCiphertext,
          keyVersion: challenge.secretKeyVersion,
        };
      }
    }

    if (acceptedCounter === null && !recoveryCodeId) {
      const nextAttempts = Math.min(
        PARTNER_PASSWORD_MFA_MAX_ATTEMPTS,
        context.transaction.attemptCount + 1,
      );
      const attemptsRemaining = Math.max(
        0,
        PARTNER_PASSWORD_MFA_MAX_ATTEMPTS - nextAttempts,
      );
      await tx
        .update(partnerAuthTransactions)
        .set({
          attemptCount: nextAttempts,
          consumedAt: attemptsRemaining === 0 ? now : null,
        })
        .where(
          and(
            eq(partnerAuthTransactions.id, context.transaction.id),
            isNull(partnerAuthTransactions.consumedAt),
          ),
        );
      if (enrollment) {
        await tx
          .update(partnerMfaEnrollmentChallenges)
          .set({
            attemptCount: nextAttempts,
            consumedAt: attemptsRemaining === 0 ? now : null,
          })
          .where(eq(partnerMfaEnrollmentChallenges.id, enrollment.id));
      }
      await tx.insert(auditLogs).values(
        auditValues(context, {
          action: "partner.auth.activation_mfa.verification_denied",
          outcome: "denied",
          correlationId: input.correlationId,
          meta: {
            attemptsRemaining,
            mode: enrollment ? "enroll" : "verify",
            recoveryCodeAttempted: Boolean(input.recoveryCode),
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
          eq(partnerAuthTransactions.id, context.transaction.id),
          isNull(partnerAuthTransactions.consumedAt),
          gt(partnerAuthTransactions.expiresAt, now),
        ),
      )
      .returning({ id: partnerAuthTransactions.id });
    if (!consumedTransaction?.id) {
      return { kind: "invalid_transaction" } as const;
    }

    let methodId = activeMethod?.id ?? null;
    let recoveryCodes: string[] = [];
    const nextSecurityVersion =
      context.user.securityVersion + (enrolled ? 1 : 0);
    if (enrolled && enrollment && encryptedSecret) {
      await tx
        .update(partnerMfaMethods)
        .set({ enabled: false, disabledAt: now, updatedAt: now })
        .where(
          and(
            eq(partnerMfaMethods.partnerUserId, context.user.id),
            eq(partnerMfaMethods.enabled, true),
          ),
        );
      methodId = randomUUID();
      await tx.insert(partnerMfaMethods).values({
        id: methodId,
        partnerUserId: context.user.id,
        methodType: "totp",
        label: input.label?.trim().slice(0, 80) || "Authenticator app",
        totpSecretCiphertext: encryptedSecret.ciphertext,
        totpSecretKeyVersion: encryptedSecret.keyVersion,
        lastTotpCounter: acceptedCounter,
        enabled: true,
        enrolledAt: now,
        lastUsedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      recoveryCodes = generatePartnerMfaRecoveryCodes();
      await tx.insert(partnerMfaRecoveryCodes).values(
        recoveryCodes.map((code) => {
          const recoveryDigest = hashPartnerMfaRecoveryCode({
            code,
            partnerUserId: context.user.id,
            methodId: methodId!,
          });
          return {
            methodId: methodId!,
            codeHash: recoveryDigest.hash,
            keyVersion: recoveryDigest.keyVersion,
            createdAt: now,
          };
        }),
      );
    } else if (activeMethod?.id) {
      if (recoveryCodeId) {
        const [used] = await tx
          .update(partnerMfaRecoveryCodes)
          .set({ usedAt: now })
          .where(
            and(
              eq(partnerMfaRecoveryCodes.id, recoveryCodeId),
              isNull(partnerMfaRecoveryCodes.usedAt),
            ),
          )
          .returning({ id: partnerMfaRecoveryCodes.id });
        if (!used?.id) throw new Error("partner_recovery_code_changed");
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
        .where(eq(partnerMfaMethods.id, activeMethod.id));
    }
    if (!methodId) return { kind: "enrollment_required" } as const;

    const [userActivated] = await tx
      .update(partnerUsers)
      .set({
        active: true,
        identityStatus: "active",
        mfaRequired: true,
        mfaEnrolledAt: context.user.mfaEnrolledAt ?? now,
        securityVersion: nextSecurityVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerUsers.id, context.user.id),
          eq(partnerUsers.securityVersion, context.user.securityVersion),
          eq(partnerUsers.active, context.user.active),
          eq(partnerUsers.identityStatus, context.user.identityStatus),
        ),
      )
      .returning({ id: partnerUsers.id });
    const [membershipActivated] = context.recovery
      ? [{ id: context.membership.id }]
      : await tx
          .update(partnerAccountMemberships)
          .set({ status: "active", acceptedAt: now, updatedAt: now })
          .where(
            and(
              eq(partnerAccountMemberships.id, context.membership.id),
              eq(
                partnerAccountMemberships.partnerAccountId,
                context.account.id,
              ),
              eq(partnerAccountMemberships.partnerUserId, context.user.id),
              eq(partnerAccountMemberships.status, "invited"),
            ),
          )
          .returning({ id: partnerAccountMemberships.id });
    if (!userActivated?.id || !membershipActivated?.id) {
      throw new Error("partner_activation_mfa_state_changed");
    }

    if (enrollment) {
      await tx
        .update(partnerMfaEnrollmentChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(partnerMfaEnrollmentChallenges.id, enrollment.id),
            isNull(partnerMfaEnrollmentChallenges.consumedAt),
          ),
        );
    }
    if (enrolled) {
      await tx
        .update(partnerSessions)
        .set({ revokedAt: now, lastSeenAt: now })
        .where(
          and(
            eq(partnerSessions.partnerUserId, context.user.id),
            isNull(partnerSessions.revokedAt),
          ),
        );
    }
    const sessionId = randomUUID();
    const sessionToken = randomToken(32);
    const expiresAt = new Date(
      now.getTime() +
        (context.transaction.rememberMe
          ? REMEMBERED_SESSION_TTL_MS
          : STANDARD_SESSION_TTL_MS),
    );
    const requestBinding = getPartnerAuthRequestBinding(input.request);
    await tx.insert(partnerSessions).values({
      id: sessionId,
      partnerUserId: context.user.id,
      activePartnerAccountId: context.account.id,
      activeMembershipId: context.membership.id,
      sessionHash: sha256Base64Url(sessionToken),
      authMethod: "mfa_step_up",
      assuranceLevel: "aal2",
      mfaVerifiedAt: now,
      securityVersion: nextSecurityVersion,
      accountSelectedAt: now,
      ip: requestBinding.requestedIp,
      userAgent: requestBinding.requestedUserAgent,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
    });
    const [completed] = await tx
      .update(partnerAuthTransactions)
      .set({ completedSessionId: sessionId })
      .where(
        and(
          eq(partnerAuthTransactions.id, context.transaction.id),
          eq(partnerAuthTransactions.consumedAt, now),
        ),
      )
      .returning({ id: partnerAuthTransactions.id });
    if (!completed?.id) throw new Error("partner_activation_mfa_not_linked");
    await tx.insert(auditLogs).values(
      auditValues(context, {
        action: "partner.auth.account_activation.completed",
        outcome: "succeeded",
        correlationId: input.correlationId,
        sessionId,
        meta: {
          assuranceLevel: "aal2",
          enrolled,
          recoveryCodeUsed: Boolean(recoveryCodeId),
          recoveryCodeCount: recoveryCodes.length,
          identityActivated: !context.user.active,
          membershipActivated: !context.recovery,
          mfaRecovery: context.recovery,
        },
      }),
    );
    return {
      kind: "success" as const,
      sessionToken,
      expiresAt,
      recoveryCodes,
      recoveryCodeUsed: Boolean(recoveryCodeId),
      enrolled,
    };
  });
}
