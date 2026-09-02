import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  outboxEvents,
  partnerAccessApplications,
  partnerAccountMemberships,
  partnerAccounts,
  partnerApplicantSessions,
  partnerAuthChallenges,
  partnerAuthTransactions,
  partnerLoginTokens,
  partnerMfaMethods,
  partnerSessions,
  partnerUsers,
  type PartnerAuthChallengePurpose,
} from "@/db";
import {
  getClientIp,
  getPartnerAuthRequestBinding,
  getUserAgent,
  normalizeEmail,
  randomToken,
  resolvePublicSiteBaseUrl,
  sha256Base64Url,
} from "@/lib/partner-portal-auth";
import {
  hashPartnerPassword,
  PARTNER_PASSWORD_HASH_VERSION_ARGON2ID,
  verifyPartnerPassword,
} from "@/lib/partner-password-crypto";
import {
  PARTNER_PASSWORD_MAX_LENGTH,
  PARTNER_PASSWORD_MIN_LENGTH,
} from "@/lib/partner-password-management";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const EMAIL_VERIFICATION_TTL_MS = 30 * 60 * 1_000;
const ACCOUNT_ACTIVATION_TTL_MS = 24 * 60 * 60 * 1_000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1_000;
const EMAIL_CHANGE_TTL_MS = 30 * 60 * 1_000;
const APPLICANT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const STANDARD_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ACTIVATION_MFA_TRANSACTION_TTL_MS = 10 * 60 * 1_000;

class PartnerPurposeMutationUnavailable extends Error {}

export type PartnerApplicantPrincipal = {
  sessionId: string;
  verificationChallengeId: string;
  normalizedEmail: string;
  applicationId: string | null;
  draftPayload: Record<string, unknown>;
  draftVersion: number;
  expiresAt: Date;
  updatedAt: Date;
};

type ChallengeSubject = {
  partnerUserId?: string | null;
  partnerAccountId?: string | null;
  partnerMembershipId?: string | null;
  applicationId?: string | null;
  securityVersionSnapshot?: number | null;
};

function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function emailFingerprint(value: string): string {
  return createHash("sha256")
    .update("partner-auth-email\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function purposeTtlMs(purpose: PartnerAuthChallengePurpose): number {
  if (purpose === "account_activation") return ACCOUNT_ACTIVATION_TTL_MS;
  if (purpose === "password_reset") return PASSWORD_RESET_TTL_MS;
  if (purpose === "email_change") return EMAIL_CHANGE_TTL_MS;
  return EMAIL_VERIFICATION_TTL_MS;
}

function purposeUrl(
  purpose: PartnerAuthChallengePurpose,
  rawToken: string,
): string | null {
  const base = resolvePublicSiteBaseUrl();
  if (!base) return null;
  const pathname =
    purpose === "email_verification"
      ? "/partners/verify"
      : purpose === "account_activation"
        ? "/partners/activate"
        : purpose === "password_reset"
          ? "/partners/reset-password"
          : "/partners/confirm-email";
  const url = new URL(pathname, base);
  url.searchParams.set("token", rawToken);
  return url.toString();
}

function challengeAuditValues(input: {
  action: string;
  outcome?: "attempted" | "succeeded" | "denied" | "failed";
  challengeId: string | null;
  purpose: PartnerAuthChallengePurpose;
  normalizedEmail: string;
  correlationId: string;
  partnerUserId?: string | null;
  meta?: Record<string, unknown>;
}) {
  return {
    id: randomUUID(),
    actorType: "system" as const,
    actorId: input.partnerUserId ?? null,
    actorLabel: "partner-purpose-auth",
    authMethod: "service",
    correlationId: input.correlationId,
    outcome: input.outcome ?? ("succeeded" as const),
    surface: "partner_portal_v2",
    action: input.action,
    entityType: "partner_auth_challenge",
    entityId: input.challengeId,
    meta: {
      purpose: input.purpose,
      emailHash: emailFingerprint(input.normalizedEmail),
      ...(input.meta ?? {}),
    },
  };
}

export async function createPartnerPurposeChallengeInTransaction(
  tx: TeamMutationTransaction,
  input: {
    purpose: PartnerAuthChallengePurpose;
    normalizedEmail: string;
    correlationId: string;
    request?: NextRequest | null;
    subject?: ChallengeSubject;
    now?: Date;
  },
): Promise<{
  challengeId: string;
  rawToken: string;
  expiresAt: Date;
  generation: number;
}> {
  const normalizedEmail = normalizeEmail(input.normalizedEmail);
  if (!normalizedEmail || normalizedEmail.length > 254) {
    throw new TypeError("partner_auth_email_invalid");
  }
  const activationMembershipId = input.subject?.partnerMembershipId ?? null;
  const activationAccountId = input.subject?.partnerAccountId ?? null;
  const emailChangeUserId = input.subject?.partnerUserId ?? null;
  const emailChangeMembershipId = input.subject?.partnerMembershipId ?? null;
  const emailChangeAccountId = input.subject?.partnerAccountId ?? null;
  const emailChangeSecurityVersion =
    input.subject?.securityVersionSnapshot ?? null;
  if (
    input.purpose === "account_activation" &&
    (!activationMembershipId || !activationAccountId)
  ) {
    throw new TypeError("partner_activation_subject_invalid");
  }
  if (
    input.purpose === "email_change" &&
    (!emailChangeUserId ||
      !emailChangeMembershipId ||
      !emailChangeAccountId ||
      !emailChangeSecurityVersion ||
      input.subject?.applicationId)
  ) {
    throw new TypeError("partner_email_change_subject_invalid");
  }
  const now = input.now ?? new Date();
  const challengeScope =
    input.purpose === "account_activation"
      ? and(
          eq(partnerAuthChallenges.purpose, "account_activation"),
          eq(
            partnerAuthChallenges.partnerMembershipId,
            activationMembershipId!,
          ),
          eq(partnerAuthChallenges.partnerAccountId, activationAccountId!),
        )
      : input.purpose === "email_change"
        ? and(
            eq(partnerAuthChallenges.purpose, "email_change"),
            eq(partnerAuthChallenges.partnerUserId, emailChangeUserId!),
          )
        : and(
            eq(partnerAuthChallenges.purpose, input.purpose),
            eq(partnerAuthChallenges.normalizedEmail, normalizedEmail),
          );
  const lockScope =
    input.purpose === "account_activation"
      ? `membership:${activationMembershipId}`
      : input.purpose === "email_change"
        ? `user:${emailChangeUserId}`
        : `email:${normalizedEmail}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`partner-auth:${input.purpose}:${lockScope}`}))`,
  );
  const [latest] = await tx
    .select({ generation: partnerAuthChallenges.generation })
    .from(partnerAuthChallenges)
    .where(challengeScope)
    .orderBy(desc(partnerAuthChallenges.generation))
    .limit(1);
  const generation = (latest?.generation ?? 0) + 1;
  await tx
    .update(partnerAuthChallenges)
    .set({
      status: "revoked",
      tokenHash: null,
      revokedAt: now,
      updatedAt: now,
    })
    .where(and(challengeScope, eq(partnerAuthChallenges.status, "pending")));

  const rawToken = randomBytes(32).toString("base64url");
  const deliveryUrl = purposeUrl(input.purpose, rawToken);
  if (!deliveryUrl) throw new Error("partner_auth_site_url_unavailable");
  const challengeId = randomUUID();
  const expiresAt = new Date(now.getTime() + purposeTtlMs(input.purpose));
  const [challenge] = await tx
    .insert(partnerAuthChallenges)
    .values({
      id: challengeId,
      purpose: input.purpose,
      status: "pending",
      normalizedEmail,
      tokenHash: tokenHash(rawToken),
      generation,
      partnerUserId: input.subject?.partnerUserId ?? null,
      partnerAccountId: input.subject?.partnerAccountId ?? null,
      partnerMembershipId: input.subject?.partnerMembershipId ?? null,
      applicationId: input.subject?.applicationId ?? null,
      securityVersionSnapshot: input.subject?.securityVersionSnapshot ?? null,
      requestedIp: input.request ? getClientIp(input.request) : null,
      requestedUserAgent: input.request ? getUserAgent(input.request) : null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: partnerAuthChallenges.id });
  if (!challenge) throw new Error("partner_auth_challenge_not_created");
  const [outbox] = await tx
    .insert(outboxEvents)
    .values({
      type: "partner.auth.email",
      payload: {
        challengeId,
        generation,
        purpose: input.purpose,
        deliveryUrl,
        correlationId: input.correlationId,
      },
      createdAt: now,
    })
    .returning({ id: outboxEvents.id });
  if (!outbox) throw new Error("partner_auth_outbox_not_created");
  const [linked] = await tx
    .update(partnerAuthChallenges)
    .set({ deliveryOutboxEventId: outbox.id, updatedAt: now })
    .where(
      and(
        eq(partnerAuthChallenges.id, challengeId),
        eq(partnerAuthChallenges.status, "pending"),
      ),
    )
    .returning({ id: partnerAuthChallenges.id });
  if (!linked) throw new Error("partner_auth_outbox_not_linked");
  await tx.insert(auditLogs).values(
    challengeAuditValues({
      action: `partner.auth.${input.purpose}.requested`,
      outcome: "attempted",
      challengeId,
      purpose: input.purpose,
      normalizedEmail,
      correlationId: input.correlationId,
      partnerUserId: input.subject?.partnerUserId,
      meta: { generation, expiresAt: expiresAt.toISOString() },
    }),
  );
  return { challengeId, rawToken, expiresAt, generation };
}

export async function requestPartnerEmailVerification(input: {
  email: string;
  request: NextRequest;
  correlationId: string;
}): Promise<void> {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) throw new TypeError("partner_auth_email_invalid");
  await getDb().transaction((tx) =>
    createPartnerPurposeChallengeInTransaction(tx, {
      purpose: "email_verification",
      normalizedEmail,
      correlationId: input.correlationId,
      request: input.request,
    }),
  );
}

export async function consumePartnerEmailVerification(input: {
  rawToken: string;
  request: NextRequest;
  correlationId: string;
}): Promise<
  | {
      kind: "success";
      sessionToken: string;
      sessionId: string;
      email: string;
      expiresAt: Date;
    }
  | { kind: "invalid" }
> {
  const digest = tokenHash(input.rawToken);
  const now = new Date();
  return getDb().transaction(async (tx) => {
    const [challenge] = await tx
      .select()
      .from(partnerAuthChallenges)
      .where(
        and(
          eq(partnerAuthChallenges.tokenHash, digest),
          eq(partnerAuthChallenges.purpose, "email_verification"),
          eq(partnerAuthChallenges.status, "pending"),
        ),
      )
      .for("update")
      .limit(1);
    if (!challenge) return { kind: "invalid" as const };
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
      return { kind: "invalid" as const };
    }

    const [activeApplication] = await tx
      .select({ id: partnerAccessApplications.id })
      .from(partnerAccessApplications)
      .where(
        and(
          eq(
            partnerAccessApplications.normalizedEmail,
            challenge.normalizedEmail,
          ),
          eq(partnerAccessApplications.flowVersion, 2),
          or(
            eq(partnerAccessApplications.status, "submitted"),
            eq(partnerAccessApplications.status, "under_review"),
            eq(partnerAccessApplications.status, "needs_information"),
          ),
        ),
      )
      .orderBy(desc(partnerAccessApplications.submittedAt))
      .limit(1);
    const [consumed] = await tx
      .update(partnerAuthChallenges)
      .set({
        status: "consumed",
        tokenHash: null,
        applicationId: activeApplication?.id ?? null,
        consumedIp: getClientIp(input.request),
        consumedUserAgent: getUserAgent(input.request),
        consumedAt: now,
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
    if (!consumed) return { kind: "invalid" as const };

    const sessionToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const expiresAt = new Date(now.getTime() + APPLICANT_SESSION_TTL_MS);
    await tx.insert(partnerApplicantSessions).values({
      id: sessionId,
      verificationChallengeId: challenge.id,
      normalizedEmail: challenge.normalizedEmail,
      sessionHash: tokenHash(sessionToken),
      applicationId: activeApplication?.id ?? null,
      ip: getClientIp(input.request),
      userAgent: getUserAgent(input.request),
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
      updatedAt: now,
    });
    await tx.insert(auditLogs).values(
      challengeAuditValues({
        action: "partner.auth.email_verification.consumed",
        challengeId: challenge.id,
        purpose: "email_verification",
        normalizedEmail: challenge.normalizedEmail,
        correlationId: input.correlationId,
        meta: {
          applicantSessionId: sessionId,
          applicationId: activeApplication?.id ?? null,
        },
      }),
    );
    return {
      kind: "success" as const,
      sessionToken,
      sessionId,
      email: challenge.normalizedEmail,
      expiresAt,
    };
  });
}

export async function requirePartnerApplicantSession(
  request: NextRequest,
): Promise<
  | { ok: true; principal: PartnerApplicantPrincipal }
  | { ok: false; status: 401; error: "unauthorized" | "session_expired" }
> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  const now = new Date();
  const [row] = await getDb()
    .select()
    .from(partnerApplicantSessions)
    .where(eq(partnerApplicantSessions.sessionHash, tokenHash(token)))
    .limit(1);
  if (!row || row.revokedAt) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  if (row.expiresAt <= now) {
    await getDb()
      .update(partnerApplicantSessions)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(partnerApplicantSessions.id, row.id),
          isNull(partnerApplicantSessions.revokedAt),
        ),
      );
    return { ok: false, status: 401, error: "session_expired" };
  }
  if (now.getTime() - row.lastSeenAt.getTime() >= 5 * 60 * 1_000) {
    await getDb()
      .update(partnerApplicantSessions)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(
        and(
          eq(partnerApplicantSessions.id, row.id),
          isNull(partnerApplicantSessions.revokedAt),
          gt(partnerApplicantSessions.expiresAt, now),
        ),
      );
  }
  return {
    ok: true,
    principal: {
      sessionId: row.id,
      verificationChallengeId: row.verificationChallengeId,
      normalizedEmail: row.normalizedEmail,
      applicationId: row.applicationId ?? null,
      draftPayload: row.draftPayload,
      draftVersion: row.draftVersion,
      expiresAt: row.expiresAt,
      updatedAt: row.updatedAt,
    },
  };
}

export async function createPartnerActivationChallengeInTransaction(
  tx: TeamMutationTransaction,
  input: {
    partnerUserId: string;
    partnerAccountId: string;
    partnerMembershipId: string;
    applicationId: string | null;
    normalizedEmail: string;
    securityVersion: number;
    correlationId: string;
    now?: Date;
  },
) {
  return createPartnerPurposeChallengeInTransaction(tx, {
    purpose: "account_activation",
    normalizedEmail: input.normalizedEmail,
    correlationId: input.correlationId,
    now: input.now,
    subject: {
      partnerUserId: input.partnerUserId,
      partnerAccountId: input.partnerAccountId,
      partnerMembershipId: input.partnerMembershipId,
      applicationId: input.applicationId,
      securityVersionSnapshot: input.securityVersion,
    },
  });
}

async function loadPendingActivationByToken(
  tx: TeamMutationTransaction,
  digest: string,
  lock: boolean,
) {
  const query = tx
    .select({
      challenge: partnerAuthChallenges,
      user: {
        id: partnerUsers.id,
        email: partnerUsers.email,
        normalizedEmail: partnerUsers.normalizedEmail,
        name: partnerUsers.name,
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        securityVersion: partnerUsers.securityVersion,
        mfaRequired: partnerUsers.mfaRequired,
        mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
        passwordHash: partnerUsers.passwordHash,
      },
      account: {
        id: partnerAccounts.id,
        name: partnerAccounts.name,
        portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      },
      membership: {
        id: partnerAccountMemberships.id,
        status: partnerAccountMemberships.status,
        roleKey: partnerAccountMemberships.roleKey,
      },
    })
    .from(partnerAuthChallenges)
    .innerJoin(
      partnerUsers,
      eq(partnerAuthChallenges.partnerUserId, partnerUsers.id),
    )
    .innerJoin(
      partnerAccounts,
      eq(partnerAuthChallenges.partnerAccountId, partnerAccounts.id),
    )
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
        eq(
          partnerAuthChallenges.partnerUserId,
          partnerAccountMemberships.partnerUserId,
        ),
      ),
    )
    .where(
      and(
        eq(partnerAuthChallenges.tokenHash, digest),
        eq(partnerAuthChallenges.purpose, "account_activation"),
        eq(partnerAuthChallenges.status, "pending"),
      ),
    )
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

export function partnerActivationStateKind(input: {
  user: {
    active: boolean;
    identityStatus: string;
    mfaRequired: boolean;
    mfaEnrolledAt: Date | null;
    passwordHash: string | null;
  };
  membershipStatus: string;
  hasEnabledMfaMethod: boolean;
}): "invitation" | "mfa_recovery" | null {
  const identityCanAcceptInvitation =
    (input.user.identityStatus === "pending_activation" &&
      !input.user.active) ||
    (input.user.identityStatus === "active" && input.user.active);
  if (input.membershipStatus === "invited" && identityCanAcceptInvitation) {
    return "invitation";
  }
  if (
    input.membershipStatus === "active" &&
    input.user.identityStatus === "active" &&
    input.user.active &&
    input.user.mfaRequired &&
    input.user.mfaEnrolledAt === null &&
    Boolean(input.user.passwordHash) &&
    !input.hasEnabledMfaMethod
  ) {
    return "mfa_recovery";
  }
  return null;
}

async function hasEnabledPartnerMfaMethod(
  tx: TeamMutationTransaction,
  partnerUserId: string,
  lock: boolean,
): Promise<boolean> {
  const query = tx
    .select({ id: partnerMfaMethods.id })
    .from(partnerMfaMethods)
    .where(
      and(
        eq(partnerMfaMethods.partnerUserId, partnerUserId),
        eq(partnerMfaMethods.enabled, true),
      ),
    )
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  return Boolean(rows[0]?.id);
}

export async function inspectPartnerActivationToken(rawToken: string): Promise<
  | {
      kind: "success";
      email: string;
      name: string;
      accountName: string;
      mfaRequired: boolean;
      passwordAlreadySet: boolean;
      expiresAt: Date;
    }
  | { kind: "invalid" }
> {
  const digest = tokenHash(rawToken);
  const now = new Date();
  return getDb().transaction(async (tx) => {
    const row = await loadPendingActivationByToken(tx, digest, false);
    if (!row) return { kind: "invalid" as const };
    const activationKind = partnerActivationStateKind({
      user: row.user,
      membershipStatus: row.membership.status,
      hasEnabledMfaMethod: await hasEnabledPartnerMfaMethod(
        tx,
        row.user.id,
        false,
      ),
    });
    const valid =
      row.challenge.expiresAt > now &&
      activationKind !== null &&
      row.user.normalizedEmail === row.challenge.normalizedEmail &&
      row.user.securityVersion === row.challenge.securityVersionSnapshot &&
      row.account.portalAccessEnabled;
    if (!valid) return { kind: "invalid" as const };
    return {
      kind: "success" as const,
      email: row.user.email,
      name: row.user.name,
      accountName: row.account.name,
      mfaRequired:
        row.user.mfaRequired ||
        ["administrator", "billing_approver"].includes(row.membership.roleKey),
      passwordAlreadySet: Boolean(row.user.passwordHash),
      expiresAt: row.challenge.expiresAt,
    };
  });
}

export async function completePartnerActivation(input: {
  rawToken: string;
  password: string;
  rememberMe: boolean;
  request: NextRequest;
  correlationId: string;
}): Promise<
  | {
      kind: "success";
      sessionToken: string;
      expiresAt: Date;
      mfaRequired: boolean;
    }
  | {
      kind: "mfa_setup_required";
      transactionToken: string;
      expiresAt: Date;
      setupMode: "enroll" | "verify";
      mfaRequired: true;
    }
  | { kind: "invalid" | "password_policy" | "unavailable" }
> {
  const digest = tokenHash(input.rawToken);
  const now = new Date();
  const preview = await getDb().transaction((tx) =>
    loadPendingActivationByToken(tx, digest, false),
  );
  if (!preview) return { kind: "invalid" as const };
  const previewActivationKind = await getDb().transaction(async (tx) =>
    partnerActivationStateKind({
      user: preview.user,
      membershipStatus: preview.membership.status,
      hasEnabledMfaMethod: await hasEnabledPartnerMfaMethod(
        tx,
        preview.user.id,
        false,
      ),
    }),
  );
  if (
    preview.challenge.expiresAt <= now ||
    previewActivationKind === null ||
    preview.user.normalizedEmail !== preview.challenge.normalizedEmail ||
    preview.user.securityVersion !==
      preview.challenge.securityVersionSnapshot ||
    !preview.account.portalAccessEnabled
  ) {
    return { kind: "invalid" as const };
  }
  if (
    !preview.user.passwordHash &&
    (input.password.length < PARTNER_PASSWORD_MIN_LENGTH ||
      input.password.length > PARTNER_PASSWORD_MAX_LENGTH)
  ) {
    return { kind: "password_policy" as const };
  }
  const existingPasswordVerification = preview.user.passwordHash
    ? await verifyPartnerPassword(input.password, preview.user.passwordHash)
    : null;
  if (existingPasswordVerification && !existingPasswordVerification.valid) {
    return { kind: "invalid" as const };
  }
  const shouldWritePasswordHash =
    !preview.user.passwordHash || existingPasswordVerification?.needsRehash;
  const preparedPasswordHash = shouldWritePasswordHash
    ? await hashPartnerPassword(input.password)
    : null;

  try {
    return await getDb().transaction(async (tx) => {
      const row = await loadPendingActivationByToken(tx, digest, true);
      if (!row) return { kind: "invalid" as const };
      const isPendingIdentity =
        row.user.identityStatus === "pending_activation" && !row.user.active;
      const isActiveIdentity =
        row.user.identityStatus === "active" && row.user.active;
      const activationKind = partnerActivationStateKind({
        user: row.user,
        membershipStatus: row.membership.status,
        hasEnabledMfaMethod: await hasEnabledPartnerMfaMethod(
          tx,
          row.user.id,
          true,
        ),
      });
      const isMfaRecovery = activationKind === "mfa_recovery";
      const valid =
        row.challenge.expiresAt > now &&
        activationKind !== null &&
        row.user.normalizedEmail === row.challenge.normalizedEmail &&
        row.user.securityVersion === row.challenge.securityVersionSnapshot &&
        row.user.passwordHash === preview.user.passwordHash &&
        row.account.portalAccessEnabled;
      if (!valid) return { kind: "invalid" as const };
      const settingPassword = isPendingIdentity || !row.user.passwordHash;
      const rehashingPassword =
        Boolean(row.user.passwordHash) &&
        existingPasswordVerification?.needsRehash === true;
      const mfaGateRequired =
        isMfaRecovery ||
        row.user.mfaRequired ||
        ["administrator", "billing_approver"].includes(row.membership.roleKey);
      const nextSecurityVersion =
        row.user.securityVersion + (settingPassword ? 1 : 0);
      let userUpdated = true;
      if (settingPassword || rehashingPassword || mfaGateRequired) {
        if ((settingPassword || rehashingPassword) && !preparedPasswordHash) {
          return { kind: "unavailable" as const };
        }
        const [user] = await tx
          .update(partnerUsers)
          .set({
            ...(settingPassword
              ? {
                  ...(mfaGateRequired
                    ? {}
                    : {
                        active: true,
                        identityStatus: "active" as const,
                      }),
                  emailVerifiedAt: now,
                  passwordSetAt: now,
                }
              : {}),
            ...(preparedPasswordHash
              ? {
                  passwordHash: preparedPasswordHash,
                  passwordHashVersion: PARTNER_PASSWORD_HASH_VERSION_ARGON2ID,
                }
              : {}),
            ...(mfaGateRequired ? { mfaRequired: true } : {}),
            securityVersion: nextSecurityVersion,
            updatedAt: now,
          })
          .where(
            and(
              eq(partnerUsers.id, row.user.id),
              eq(partnerUsers.active, row.user.active),
              eq(partnerUsers.identityStatus, row.user.identityStatus),
              eq(partnerUsers.securityVersion, row.user.securityVersion),
            ),
          )
          .returning({ id: partnerUsers.id });
        userUpdated = Boolean(user);
      }
      let membershipActivated = mfaGateRequired;
      if (!mfaGateRequired) {
        const [membership] = await tx
          .update(partnerAccountMemberships)
          .set({
            status: "active",
            acceptedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(partnerAccountMemberships.id, row.membership.id),
              eq(partnerAccountMemberships.partnerAccountId, row.account.id),
              eq(partnerAccountMemberships.partnerUserId, row.user.id),
              eq(partnerAccountMemberships.status, "invited"),
            ),
          )
          .returning({ id: partnerAccountMemberships.id });
        membershipActivated = Boolean(membership);
      }
      const [challenge] = await tx
        .update(partnerAuthChallenges)
        .set({
          status: "consumed",
          tokenHash: null,
          consumedIp: getClientIp(input.request),
          consumedUserAgent: getUserAgent(input.request),
          consumedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAuthChallenges.id, row.challenge.id),
            eq(partnerAuthChallenges.status, "pending"),
            eq(partnerAuthChallenges.tokenHash, digest),
          ),
        )
        .returning({ id: partnerAuthChallenges.id });
      if (!userUpdated || !membershipActivated || !challenge) {
        throw new PartnerPurposeMutationUnavailable(
          "partner_activation_state_changed",
        );
      }
      if (settingPassword) {
        await tx
          .update(partnerSessions)
          .set({ revokedAt: now, lastSeenAt: now })
          .where(
            and(
              eq(partnerSessions.partnerUserId, row.user.id),
              isNull(partnerSessions.revokedAt),
            ),
          );
      }
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
            eq(partnerAuthChallenges.purpose, "account_activation"),
            eq(partnerAuthChallenges.partnerMembershipId, row.membership.id),
            eq(partnerAuthChallenges.status, "pending"),
            ne(partnerAuthChallenges.id, row.challenge.id),
          ),
        );
      if (mfaGateRequired) {
        await tx
          .update(partnerAuthTransactions)
          .set({ consumedAt: now })
          .where(
            and(
              eq(partnerAuthTransactions.partnerUserId, row.user.id),
              isNull(partnerAuthTransactions.consumedAt),
            ),
          );
        const transactionToken = randomToken(32);
        const expiresAt = new Date(
          now.getTime() + ACTIVATION_MFA_TRANSACTION_TTL_MS,
        );
        const requestBinding = getPartnerAuthRequestBinding(input.request);
        const [activeTotp] = await tx
          .select({ id: partnerMfaMethods.id })
          .from(partnerMfaMethods)
          .where(
            and(
              eq(partnerMfaMethods.partnerUserId, row.user.id),
              eq(partnerMfaMethods.methodType, "totp"),
              eq(partnerMfaMethods.enabled, true),
            ),
          )
          .limit(1);
        const [transaction] = await tx
          .insert(partnerAuthTransactions)
          .values({
            partnerUserId: row.user.id,
            partnerAccountId: row.account.id,
            partnerMembershipId: row.membership.id,
            tokenHash: sha256Base64Url(transactionToken),
            purpose: "activation_mfa_setup",
            sourceAuthChallengeId: row.challenge.id,
            securityVersion: nextSecurityVersion,
            rememberMe: input.rememberMe,
            requestedIp: requestBinding.requestedIp,
            requestedUserAgent: requestBinding.requestedUserAgent,
            attemptCount: 0,
            expiresAt,
            createdAt: now,
          })
          .returning({ id: partnerAuthTransactions.id });
        if (!transaction?.id) {
          throw new PartnerPurposeMutationUnavailable(
            "partner_activation_mfa_transaction_not_created",
          );
        }
        await tx.insert(auditLogs).values(
          challengeAuditValues({
            action: "partner.auth.account_activation.mfa_setup_required",
            outcome: "attempted",
            challengeId: row.challenge.id,
            purpose: "account_activation",
            normalizedEmail: row.challenge.normalizedEmail,
            correlationId: input.correlationId,
            partnerUserId: row.user.id,
            meta: {
              partnerAccountId: row.account.id,
              partnerMembershipId: row.membership.id,
              authTransactionId: transaction.id,
              setupMode: activeTotp ? "verify" : "enroll",
              identityStillPending: isPendingIdentity,
              membershipStillInvited: row.membership.status === "invited",
              mfaRecovery: isMfaRecovery,
              passwordChanged: settingPassword,
              passwordRehashed: rehashingPassword,
              expiresAt: expiresAt.toISOString(),
            },
          }),
        );
        return {
          kind: "mfa_setup_required" as const,
          transactionToken,
          expiresAt,
          setupMode: activeTotp ? ("verify" as const) : ("enroll" as const),
          mfaRequired: true as const,
        };
      }
      const sessionToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(
        now.getTime() +
          (input.rememberMe
            ? REMEMBERED_SESSION_TTL_MS
            : STANDARD_SESSION_TTL_MS),
      );
      await tx.insert(partnerSessions).values({
        partnerUserId: row.user.id,
        activePartnerAccountId: row.account.id,
        activeMembershipId: row.membership.id,
        sessionHash: tokenHash(sessionToken),
        authMethod: "password",
        assuranceLevel: "aal1",
        securityVersion: nextSecurityVersion,
        accountSelectedAt: now,
        ip: getClientIp(input.request),
        userAgent: getUserAgent(input.request),
        expiresAt,
        createdAt: now,
        lastSeenAt: now,
      });
      await tx.insert(auditLogs).values(
        challengeAuditValues({
          action: "partner.auth.account_activation.completed",
          challengeId: row.challenge.id,
          purpose: "account_activation",
          normalizedEmail: row.challenge.normalizedEmail,
          correlationId: input.correlationId,
          partnerUserId: row.user.id,
          meta: {
            partnerAccountId: row.account.id,
            partnerMembershipId: row.membership.id,
            mfaRequired: row.user.mfaRequired,
            existingIdentity: isActiveIdentity,
            passwordChanged: settingPassword,
            passwordRehashed: rehashingPassword,
          },
        }),
      );
      return {
        kind: "success" as const,
        sessionToken,
        expiresAt,
        mfaRequired: row.user.mfaRequired,
      };
    });
  } catch (error) {
    if (error instanceof PartnerPurposeMutationUnavailable) {
      return { kind: "unavailable" as const };
    }
    throw error;
  }
}

async function loadCanonicalPasswordIdentityByEmail(
  tx: TeamMutationTransaction,
  normalizedEmail: string,
) {
  const rows = await tx
    .selectDistinct({
      id: partnerUsers.id,
      normalizedEmail: partnerUsers.normalizedEmail,
      active: partnerUsers.active,
      identityStatus: partnerUsers.identityStatus,
      securityVersion: partnerUsers.securityVersion,
    })
    .from(partnerUsers)
    .innerJoin(
      partnerAccountMemberships,
      and(
        eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
        eq(partnerAccountMemberships.status, "active"),
      ),
    )
    .innerJoin(
      partnerAccounts,
      and(
        eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
        eq(partnerAccounts.portalAccessEnabled, true),
      ),
    )
    .where(
      and(
        eq(partnerUsers.normalizedEmail, normalizedEmail),
        eq(partnerUsers.active, true),
        eq(partnerUsers.identityStatus, "active"),
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}

export async function requestPartnerPasswordReset(input: {
  email: string;
  request: NextRequest;
  correlationId: string;
}): Promise<void> {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) throw new TypeError("partner_auth_email_invalid");
  await getDb().transaction(async (tx) => {
    const identity = await loadCanonicalPasswordIdentityByEmail(
      tx,
      normalizedEmail,
    );
    if (!identity) return;
    await createPartnerPurposeChallengeInTransaction(tx, {
      purpose: "password_reset",
      normalizedEmail,
      request: input.request,
      correlationId: input.correlationId,
      subject: {
        partnerUserId: identity.id,
        securityVersionSnapshot: identity.securityVersion,
      },
    });
  });
}

export async function completePartnerPasswordReset(input: {
  rawToken: string;
  password: string;
  request: NextRequest;
  correlationId: string;
}): Promise<{ kind: "success" | "invalid" }> {
  const digest = tokenHash(input.rawToken);
  const passwordHash = await hashPartnerPassword(input.password);
  const now = new Date();
  try {
    return await getDb().transaction(async (tx) => {
      const [challenge] = await tx
        .select()
        .from(partnerAuthChallenges)
        .where(
          and(
            eq(partnerAuthChallenges.tokenHash, digest),
            eq(partnerAuthChallenges.purpose, "password_reset"),
            eq(partnerAuthChallenges.status, "pending"),
          ),
        )
        .for("update")
        .limit(1);
      if (!challenge?.partnerUserId || challenge.expiresAt <= now) {
        if (challenge) {
          await tx
            .update(partnerAuthChallenges)
            .set({
              status: "expired",
              tokenHash: null,
              expiredAt: now,
              updatedAt: now,
            })
            .where(eq(partnerAuthChallenges.id, challenge.id));
        }
        return { kind: "invalid" as const };
      }
      const [identity] = await tx
        .select({
          id: partnerUsers.id,
          active: partnerUsers.active,
          identityStatus: partnerUsers.identityStatus,
          normalizedEmail: partnerUsers.normalizedEmail,
          securityVersion: partnerUsers.securityVersion,
        })
        .from(partnerUsers)
        .where(eq(partnerUsers.id, challenge.partnerUserId))
        .for("update")
        .limit(1);
      if (
        !identity?.active ||
        identity.identityStatus !== "active" ||
        identity.normalizedEmail !== challenge.normalizedEmail ||
        identity.securityVersion !== challenge.securityVersionSnapshot
      ) {
        return { kind: "invalid" as const };
      }
      const nextSecurityVersion = identity.securityVersion + 1;
      const [updated] = await tx
        .update(partnerUsers)
        .set({
          passwordHash,
          passwordHashVersion: PARTNER_PASSWORD_HASH_VERSION_ARGON2ID,
          passwordSetAt: now,
          securityVersion: nextSecurityVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerUsers.id, identity.id),
            eq(partnerUsers.securityVersion, identity.securityVersion),
            eq(partnerUsers.active, true),
            eq(partnerUsers.identityStatus, "active"),
          ),
        )
        .returning({ id: partnerUsers.id });
      const [consumed] = await tx
        .update(partnerAuthChallenges)
        .set({
          status: "consumed",
          tokenHash: null,
          consumedIp: getClientIp(input.request),
          consumedUserAgent: getUserAgent(input.request),
          consumedAt: now,
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
      if (!updated || !consumed) {
        throw new PartnerPurposeMutationUnavailable(
          "partner_password_reset_state_changed",
        );
      }
      await tx
        .update(partnerSessions)
        .set({ revokedAt: now, lastSeenAt: now })
        .where(
          and(
            eq(partnerSessions.partnerUserId, identity.id),
            isNull(partnerSessions.revokedAt),
          ),
        );
      await tx
        .update(partnerLoginTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(partnerLoginTokens.partnerUserId, identity.id),
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
            eq(partnerAuthChallenges.partnerUserId, identity.id),
            eq(partnerAuthChallenges.status, "pending"),
            ne(partnerAuthChallenges.id, challenge.id),
          ),
        );
      await tx.insert(auditLogs).values(
        challengeAuditValues({
          action: "partner.auth.password_reset.completed",
          challengeId: challenge.id,
          purpose: "password_reset",
          normalizedEmail: challenge.normalizedEmail,
          correlationId: input.correlationId,
          partnerUserId: identity.id,
          meta: { sessionsRevoked: true },
        }),
      );
      return { kind: "success" as const };
    });
  } catch (error) {
    if (error instanceof PartnerPurposeMutationUnavailable) {
      return { kind: "invalid" as const };
    }
    throw error;
  }
}

export async function resendPartnerActivation(input: {
  email: string;
  request: NextRequest;
  correlationId: string;
}): Promise<void> {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) throw new TypeError("partner_auth_email_invalid");
  await getDb().transaction(async (tx) => {
    const rows = await tx
      .selectDistinct({
        userId: partnerUsers.id,
        userSecurityVersion: partnerUsers.securityVersion,
        accountId: partnerAccounts.id,
        membershipId: partnerAccountMemberships.id,
        applicationId: partnerAccessApplications.id,
      })
      .from(partnerUsers)
      .innerJoin(
        partnerAccountMemberships,
        and(
          eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
          eq(partnerAccountMemberships.status, "invited"),
        ),
      )
      .innerJoin(
        partnerAccounts,
        and(
          eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
          eq(partnerAccounts.portalAccessEnabled, true),
        ),
      )
      .leftJoin(
        partnerAccessApplications,
        and(
          eq(
            partnerAccessApplications.approvedPartnerAccountId,
            partnerAccounts.id,
          ),
          eq(partnerAccessApplications.applicantPartnerUserId, partnerUsers.id),
          eq(partnerAccessApplications.status, "approved"),
        ),
      )
      .where(
        and(
          eq(partnerUsers.normalizedEmail, normalizedEmail),
          or(
            and(
              eq(partnerUsers.active, false),
              eq(partnerUsers.identityStatus, "pending_activation"),
            ),
            and(
              eq(partnerUsers.active, true),
              eq(partnerUsers.identityStatus, "active"),
            ),
          ),
        ),
      )
      .limit(11);
    // One identity can have pending invitation activations in more than one
    // account. Reissue each account-bound challenge without revealing the
    // count; an anomalously large set is suppressed for staff reconciliation.
    if (rows.length === 0 || rows.length > 10) return;
    for (const row of rows) {
      await createPartnerPurposeChallengeInTransaction(tx, {
        purpose: "account_activation",
        normalizedEmail,
        request: input.request,
        correlationId: input.correlationId,
        subject: {
          partnerUserId: row.userId,
          partnerAccountId: row.accountId,
          partnerMembershipId: row.membershipId,
          applicationId: row.applicationId,
          securityVersionSnapshot: row.userSecurityVersion,
        },
      });
    }
  });
}
