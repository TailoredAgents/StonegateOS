import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import {
  auditLogs,
  getDb,
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

const ENROLLMENT_TTL_MS = 10 * 60 * 1_000;
const MAX_ENROLLMENT_ATTEMPTS = 8;

type MfaAuditActor = {
  partnerUserId: string;
  email: string;
  roleKey: string;
  sessionId: string;
  accountId: string | null;
  membershipId: string | null;
  correlationId: string;
};

function auditValues(
  actor: MfaAuditActor,
  input: {
    action: string;
    outcome?: "succeeded" | "denied";
    entityType: string;
    entityId: string;
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
    outcome: input.outcome ?? ("succeeded" as const),
    surface: "/partners/security",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    meta: sanitizeAuditMetadata({
      eventId: auditId,
      correlationId: actor.correlationId,
      partnerAccountId: actor.accountId,
      partnerMembershipId: actor.membershipId,
      ...input.meta,
    }),
  };
}

export async function getPartnerMfaStatus(partnerUserId: string): Promise<{
  enrolled: boolean;
  methods: Array<{
    id: string;
    type: "totp" | "webauthn";
    label: string | null;
    enrolledAt: string;
    lastUsedAt: string | null;
    recoveryCodesRemaining: number;
  }>;
}> {
  const db = getDb();
  const methods = await db
    .select({
      id: partnerMfaMethods.id,
      type: partnerMfaMethods.methodType,
      label: partnerMfaMethods.label,
      enrolledAt: partnerMfaMethods.enrolledAt,
      lastUsedAt: partnerMfaMethods.lastUsedAt,
    })
    .from(partnerMfaMethods)
    .where(
      and(
        eq(partnerMfaMethods.partnerUserId, partnerUserId),
        eq(partnerMfaMethods.enabled, true),
      ),
    )
    .orderBy(desc(partnerMfaMethods.enrolledAt), desc(partnerMfaMethods.id));
  if (!methods.length) return { enrolled: false, methods: [] };
  const counts = await Promise.all(
    methods.map(async (method) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(partnerMfaRecoveryCodes)
        .where(
          and(
            eq(partnerMfaRecoveryCodes.methodId, method.id),
            isNull(partnerMfaRecoveryCodes.usedAt),
          ),
        );
      return [method.id, row?.count ?? 0] as const;
    }),
  );
  const countByMethod = new Map(counts);
  return {
    enrolled: true,
    methods: methods.map((method) => ({
      id: method.id,
      type: method.type,
      label: method.label,
      enrolledAt: method.enrolledAt.toISOString(),
      lastUsedAt: method.lastUsedAt?.toISOString() ?? null,
      recoveryCodesRemaining: countByMethod.get(method.id) ?? 0,
    })),
  };
}

export async function startPartnerTotpEnrollment(input: {
  actor: MfaAuditActor;
  now?: Date;
}): Promise<{
  challengeId: string;
  secret: string;
  otpauthUri: string;
  expiresAt: Date;
}> {
  const db = getDb();
  const now = input.now ?? new Date();
  const secret = generatePartnerTotpSecret();
  const encrypted = encryptPartnerTotpSecret({
    partnerUserId: input.actor.partnerUserId,
    secret,
  });
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
  const challengeId = randomUUID();
  await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: partnerUsers.id, active: partnerUsers.active })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, input.actor.partnerUserId))
      .for("update")
      .limit(1);
    if (!user?.id || !user.active)
      throw new Error("partner_mfa_user_unavailable");
    await tx
      .update(partnerMfaEnrollmentChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(
            partnerMfaEnrollmentChallenges.partnerUserId,
            input.actor.partnerUserId,
          ),
          isNull(partnerMfaEnrollmentChallenges.consumedAt),
        ),
      );
    await tx.insert(partnerMfaEnrollmentChallenges).values({
      id: challengeId,
      partnerUserId: input.actor.partnerUserId,
      secretCiphertext: encrypted.ciphertext,
      secretKeyVersion: encrypted.keyVersion,
      attemptCount: 0,
      expiresAt,
      createdAt: now,
    });
    await tx.insert(auditLogs).values(
      auditValues(input.actor, {
        action: "partner.mfa.enrollment_started",
        entityType: "partner_mfa_enrollment_challenge",
        entityId: challengeId,
        meta: { expiresAt: expiresAt.toISOString(), methodType: "totp" },
      }),
    );
  });
  return {
    challengeId,
    secret,
    otpauthUri: createPartnerTotpUri({
      email: input.actor.email,
      secret,
    }),
    expiresAt,
  };
}

export type ConfirmPartnerTotpEnrollmentResult =
  | {
      kind: "success";
      methodId: string;
      recoveryCodes: string[];
      verifiedAt: Date;
    }
  | { kind: "not_found" | "expired" | "invalid_code" | "session_unavailable" };

export async function confirmPartnerTotpEnrollment(input: {
  actor: MfaAuditActor;
  challengeId: string;
  code: string;
  label?: string | null;
  now?: Date;
}): Promise<ConfirmPartnerTotpEnrollmentResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({
        id: partnerUsers.id,
        active: partnerUsers.active,
        securityVersion: partnerUsers.securityVersion,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, input.actor.partnerUserId))
      .for("update")
      .limit(1);
    if (!user?.id || !user.active) return { kind: "not_found" } as const;
    const [challenge] = await tx
      .select()
      .from(partnerMfaEnrollmentChallenges)
      .where(
        and(
          eq(partnerMfaEnrollmentChallenges.id, input.challengeId),
          eq(
            partnerMfaEnrollmentChallenges.partnerUserId,
            input.actor.partnerUserId,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (!challenge || challenge.consumedAt)
      return { kind: "not_found" } as const;
    if (challenge.expiresAt <= now) {
      await tx
        .update(partnerMfaEnrollmentChallenges)
        .set({ consumedAt: now })
        .where(eq(partnerMfaEnrollmentChallenges.id, challenge.id));
      return { kind: "expired" } as const;
    }
    const secret = decryptPartnerTotpSecret({
      partnerUserId: input.actor.partnerUserId,
      ciphertext: challenge.secretCiphertext,
      keyVersion: challenge.secretKeyVersion,
    });
    const acceptedCounter = verifyPartnerTotp({
      secret,
      code: input.code,
      at: now,
    });
    if (acceptedCounter === null) {
      const nextAttempts = Math.min(
        MAX_ENROLLMENT_ATTEMPTS,
        challenge.attemptCount + 1,
      );
      await tx
        .update(partnerMfaEnrollmentChallenges)
        .set({
          attemptCount: nextAttempts,
          consumedAt: nextAttempts >= MAX_ENROLLMENT_ATTEMPTS ? now : null,
        })
        .where(eq(partnerMfaEnrollmentChallenges.id, challenge.id));
      return { kind: "invalid_code" } as const;
    }

    const [currentSession] = await tx
      .select({ id: partnerSessions.id })
      .from(partnerSessions)
      .where(
        and(
          eq(partnerSessions.id, input.actor.sessionId),
          eq(partnerSessions.partnerUserId, input.actor.partnerUserId),
          isNull(partnerSessions.revokedAt),
          gt(partnerSessions.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!currentSession?.id) return { kind: "session_unavailable" } as const;

    await tx
      .update(partnerMfaMethods)
      .set({ enabled: false, disabledAt: now, updatedAt: now })
      .where(
        and(
          eq(partnerMfaMethods.partnerUserId, input.actor.partnerUserId),
          eq(partnerMfaMethods.enabled, true),
        ),
      );
    const methodId = randomUUID();
    await tx.insert(partnerMfaMethods).values({
      id: methodId,
      partnerUserId: input.actor.partnerUserId,
      methodType: "totp",
      label: input.label?.trim() || "Authenticator app",
      totpSecretCiphertext: challenge.secretCiphertext,
      totpSecretKeyVersion: challenge.secretKeyVersion,
      lastTotpCounter: acceptedCounter,
      enabled: true,
      enrolledAt: now,
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const recoveryCodes = generatePartnerMfaRecoveryCodes();
    await tx.insert(partnerMfaRecoveryCodes).values(
      recoveryCodes.map((code) => {
        const digest = hashPartnerMfaRecoveryCode({
          code,
          partnerUserId: input.actor.partnerUserId,
          methodId,
        });
        return {
          methodId,
          codeHash: digest.hash,
          keyVersion: digest.keyVersion,
          createdAt: now,
        };
      }),
    );
    const nextSecurityVersion = user.securityVersion + 1;
    await tx
      .update(partnerUsers)
      .set({
        mfaRequired: true,
        mfaEnrolledAt: now,
        securityVersion: nextSecurityVersion,
        updatedAt: now,
      })
      .where(eq(partnerUsers.id, user.id));
    await tx
      .update(partnerSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(partnerSessions.partnerUserId, user.id),
          ne(partnerSessions.id, currentSession.id),
          isNull(partnerSessions.revokedAt),
        ),
      );
    const [upgradedSession] = await tx
      .update(partnerSessions)
      .set({
        authMethod: "mfa_step_up",
        assuranceLevel: "aal2",
        mfaVerifiedAt: now,
        securityVersion: nextSecurityVersion,
        lastSeenAt: now,
      })
      .where(
        and(
          eq(partnerSessions.id, currentSession.id),
          isNull(partnerSessions.revokedAt),
          gt(partnerSessions.expiresAt, now),
        ),
      )
      .returning({ id: partnerSessions.id });
    if (!upgradedSession?.id) return { kind: "session_unavailable" } as const;
    await tx
      .update(partnerMfaEnrollmentChallenges)
      .set({ consumedAt: now })
      .where(eq(partnerMfaEnrollmentChallenges.id, challenge.id));
    await tx.insert(auditLogs).values(
      auditValues(input.actor, {
        action: "partner.mfa.enrollment_confirmed",
        entityType: "partner_mfa_method",
        entityId: methodId,
        meta: {
          methodType: "totp",
          otherSessionsRevoked: true,
          recoveryCodeCount: recoveryCodes.length,
        },
      }),
    );
    return {
      kind: "success",
      methodId,
      recoveryCodes,
      verifiedAt: now,
    } as const;
  });
}

export type PartnerMfaStepUpResult =
  | {
      kind: "success";
      methodId: string;
      recoveryCodeUsed: boolean;
      verifiedAt: Date;
    }
  | { kind: "not_enrolled" | "invalid_code" | "session_unavailable" };

export async function stepUpPartnerMfa(input: {
  actor: MfaAuditActor;
  code?: string;
  recoveryCode?: string;
  now?: Date;
}): Promise<PartnerMfaStepUpResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: partnerUsers.id, active: partnerUsers.active })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, input.actor.partnerUserId))
      .for("update")
      .limit(1);
    if (!user?.id || !user.active) return { kind: "not_enrolled" } as const;
    const [currentSession] = await tx
      .select({ id: partnerSessions.id })
      .from(partnerSessions)
      .where(
        and(
          eq(partnerSessions.id, input.actor.sessionId),
          eq(partnerSessions.partnerUserId, user.id),
          isNull(partnerSessions.revokedAt),
          gt(partnerSessions.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!currentSession?.id) {
      return { kind: "session_unavailable" } as const;
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
      return { kind: "not_enrolled" } as const;
    }

    let recoveryCodeId: string | null = null;
    let acceptedCounter: number | null = null;
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
      if (acceptedCounter === null) return { kind: "invalid_code" } as const;
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
      if (!recoveryCodeId) return { kind: "invalid_code" } as const;
      const [consumed] = await tx
        .update(partnerMfaRecoveryCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(partnerMfaRecoveryCodes.id, recoveryCodeId),
            isNull(partnerMfaRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: partnerMfaRecoveryCodes.id });
      if (!consumed?.id) return { kind: "invalid_code" } as const;
    } else {
      return { kind: "invalid_code" } as const;
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
    const [session] = await tx
      .update(partnerSessions)
      .set({
        authMethod: "mfa_step_up",
        assuranceLevel: "aal2",
        mfaVerifiedAt: now,
        lastSeenAt: now,
      })
      .where(
        and(
          eq(partnerSessions.id, currentSession.id),
          eq(partnerSessions.partnerUserId, user.id),
          isNull(partnerSessions.revokedAt),
          gt(partnerSessions.expiresAt, now),
        ),
      )
      .returning({ id: partnerSessions.id });
    if (!session?.id) return { kind: "session_unavailable" } as const;
    await tx.insert(auditLogs).values(
      auditValues(input.actor, {
        action: "partner.mfa.step_up_completed",
        entityType: "partner_session",
        entityId: session.id,
        meta: { methodType: "totp", recoveryCodeUsed: Boolean(recoveryCodeId) },
      }),
    );
    return {
      kind: "success",
      methodId: method.id,
      recoveryCodeUsed: Boolean(recoveryCodeId),
      verifiedAt: now,
    } as const;
  });
}
