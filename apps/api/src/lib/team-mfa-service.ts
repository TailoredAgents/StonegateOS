import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  teamMembers,
  teamMfaEnrollmentChallenges,
  teamMfaMethods,
  teamMfaRecoveryCodes,
  teamRoles,
  teamSessions,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  createTeamTotpUri,
  decryptTeamTotpSecret,
  encryptTeamTotpSecret,
  generateTeamMfaRecoveryCodes,
  generateTeamTotpSecret,
  hashTeamMfaRecoveryCode,
  verifyTeamMfaRecoveryCode,
  verifyTeamTotp,
} from "@/lib/team-mfa";

const ENROLLMENT_TTL_MS = 10 * 60 * 1_000;
const MAX_ENROLLMENT_ATTEMPTS = 8;
export const TEAM_MFA_RECENT_WINDOW_SECONDS = 15 * 60;

export type TeamMfaActor = {
  teamMemberId: string;
  email: string;
  roleSlug: string | null;
  sessionId: string;
  correlationId: string;
};

function auditValues(
  actor: TeamMfaActor,
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
    actorId: actor.teamMemberId,
    actorLabel: actor.email,
    actorRole: actor.roleSlug,
    sessionId: actor.sessionId,
    authMethod: "team_session",
    correlationId: actor.correlationId,
    requiredPermissions: ["sessions.manage_self"],
    outcome: input.outcome ?? ("succeeded" as const),
    surface: "/team/settings",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    meta: sanitizeAuditMetadata({
      eventId: auditId,
      correlationId: actor.correlationId,
      ...input.meta,
    }),
  };
}

function isRecentMfaAt(
  assuranceLevel: "aal1" | "aal2",
  verifiedAt: Date | null,
  now: Date,
): boolean {
  if (assuranceLevel !== "aal2" || !verifiedAt) return false;
  const age = now.getTime() - verifiedAt.getTime();
  return age >= -60_000 && age <= TEAM_MFA_RECENT_WINDOW_SECONDS * 1_000;
}

export async function getTeamMfaStatus(input: {
  teamMemberId: string;
  sessionId: string;
  now?: Date;
}): Promise<{
  required: boolean;
  enrolled: boolean;
  assuranceLevel: "aal1" | "aal2";
  recentlyVerified: boolean;
  mfaVerifiedAt: string | null;
  recentVerificationExpiresAt: string | null;
  methods: Array<{
    id: string;
    type: "totp";
    label: string | null;
    enrolledAt: string;
    lastUsedAt: string | null;
    recoveryCodesRemaining: number;
  }>;
}> {
  const db = getDb();
  const now = input.now ?? new Date();
  const [member] = await db
    .select({
      active: teamMembers.active,
      mfaRequired: teamMembers.mfaRequired,
      roleSlug: teamRoles.slug,
    })
    .from(teamMembers)
    .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
    .where(eq(teamMembers.id, input.teamMemberId))
    .limit(1);
  const [session] = await db
    .select({
      assuranceLevel: teamSessions.assuranceLevel,
      mfaVerifiedAt: teamSessions.mfaVerifiedAt,
    })
    .from(teamSessions)
    .where(
      and(
        eq(teamSessions.id, input.sessionId),
        eq(teamSessions.teamMemberId, input.teamMemberId),
        isNull(teamSessions.revokedAt),
        gt(teamSessions.expiresAt, now),
      ),
    )
    .limit(1);
  if (!member?.active || !session) throw new Error("team_mfa_user_unavailable");

  const methods = await db
    .select({
      id: teamMfaMethods.id,
      type: teamMfaMethods.methodType,
      label: teamMfaMethods.label,
      enrolledAt: teamMfaMethods.enrolledAt,
      lastUsedAt: teamMfaMethods.lastUsedAt,
    })
    .from(teamMfaMethods)
    .where(
      and(
        eq(teamMfaMethods.teamMemberId, input.teamMemberId),
        eq(teamMfaMethods.enabled, true),
      ),
    )
    .orderBy(desc(teamMfaMethods.enrolledAt), desc(teamMfaMethods.id));
  const counts = await Promise.all(
    methods.map(async (method) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(teamMfaRecoveryCodes)
        .where(
          and(
            eq(teamMfaRecoveryCodes.methodId, method.id),
            isNull(teamMfaRecoveryCodes.usedAt),
          ),
        );
      return [method.id, row?.count ?? 0] as const;
    }),
  );
  const countByMethod = new Map(counts);
  const recentlyVerified = isRecentMfaAt(
    session.assuranceLevel,
    session.mfaVerifiedAt,
    now,
  );
  return {
    required:
      member.mfaRequired || member.roleSlug?.trim().toLowerCase() === "owner",
    enrolled: methods.length > 0,
    assuranceLevel: session.assuranceLevel,
    recentlyVerified,
    mfaVerifiedAt: session.mfaVerifiedAt?.toISOString() ?? null,
    recentVerificationExpiresAt: session.mfaVerifiedAt
      ? new Date(
          session.mfaVerifiedAt.getTime() +
            TEAM_MFA_RECENT_WINDOW_SECONDS * 1_000,
        ).toISOString()
      : null,
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

export type StartTeamTotpEnrollmentResult =
  | {
      kind: "success";
      challengeId: string;
      secret: string;
      otpauthUri: string;
      expiresAt: Date;
    }
  | { kind: "recent_mfa_required" }
  | { kind: "session_unavailable" };

export async function startTeamTotpEnrollment(input: {
  actor: TeamMfaActor;
  now?: Date;
}): Promise<StartTeamTotpEnrollmentResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  const secret = generateTeamTotpSecret();
  const encrypted = encryptTeamTotpSecret({
    teamMemberId: input.actor.teamMemberId,
    secret,
  });
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
  const challengeId = randomUUID();
  return db.transaction(async (tx) => {
    const [member] = await tx
      .select({ id: teamMembers.id, active: teamMembers.active })
      .from(teamMembers)
      .where(eq(teamMembers.id, input.actor.teamMemberId))
      .for("update")
      .limit(1);
    const [session] = await tx
      .select({
        id: teamSessions.id,
        authMethod: teamSessions.authMethod,
        assuranceLevel: teamSessions.assuranceLevel,
        mfaVerifiedAt: teamSessions.mfaVerifiedAt,
      })
      .from(teamSessions)
      .where(
        and(
          eq(teamSessions.id, input.actor.sessionId),
          eq(teamSessions.teamMemberId, input.actor.teamMemberId),
          isNull(teamSessions.revokedAt),
          gt(teamSessions.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !member?.id ||
      !member.active ||
      session?.authMethod !== "team_session"
    ) {
      return { kind: "session_unavailable" } as const;
    }
    const [activeMethod] = await tx
      .select({ id: teamMfaMethods.id })
      .from(teamMfaMethods)
      .where(
        and(
          eq(teamMfaMethods.teamMemberId, member.id),
          eq(teamMfaMethods.enabled, true),
        ),
      )
      .limit(1);
    if (
      activeMethod &&
      !isRecentMfaAt(session.assuranceLevel, session.mfaVerifiedAt, now)
    ) {
      return { kind: "recent_mfa_required" } as const;
    }
    await tx
      .update(teamMfaEnrollmentChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(
            teamMfaEnrollmentChallenges.teamMemberId,
            input.actor.teamMemberId,
          ),
          isNull(teamMfaEnrollmentChallenges.consumedAt),
        ),
      );
    await tx.insert(teamMfaEnrollmentChallenges).values({
      id: challengeId,
      teamMemberId: input.actor.teamMemberId,
      secretCiphertext: encrypted.ciphertext,
      secretKeyVersion: encrypted.keyVersion,
      expiresAt,
      createdAt: now,
    });
    await tx.insert(auditLogs).values(
      auditValues(input.actor, {
        action: "team.mfa.enrollment_started",
        entityType: "team_mfa_enrollment_challenge",
        entityId: challengeId,
        meta: {
          expiresAt: expiresAt.toISOString(),
          replacing: Boolean(activeMethod),
        },
      }),
    );
    return {
      kind: "success",
      challengeId,
      secret,
      otpauthUri: createTeamTotpUri({
        email: input.actor.email,
        secret,
      }),
      expiresAt,
    } as const;
  });
}

export type ConfirmTeamTotpEnrollmentResult =
  | {
      kind: "success";
      methodId: string;
      recoveryCodes: string[];
      verifiedAt: Date;
    }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "invalid_code" }
  | { kind: "session_unavailable" };

export async function confirmTeamTotpEnrollment(input: {
  actor: TeamMfaActor;
  challengeId: string;
  code: string;
  label?: string | null;
  now?: Date;
}): Promise<ConfirmTeamTotpEnrollmentResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [member] = await tx
      .select({ id: teamMembers.id, active: teamMembers.active })
      .from(teamMembers)
      .where(eq(teamMembers.id, input.actor.teamMemberId))
      .for("update")
      .limit(1);
    if (!member?.id || !member.active) return { kind: "not_found" } as const;
    const [challenge] = await tx
      .select()
      .from(teamMfaEnrollmentChallenges)
      .where(
        and(
          eq(teamMfaEnrollmentChallenges.id, input.challengeId),
          eq(teamMfaEnrollmentChallenges.teamMemberId, member.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!challenge || challenge.consumedAt)
      return { kind: "not_found" } as const;
    if (challenge.expiresAt <= now) {
      await tx
        .update(teamMfaEnrollmentChallenges)
        .set({ consumedAt: now })
        .where(eq(teamMfaEnrollmentChallenges.id, challenge.id));
      return { kind: "expired" } as const;
    }
    const secret = decryptTeamTotpSecret({
      teamMemberId: member.id,
      ciphertext: challenge.secretCiphertext,
      keyVersion: challenge.secretKeyVersion,
    });
    const acceptedCounter = verifyTeamTotp({
      secret,
      code: input.code,
      at: now,
    });
    if (acceptedCounter === null) {
      const attemptCount = Math.min(
        MAX_ENROLLMENT_ATTEMPTS,
        challenge.attemptCount + 1,
      );
      await tx
        .update(teamMfaEnrollmentChallenges)
        .set({
          attemptCount,
          consumedAt: attemptCount >= MAX_ENROLLMENT_ATTEMPTS ? now : null,
        })
        .where(eq(teamMfaEnrollmentChallenges.id, challenge.id));
      return { kind: "invalid_code" } as const;
    }
    const [session] = await tx
      .select({ id: teamSessions.id, authMethod: teamSessions.authMethod })
      .from(teamSessions)
      .where(
        and(
          eq(teamSessions.id, input.actor.sessionId),
          eq(teamSessions.teamMemberId, member.id),
          isNull(teamSessions.revokedAt),
          gt(teamSessions.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!session?.id || session.authMethod !== "team_session") {
      return { kind: "session_unavailable" } as const;
    }
    await tx
      .update(teamMfaMethods)
      .set({ enabled: false, disabledAt: now, updatedAt: now })
      .where(
        and(
          eq(teamMfaMethods.teamMemberId, member.id),
          eq(teamMfaMethods.enabled, true),
        ),
      );
    const methodId = randomUUID();
    await tx.insert(teamMfaMethods).values({
      id: methodId,
      teamMemberId: member.id,
      methodType: "totp",
      label: input.label?.trim() || "Authenticator app",
      totpSecretCiphertext: challenge.secretCiphertext,
      totpSecretKeyVersion: challenge.secretKeyVersion,
      lastTotpCounter: acceptedCounter,
      enrolledAt: now,
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const recoveryCodes = generateTeamMfaRecoveryCodes();
    await tx.insert(teamMfaRecoveryCodes).values(
      recoveryCodes.map((code) => {
        const digest = hashTeamMfaRecoveryCode({
          code,
          teamMemberId: member.id,
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
    await tx
      .update(teamMembers)
      .set({ mfaRequired: true, mfaEnrolledAt: now, updatedAt: now })
      .where(eq(teamMembers.id, member.id));
    await tx
      .update(teamSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(teamSessions.teamMemberId, member.id),
          ne(teamSessions.id, session.id),
          isNull(teamSessions.revokedAt),
        ),
      );
    const [upgraded] = await tx
      .update(teamSessions)
      .set({
        assuranceLevel: "aal2",
        mfaVerifiedAt: now,
        lastSeenAt: now,
      })
      .where(
        and(
          eq(teamSessions.id, session.id),
          isNull(teamSessions.revokedAt),
          gt(teamSessions.expiresAt, now),
        ),
      )
      .returning({ id: teamSessions.id });
    if (!upgraded?.id) return { kind: "session_unavailable" } as const;
    await tx
      .update(teamMfaEnrollmentChallenges)
      .set({ consumedAt: now })
      .where(eq(teamMfaEnrollmentChallenges.id, challenge.id));
    await tx.insert(auditLogs).values(
      auditValues(input.actor, {
        action: "team.mfa.enrollment_confirmed",
        entityType: "team_mfa_method",
        entityId: methodId,
        meta: {
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

export type TeamMfaStepUpResult =
  | {
      kind: "success";
      methodId: string;
      recoveryCodeUsed: boolean;
      verifiedAt: Date;
    }
  | { kind: "not_enrolled" }
  | { kind: "invalid_code" }
  | { kind: "session_unavailable" };

export async function stepUpTeamMfa(input: {
  actor: TeamMfaActor;
  code?: string;
  recoveryCode?: string;
  now?: Date;
}): Promise<TeamMfaStepUpResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [member] = await tx
      .select({ id: teamMembers.id, active: teamMembers.active })
      .from(teamMembers)
      .where(eq(teamMembers.id, input.actor.teamMemberId))
      .for("update")
      .limit(1);
    if (!member?.id || !member.active) return { kind: "not_enrolled" } as const;
    const [session] = await tx
      .select({ id: teamSessions.id, authMethod: teamSessions.authMethod })
      .from(teamSessions)
      .where(
        and(
          eq(teamSessions.id, input.actor.sessionId),
          eq(teamSessions.teamMemberId, member.id),
          isNull(teamSessions.revokedAt),
          gt(teamSessions.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!session?.id || session.authMethod !== "team_session") {
      return { kind: "session_unavailable" } as const;
    }
    const [method] = await tx
      .select()
      .from(teamMfaMethods)
      .where(
        and(
          eq(teamMfaMethods.teamMemberId, member.id),
          eq(teamMfaMethods.methodType, "totp"),
          eq(teamMfaMethods.enabled, true),
        ),
      )
      .orderBy(desc(teamMfaMethods.enrolledAt), desc(teamMfaMethods.id))
      .for("update")
      .limit(1);
    if (!method?.id) return { kind: "not_enrolled" } as const;

    let recoveryCodeId: string | null = null;
    let acceptedCounter: number | null = null;
    if (input.code) {
      const secret = decryptTeamTotpSecret({
        teamMemberId: member.id,
        ciphertext: method.totpSecretCiphertext,
        keyVersion: method.totpSecretKeyVersion,
      });
      acceptedCounter = verifyTeamTotp({
        secret,
        code: input.code,
        at: now,
        lastAcceptedCounter: method.lastTotpCounter,
      });
      if (acceptedCounter === null) return { kind: "invalid_code" } as const;
    } else if (input.recoveryCode) {
      const candidates = await tx
        .select()
        .from(teamMfaRecoveryCodes)
        .where(
          and(
            eq(teamMfaRecoveryCodes.methodId, method.id),
            isNull(teamMfaRecoveryCodes.usedAt),
          ),
        )
        .for("update");
      for (const candidate of candidates) {
        if (
          verifyTeamMfaRecoveryCode({
            code: input.recoveryCode,
            expectedHash: candidate.codeHash,
            teamMemberId: member.id,
            methodId: method.id,
            keyVersion: candidate.keyVersion,
          })
        ) {
          recoveryCodeId = candidate.id;
        }
      }
      if (!recoveryCodeId) return { kind: "invalid_code" } as const;
      const [consumed] = await tx
        .update(teamMfaRecoveryCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(teamMfaRecoveryCodes.id, recoveryCodeId),
            isNull(teamMfaRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: teamMfaRecoveryCodes.id });
      if (!consumed?.id) return { kind: "invalid_code" } as const;
    } else {
      return { kind: "invalid_code" } as const;
    }

    await tx
      .update(teamMfaMethods)
      .set({
        lastUsedAt: now,
        ...(acceptedCounter === null
          ? {}
          : { lastTotpCounter: acceptedCounter }),
        updatedAt: now,
      })
      .where(eq(teamMfaMethods.id, method.id));
    const [upgraded] = await tx
      .update(teamSessions)
      .set({ assuranceLevel: "aal2", mfaVerifiedAt: now, lastSeenAt: now })
      .where(
        and(
          eq(teamSessions.id, session.id),
          isNull(teamSessions.revokedAt),
          gt(teamSessions.expiresAt, now),
        ),
      )
      .returning({ id: teamSessions.id });
    if (!upgraded?.id) return { kind: "session_unavailable" } as const;
    await tx.insert(auditLogs).values(
      auditValues(input.actor, {
        action: "team.mfa.step_up_completed",
        entityType: "team_session",
        entityId: session.id,
        meta: { recoveryCodeUsed: Boolean(recoveryCodeId) },
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

export type RevokeTeamMfaResult =
  | { kind: "success"; revokedSessionCount: number }
  | { kind: "not_enrolled" }
  | { kind: "recent_mfa_required" }
  | { kind: "session_unavailable" };

export async function revokeTeamMfa(input: {
  actor: TeamMfaActor;
  now?: Date;
}): Promise<RevokeTeamMfaResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [member] = await tx
      .select({ id: teamMembers.id, active: teamMembers.active })
      .from(teamMembers)
      .where(eq(teamMembers.id, input.actor.teamMemberId))
      .for("update")
      .limit(1);
    const [session] = await tx
      .select({
        id: teamSessions.id,
        authMethod: teamSessions.authMethod,
        assuranceLevel: teamSessions.assuranceLevel,
        mfaVerifiedAt: teamSessions.mfaVerifiedAt,
      })
      .from(teamSessions)
      .where(
        and(
          eq(teamSessions.id, input.actor.sessionId),
          eq(teamSessions.teamMemberId, input.actor.teamMemberId),
          isNull(teamSessions.revokedAt),
          gt(teamSessions.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !member?.id ||
      !member.active ||
      session?.authMethod !== "team_session"
    ) {
      return { kind: "session_unavailable" } as const;
    }
    if (!isRecentMfaAt(session.assuranceLevel, session.mfaVerifiedAt, now)) {
      return { kind: "recent_mfa_required" } as const;
    }
    const methods = await tx
      .select({ id: teamMfaMethods.id })
      .from(teamMfaMethods)
      .where(
        and(
          eq(teamMfaMethods.teamMemberId, member.id),
          eq(teamMfaMethods.enabled, true),
        ),
      )
      .for("update");
    if (!methods.length) return { kind: "not_enrolled" } as const;
    await tx
      .update(teamMfaMethods)
      .set({ enabled: false, disabledAt: now, updatedAt: now })
      .where(
        and(
          eq(teamMfaMethods.teamMemberId, member.id),
          eq(teamMfaMethods.enabled, true),
        ),
      );
    await tx
      .update(teamMfaRecoveryCodes)
      .set({ usedAt: now })
      .where(
        and(
          sql`${teamMfaRecoveryCodes.methodId} IN (${sql.join(
            methods.map((method) => sql`${method.id}`),
            sql`, `,
          )})`,
          isNull(teamMfaRecoveryCodes.usedAt),
        ),
      );
    await tx
      .update(teamMfaEnrollmentChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(teamMfaEnrollmentChallenges.teamMemberId, member.id),
          isNull(teamMfaEnrollmentChallenges.consumedAt),
        ),
      );
    await tx
      .update(teamMembers)
      .set({ mfaEnrolledAt: null, updatedAt: now })
      .where(eq(teamMembers.id, member.id));
    const revoked = await tx
      .update(teamSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(teamSessions.teamMemberId, member.id),
          ne(teamSessions.id, session.id),
          isNull(teamSessions.revokedAt),
        ),
      )
      .returning({ id: teamSessions.id });
    await tx
      .update(teamSessions)
      .set({ assuranceLevel: "aal1", mfaVerifiedAt: null, lastSeenAt: now })
      .where(eq(teamSessions.id, session.id));
    await tx.insert(auditLogs).values(
      auditValues(input.actor, {
        action: "team.mfa.revoked",
        entityType: "team_member",
        entityId: member.id,
        meta: { revokedSessionCount: revoked.length },
      }),
    );
    return { kind: "success", revokedSessionCount: revoked.length } as const;
  });
}
