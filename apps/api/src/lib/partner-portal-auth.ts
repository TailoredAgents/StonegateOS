import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerAuthTransactions,
  partnerLoginTokens,
  partnerMfaMethods,
  partnerRoleTemplates,
  partnerSessions,
  partnerUsers,
} from "@/db";
import { normalizePhone } from "../../app/api/web/utils";
import { resolvePublicSiteBaseUrl as resolvePublicSiteBaseUrlInternal } from "@/lib/public-site-url";
import { isPartnerRoutineMagicLinkLoginEnabled } from "@/lib/partner-portal-feature-flags";
import {
  getPartnerDummyPasswordHash,
  hashPartnerPassword,
  PARTNER_PASSWORD_HASH_VERSION_ARGON2ID,
  verifyPartnerPassword,
} from "@/lib/partner-password-crypto";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";

const PARTNER_SESSION_LAST_SEEN_TOUCH_MS = 5 * 60 * 1000;
export const PARTNER_PASSWORD_MFA_TRANSACTION_TTL_MS = 5 * 60 * 1_000;
export const PARTNER_PASSWORD_MFA_MAX_ATTEMPTS = 8;
const PARTNER_STANDARD_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const PARTNER_REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const PARTNER_MFA_REQUIRED_ROLES = new Set([
  "administrator",
  "billing_approver",
]);
const PARTNER_MFA_REQUIRED_CAPABILITIES = [
  "account.members.manage",
  "account.security.manage",
  "approvals.decide",
  "commercial.edit",
  "payments.initiate",
] as const;

type InitialPartnerAccountBinding = {
  accountId: string;
  membershipId: string;
  roleKey: string;
  capabilityGrants: string[];
  capabilityDenies: string[];
  roleCapabilities: string[];
};

function capabilityPatternMatches(pattern: string, required: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  return (
    normalized === "*" ||
    normalized === required ||
    (normalized.endsWith(".*") &&
      required.startsWith(`${normalized.slice(0, -2)}.`))
  );
}

export function partnerPasswordLoginRequiresMfa(input: {
  userMfaRequired: boolean;
  userMfaEnrolled: boolean;
  roleKey: string;
  roleCapabilities: readonly string[];
  capabilityGrants: readonly string[];
  capabilityDenies: readonly string[];
}): boolean {
  if (input.userMfaRequired || input.userMfaEnrolled) return true;
  if (PARTNER_MFA_REQUIRED_ROLES.has(input.roleKey.trim().toLowerCase())) {
    return true;
  }
  const denied = (capability: string) =>
    input.capabilityDenies.some((pattern) =>
      capabilityPatternMatches(pattern, capability),
    );
  return PARTNER_MFA_REQUIRED_CAPABILITIES.some(
    (capability) =>
      !denied(capability) &&
      [...input.roleCapabilities, ...input.capabilityGrants].some((pattern) =>
        capabilityPatternMatches(pattern, capability),
      ),
  );
}

async function findInitialPartnerAccountBinding(
  tx: TeamMutationTransaction,
  partnerUserId: string,
): Promise<InitialPartnerAccountBinding | null> {
  const [membership] = await tx
    .select({
      accountId: partnerAccountMemberships.partnerAccountId,
      membershipId: partnerAccountMemberships.id,
      roleKey: partnerAccountMemberships.roleKey,
      capabilityGrants: partnerAccountMemberships.capabilityGrants,
      capabilityDenies: partnerAccountMemberships.capabilityDenies,
      roleCapabilities: partnerRoleTemplates.capabilities,
      roleTemplateActive: partnerRoleTemplates.active,
    })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
    )
    .leftJoin(
      partnerRoleTemplates,
      eq(partnerAccountMemberships.roleTemplateId, partnerRoleTemplates.id),
    )
    .where(
      and(
        eq(partnerAccountMemberships.partnerUserId, partnerUserId),
        eq(partnerAccountMemberships.status, "active"),
        eq(partnerAccounts.portalAccessEnabled, true),
      ),
    )
    .orderBy(
      desc(partnerAccountMemberships.isDefault),
      asc(partnerAccountMemberships.createdAt),
      asc(partnerAccountMemberships.id),
    )
    .limit(1);

  return membership?.accountId && membership.membershipId
    ? {
        accountId: membership.accountId,
        membershipId: membership.membershipId,
        roleKey: membership.roleKey,
        capabilityGrants: membership.capabilityGrants ?? [],
        capabilityDenies: membership.capabilityDenies ?? [],
        roleCapabilities: membership.roleTemplateActive
          ? (membership.roleCapabilities ?? [])
          : [],
      }
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function normalizeEmail(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  return raw.toLowerCase();
}

export function normalizePhoneE164(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  try {
    return normalizePhone(raw).e164;
  } catch {
    // Keep authentication/onboarding available if the optional phone library
    // cannot load its metadata in a constrained runtime. This is intentionally
    // conservative and follows the launch assumption of US phone numbers while
    // retaining already-E.164 international input.
    if (!/^\+?[0-9().\-\s]+$/u.test(raw)) return null;
    const digits = raw.replace(/\D/gu, "");
    if (raw.startsWith("+") && /^\d{8,15}$/u.test(digits)) {
      return `+${digits}`;
    }
    if (/^\d{10}$/u.test(digits)) return `+1${digits}`;
    if (/^1\d{10}$/u.test(digits)) return `+${digits}`;
    return null;
  }
}

export function resolvePublicSiteBaseUrl(): string | null {
  return resolvePublicSiteBaseUrlInternal({ devFallbackLocalhost: true });
}

export function resolveRequestOriginBaseUrl(
  request: NextRequest,
): string | null {
  const origin = (request.headers.get("origin") ?? "").trim();
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const lowered = url.hostname.toLowerCase();
    if (
      lowered === "localhost" ||
      lowered === "127.0.0.1" ||
      lowered === "0.0.0.0" ||
      lowered === "::1"
    )
      return null;
    // Only allow http in development; otherwise require https.
    if (process.env["NODE_ENV"] !== "development" && url.protocol !== "https:")
      return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export async function replacePartnerLoginTokenInTransaction(
  tx: TeamMutationTransaction,
  input: {
    partnerUserId: string;
    requestedIp: string | null;
    userAgent: string | null;
    ttlMinutes?: number;
    now?: Date;
  },
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = randomToken(32);
  const now = input.now ?? new Date();
  const ttlMinutes = input.ttlMinutes ?? 30;
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  await tx
    .update(partnerLoginTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(partnerLoginTokens.partnerUserId, input.partnerUserId),
        isNull(partnerLoginTokens.usedAt),
      ),
    );
  await tx.insert(partnerLoginTokens).values({
    partnerUserId: input.partnerUserId,
    tokenHash: sha256Base64Url(rawToken),
    requestedIp: input.requestedIp,
    userAgent: input.userAgent,
    expiresAt,
    createdAt: now,
  });
  return { rawToken, expiresAt };
}

export function getClientIp(request: NextRequest): string | null {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip")?.trim() ??
    null
  );
}

export function getUserAgent(request: NextRequest): string | null {
  return request.headers.get("user-agent")?.trim() ?? null;
}

export function getPartnerAuthRequestBinding(request: NextRequest): {
  requestedIp: string | null;
  requestedUserAgent: string | null;
} {
  const ip = getClientIp(request)?.trim().toLowerCase() ?? null;
  const userAgent = getUserAgent(request)?.trim() ?? null;
  return {
    requestedIp: ip ? ip.slice(0, 128) : null,
    requestedUserAgent: userAgent ? userAgent.slice(0, 512) : null,
  };
}

export function resolvePartnerAuthCorrelationId(request: NextRequest): string {
  const candidate = request.headers.get("x-correlation-id")?.trim() ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

export async function findActivePartnerUserByEmail(email: string): Promise<{
  id: string;
  orgContactId: string | null;
  name: string;
  email: string;
  phoneE164: string | null;
  active: boolean;
  passwordHash: string | null;
} | null> {
  const db = getDb();
  const rows = await db
    .selectDistinct({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      name: partnerUsers.name,
      email: partnerUsers.email,
      phoneE164: partnerUsers.phoneE164,
      active: partnerUsers.active,
      passwordHash: partnerUsers.passwordHash,
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
        eq(partnerUsers.normalizedEmail, email),
        eq(partnerUsers.active, true),
        eq(partnerUsers.identityStatus, "active"),
      ),
    )
    .limit(2);

  const row = rows.length === 1 ? rows[0] : null;
  if (!row?.id || !row.active) return null;
  return {
    id: row.id,
    orgContactId: row.orgContactId,
    name: row.name,
    email: row.email,
    phoneE164: row.phoneE164 ?? null,
    active: row.active ?? true,
    passwordHash: row.passwordHash ?? null,
  };
}

export async function createPartnerLoginToken(
  partnerUserId: string,
  request: NextRequest,
  ttlMinutes = 30,
): Promise<{ rawToken: string; expiresAt: Date }> {
  if (!isPartnerRoutineMagicLinkLoginEnabled()) {
    throw new Error("partner_routine_magic_login_disabled");
  }
  const db = getDb();
  const now = new Date();

  return db.transaction(async (tx) => {
    const [eligible] = await tx
      .select({ id: partnerUsers.id })
      .from(partnerUsers)
      .where(
        and(
          eq(partnerUsers.id, partnerUserId),
          eq(partnerUsers.active, true),
          eq(partnerUsers.identityStatus, "active"),
        ),
      )
      .for("update")
      .limit(1);
    const accountBinding = eligible
      ? await findInitialPartnerAccountBinding(tx, eligible.id)
      : null;
    if (!eligible?.id || !accountBinding) {
      throw new Error("partner_portal_user_unavailable");
    }
    return replacePartnerLoginTokenInTransaction(tx, {
      partnerUserId,
      requestedIp: getClientIp(request),
      userAgent: getUserAgent(request),
      ttlMinutes,
      now,
    });
  });
}

export async function exchangePartnerLoginToken(
  rawToken: string,
  request: NextRequest,
  sessionDays = 30,
): Promise<{
  sessionToken: string;
  partnerUserId: string;
  orgContactId: string | null;
  needsPasswordSetup: boolean;
  expiresAt: Date;
} | null> {
  if (!isPartnerRoutineMagicLinkLoginEnabled()) return null;
  const db = getDb();
  const tokenHash = sha256Base64Url(rawToken);
  const now = new Date();

  return db.transaction(async (tx) => {
    const [tokenRow] = await tx
      .select({
        id: partnerLoginTokens.id,
        partnerUserId: partnerLoginTokens.partnerUserId,
      })
      .from(partnerLoginTokens)
      .where(
        and(
          eq(partnerLoginTokens.tokenHash, tokenHash),
          isNull(partnerLoginTokens.usedAt),
          gt(partnerLoginTokens.expiresAt, now),
        ),
      )
      .limit(1);
    if (!tokenRow?.id) return null;

    const [userRow] = await tx
      .select({
        id: partnerUsers.id,
        orgContactId: partnerUsers.orgContactId,
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        passwordHash: partnerUsers.passwordHash,
        securityVersion: partnerUsers.securityVersion,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, tokenRow.partnerUserId))
      .for("update")
      .limit(1);

    if (
      !userRow?.id ||
      !userRow.active ||
      userRow.identityStatus !== "active"
    ) {
      await tx
        .update(partnerLoginTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(partnerLoginTokens.id, tokenRow.id),
            isNull(partnerLoginTokens.usedAt),
          ),
        );
      return null;
    }

    const [consumed] = await tx
      .update(partnerLoginTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(partnerLoginTokens.id, tokenRow.id),
          isNull(partnerLoginTokens.usedAt),
        ),
      )
      .returning({ id: partnerLoginTokens.id });
    if (!consumed?.id) return null;

    const sessionToken = randomToken(32);
    const sessionHash = sha256Base64Url(sessionToken);
    const expiresAt = new Date(
      now.getTime() + sessionDays * 24 * 60 * 60 * 1000,
    );
    const accountBinding = await findInitialPartnerAccountBinding(
      tx,
      userRow.id,
    );
    if (!accountBinding) return null;
    await tx.insert(partnerSessions).values({
      partnerUserId: userRow.id,
      activePartnerAccountId: accountBinding.accountId,
      activeMembershipId: accountBinding.membershipId,
      sessionHash,
      authMethod: "magic_link",
      assuranceLevel: "aal1",
      securityVersion: userRow.securityVersion,
      accountSelectedAt: now,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
    });

    return {
      sessionToken,
      partnerUserId: userRow.id,
      orgContactId: userRow.orgContactId,
      needsPasswordSetup: !userRow.passwordHash,
      expiresAt,
    };
  });
}

export async function revokePartnerSession(
  sessionToken: string,
): Promise<void> {
  const db = getDb();
  const sessionHash = sha256Base64Url(sessionToken);
  await db
    .update(partnerSessions)
    .set({ revokedAt: new Date() })
    .where(eq(partnerSessions.sessionHash, sessionHash));
}

export async function requirePartnerSession(request: NextRequest): Promise<
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      partnerUser: {
        id: string;
        sessionId: string;
        orgContactId: string | null;
        email: string;
        name: string;
        passwordSet: boolean;
        mfaRequired: boolean;
        mfaEnrolledAt: Date | null;
      };
      session: {
        id: string;
        activePartnerAccountId: string | null;
        activeMembershipId: string | null;
        authMethod:
          | "legacy"
          | "magic_link"
          | "password"
          | "passkey"
          | "mfa_step_up";
        assuranceLevel: "aal1" | "aal2";
        mfaVerifiedAt: Date | null;
        securityVersion: number;
        deviceName: string | null;
        createdAt: Date;
        lastSeenAt: Date;
        expiresAt: Date;
      };
    }
> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : header.trim();
  if (!token) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const sessionHash = sha256Base64Url(token);
  const now = new Date();
  const db = getDb();
  return db.transaction(async (tx) => {
    const [sessionHint] = await tx
      .select({
        id: partnerSessions.id,
        partnerUserId: partnerSessions.partnerUserId,
        activePartnerAccountId: partnerSessions.activePartnerAccountId,
        activeMembershipId: partnerSessions.activeMembershipId,
        authMethod: partnerSessions.authMethod,
        assuranceLevel: partnerSessions.assuranceLevel,
        mfaVerifiedAt: partnerSessions.mfaVerifiedAt,
        securityVersion: partnerSessions.securityVersion,
        deviceName: partnerSessions.deviceName,
        createdAt: partnerSessions.createdAt,
        lastSeenAt: partnerSessions.lastSeenAt,
        expiresAt: partnerSessions.expiresAt,
        revokedAt: partnerSessions.revokedAt,
      })
      .from(partnerSessions)
      .where(eq(partnerSessions.sessionHash, sessionHash))
      .limit(1);

    if (!sessionHint?.id) {
      return { ok: false as const, status: 401, error: "unauthorized" };
    }
    if (sessionHint.revokedAt) {
      return { ok: false as const, status: 401, error: "session_revoked" };
    }
    if (sessionHint.expiresAt <= now) {
      return { ok: false as const, status: 401, error: "session_expired" };
    }

    // A session read must revalidate the user and organization, but it does not
    // need to lock the identity row. Security-version changes are checked again
    // against the session below before returning the principal.
    const [userRow] = await tx
      .select({
        id: partnerUsers.id,
        orgContactId: partnerUsers.orgContactId,
        email: partnerUsers.email,
        name: partnerUsers.name,
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        passwordHash: partnerUsers.passwordHash,
        mfaRequired: partnerUsers.mfaRequired,
        mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
        securityVersion: partnerUsers.securityVersion,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, sessionHint.partnerUserId))
      .limit(1);

    if (
      !userRow?.id ||
      !userRow.active ||
      userRow.identityStatus !== "active"
    ) {
      await tx
        .update(partnerSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(partnerSessions.id, sessionHint.id),
            isNull(partnerSessions.revokedAt),
          ),
        );
      return { ok: false as const, status: 401, error: "unauthorized" };
    }

    if (sessionHint.securityVersion !== userRow.securityVersion) {
      await tx
        .update(partnerSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(partnerSessions.id, sessionHint.id),
            isNull(partnerSessions.revokedAt),
          ),
        );
      return { ok: false as const, status: 401, error: "session_revoked" };
    }

    const sessionStillActive = and(
      eq(partnerSessions.id, sessionHint.id),
      eq(partnerSessions.sessionHash, sessionHash),
      eq(partnerSessions.securityVersion, userRow.securityVersion),
      isNull(partnerSessions.revokedAt),
      gt(partnerSessions.expiresAt, now),
    );
    const shouldTouchLastSeen =
      now.getTime() - sessionHint.lastSeenAt.getTime() >=
      PARTNER_SESSION_LAST_SEEN_TOUCH_MS;
    const [validatedSession] = shouldTouchLastSeen
      ? await tx
          .update(partnerSessions)
          .set({ lastSeenAt: now })
          .where(sessionStillActive)
          .returning({ id: partnerSessions.id })
      : await tx
          .select({ id: partnerSessions.id })
          .from(partnerSessions)
          .where(sessionStillActive)
          // Concurrent reads may share this lock, while revocation/security
          // mutations remain linearizable without forcing a last-seen write on
          // every portal request.
          .for("share")
          .limit(1);
    if (!validatedSession?.id) {
      return { ok: false as const, status: 401, error: "session_revoked" };
    }

    return {
      ok: true as const,
      partnerUser: {
        id: userRow.id,
        sessionId: sessionHint.id,
        orgContactId: userRow.orgContactId,
        email: userRow.email,
        name: userRow.name,
        passwordSet: Boolean(userRow.passwordHash),
        mfaRequired: userRow.mfaRequired,
        mfaEnrolledAt: userRow.mfaEnrolledAt ?? null,
      },
      session: {
        id: sessionHint.id,
        activePartnerAccountId: sessionHint.activePartnerAccountId ?? null,
        activeMembershipId: sessionHint.activeMembershipId ?? null,
        authMethod: sessionHint.authMethod,
        assuranceLevel: sessionHint.assuranceLevel,
        mfaVerifiedAt: sessionHint.mfaVerifiedAt ?? null,
        securityVersion: sessionHint.securityVersion,
        deviceName: sessionHint.deviceName ?? null,
        createdAt: sessionHint.createdAt,
        lastSeenAt: shouldTouchLastSeen ? now : sessionHint.lastSeenAt,
        expiresAt: sessionHint.expiresAt,
      },
    };
  });
}

export function hashPassword(password: string): Promise<string> {
  return hashPartnerPassword(password);
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  return (await verifyPartnerPassword(password, encoded)).valid;
}

export async function setPartnerPassword(
  partnerUserId: string,
  password: string,
): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [eligible] = await tx
      .select({ id: partnerUsers.id })
      .from(partnerUsers)
      .where(
        and(
          eq(partnerUsers.id, partnerUserId),
          eq(partnerUsers.active, true),
          eq(partnerUsers.identityStatus, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !eligible?.id ||
      !(await findInitialPartnerAccountBinding(tx, eligible.id))
    ) {
      return false;
    }
    const [updated] = await tx
      .update(partnerUsers)
      .set({
        passwordHash,
        passwordHashVersion: PARTNER_PASSWORD_HASH_VERSION_ARGON2ID,
        passwordSetAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(partnerUsers.id, partnerUserId), eq(partnerUsers.active, true)),
      )
      .returning({ id: partnerUsers.id });
    return Boolean(updated?.id);
  });
}

export type PartnerPasswordLoginResult =
  | {
      kind: "authenticated";
      sessionToken: string;
      partnerUserId: string;
      orgContactId: string | null;
      mfaRequired: false;
      expiresAt: Date;
    }
  | {
      kind: "mfa_required";
      transactionToken: string;
      expiresAt: Date;
      mfaRequired: true;
    }
  | {
      kind: "mfa_enrollment_required";
      mfaRequired: true;
    };

function passwordAuthAuditValues(input: {
  action: string;
  outcome: "succeeded" | "denied";
  partnerUserId: string;
  email: string;
  roleKey: string;
  correlationId: string;
  entityType: string;
  entityId: string;
  accountId: string;
  membershipId: string;
  meta?: Record<string, unknown>;
}) {
  const id = crypto.randomUUID();
  return {
    id,
    actorType: "human" as const,
    actorId: input.partnerUserId,
    actorLabel: input.email,
    actorRole: input.roleKey,
    sessionId: null,
    authMethod: "partner_pre_auth",
    correlationId: input.correlationId,
    requiredPermissions: [] as string[],
    outcome: input.outcome,
    surface: "/partners/login",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    meta: sanitizeAuditMetadata({
      eventId: id,
      correlationId: input.correlationId,
      partnerAccountId: input.accountId,
      partnerMembershipId: input.membershipId,
      ...input.meta,
    }),
  };
}

export async function loginWithPassword(
  email: string,
  password: string,
  request: NextRequest,
  options: { rememberMe?: boolean; now?: Date; correlationId?: string } = {},
): Promise<PartnerPasswordLoginResult | null> {
  const db = getDb();
  const [candidate] = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      email: partnerUsers.email,
      active: partnerUsers.active,
      identityStatus: partnerUsers.identityStatus,
      passwordHash: partnerUsers.passwordHash,
      passwordHashVersion: partnerUsers.passwordHashVersion,
      securityVersion: partnerUsers.securityVersion,
      mfaRequired: partnerUsers.mfaRequired,
      mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.normalizedEmail, email))
    .limit(1);
  const verification = await verifyPartnerPassword(
    password,
    candidate?.passwordHash ?? (await getPartnerDummyPasswordHash()),
  );
  if (
    !candidate?.id ||
    !candidate.active ||
    candidate.identityStatus !== "active" ||
    !candidate.passwordHash ||
    !verification.valid
  ) {
    return null;
  }
  const candidatePasswordHash = candidate.passwordHash;
  const replacementHash = verification.needsRehash
    ? await hashPartnerPassword(password)
    : null;

  return db.transaction(async (tx) => {
    const [userRow] = await tx
      .select({
        id: partnerUsers.id,
        orgContactId: partnerUsers.orgContactId,
        email: partnerUsers.email,
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        passwordHash: partnerUsers.passwordHash,
        passwordHashVersion: partnerUsers.passwordHashVersion,
        securityVersion: partnerUsers.securityVersion,
        mfaRequired: partnerUsers.mfaRequired,
        mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, candidate.id))
      .for("update")
      .limit(1);
    if (
      !userRow?.active ||
      userRow.identityStatus !== "active" ||
      userRow.passwordHash !== candidatePasswordHash ||
      userRow.securityVersion !== candidate.securityVersion
    ) {
      return null;
    }
    if (replacementHash) {
      const [rehashUpdated] = await tx
        .update(partnerUsers)
        .set({
          passwordHash: replacementHash,
          passwordHashVersion: PARTNER_PASSWORD_HASH_VERSION_ARGON2ID,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(partnerUsers.id, userRow.id),
            eq(partnerUsers.passwordHash, candidatePasswordHash),
            eq(partnerUsers.securityVersion, candidate.securityVersion),
          ),
        )
        .returning({ id: partnerUsers.id });
      if (!rehashUpdated) return null;
    }

    const accountBinding = await findInitialPartnerAccountBinding(
      tx,
      userRow.id,
    );
    if (!accountBinding) return null;

    const now = options.now ?? new Date();
    const correlationId =
      options.correlationId ?? resolvePartnerAuthCorrelationId(request);
    const [activeTotpMethod] = await tx
      .select({ id: partnerMfaMethods.id })
      .from(partnerMfaMethods)
      .where(
        and(
          eq(partnerMfaMethods.partnerUserId, userRow.id),
          eq(partnerMfaMethods.methodType, "totp"),
          eq(partnerMfaMethods.enabled, true),
        ),
      )
      .limit(1);
    const mfaRequired = partnerPasswordLoginRequiresMfa({
      userMfaRequired: userRow.mfaRequired,
      userMfaEnrolled:
        Boolean(userRow.mfaEnrolledAt) || Boolean(activeTotpMethod?.id),
      roleKey: accountBinding.roleKey,
      roleCapabilities: accountBinding.roleCapabilities,
      capabilityGrants: accountBinding.capabilityGrants,
      capabilityDenies: accountBinding.capabilityDenies,
    });
    if (mfaRequired && !activeTotpMethod?.id) {
      await tx.insert(auditLogs).values(
        passwordAuthAuditValues({
          action: "partner.auth.password_mfa_enrollment_required",
          outcome: "denied",
          partnerUserId: userRow.id,
          email: userRow.email,
          roleKey: accountBinding.roleKey,
          correlationId,
          entityType: "partner_user",
          entityId: userRow.id,
          accountId: accountBinding.accountId,
          membershipId: accountBinding.membershipId,
          meta: { reason: "active_totp_method_missing" },
        }),
      );
      return { kind: "mfa_enrollment_required", mfaRequired: true };
    }

    if (mfaRequired) {
      const transactionToken = randomToken(32);
      const transactionId = crypto.randomUUID();
      const expiresAt = new Date(
        now.getTime() + PARTNER_PASSWORD_MFA_TRANSACTION_TTL_MS,
      );
      const binding = getPartnerAuthRequestBinding(request);
      await tx
        .update(partnerAuthTransactions)
        .set({ consumedAt: now })
        .where(
          and(
            eq(partnerAuthTransactions.partnerUserId, userRow.id),
            isNull(partnerAuthTransactions.consumedAt),
          ),
        );
      await tx.insert(partnerAuthTransactions).values({
        id: transactionId,
        partnerUserId: userRow.id,
        partnerAccountId: accountBinding.accountId,
        partnerMembershipId: accountBinding.membershipId,
        tokenHash: sha256Base64Url(transactionToken),
        purpose: "password_login_mfa",
        securityVersion: userRow.securityVersion,
        rememberMe: options.rememberMe === true,
        requestedIp: binding.requestedIp,
        requestedUserAgent: binding.requestedUserAgent,
        attemptCount: 0,
        expiresAt,
        createdAt: now,
      });
      await tx.insert(auditLogs).values(
        passwordAuthAuditValues({
          action: "partner.auth.password_mfa_challenge_created",
          outcome: "succeeded",
          partnerUserId: userRow.id,
          email: userRow.email,
          roleKey: accountBinding.roleKey,
          correlationId,
          entityType: "partner_auth_transaction",
          entityId: transactionId,
          accountId: accountBinding.accountId,
          membershipId: accountBinding.membershipId,
          meta: {
            expiresAt: expiresAt.toISOString(),
            rememberMe: options.rememberMe === true,
          },
        }),
      );
      return {
        kind: "mfa_required",
        transactionToken,
        expiresAt,
        mfaRequired: true,
      };
    }

    const sessionToken = randomToken(32);
    const sessionHash = sha256Base64Url(sessionToken);
    const expiresAt = new Date(
      now.getTime() +
        (options.rememberMe
          ? PARTNER_REMEMBERED_SESSION_TTL_MS
          : PARTNER_STANDARD_SESSION_TTL_MS),
    );
    await tx.insert(partnerSessions).values({
      partnerUserId: userRow.id,
      activePartnerAccountId: accountBinding.accountId,
      activeMembershipId: accountBinding.membershipId,
      sessionHash,
      authMethod: "password",
      assuranceLevel: "aal1",
      securityVersion: userRow.securityVersion,
      accountSelectedAt: now,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
    });

    return {
      kind: "authenticated",
      sessionToken,
      partnerUserId: userRow.id,
      orgContactId: userRow.orgContactId,
      mfaRequired: false,
      expiresAt,
    };
  });
}
