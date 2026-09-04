import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerAuthTransactions,
  partnerLoginTokens,
  partnerRoleTemplates,
  partnerSessions,
  partnerUsers,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { normalizePhone } from "../../app/api/web/utils";
import { resolvePublicSiteBaseUrl as resolvePublicSiteBaseUrlInternal } from "@/lib/public-site-url";
import { isPartnerRoutineMagicLinkLoginEnabled } from "@/lib/partner-portal-feature-flags";
import { activePartnerSessionAuthMethod } from "@/lib/partner-session-auth-policy";
import {
  getPartnerDummyPasswordHash,
  hashPartnerPassword,
  PARTNER_PASSWORD_HASH_VERSION_ARGON2ID,
  verifyPartnerPassword,
} from "@/lib/partner-password-crypto";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const PARTNER_SESSION_LAST_SEEN_TOUCH_MS = 5 * 60 * 1000;
const PARTNER_STANDARD_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const PARTNER_REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

type InitialPartnerAccountBinding = {
  accountId: string;
  membershipId: string;
  roleKey: string;
  capabilityGrants: string[];
  capabilityDenies: string[];
  roleCapabilities: string[];
};

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

async function recoverRetiredActivationHandoff(
  tx: TeamMutationTransaction,
  input: {
    partnerUserId: string;
    email: string;
    identityStatus: string;
    active: boolean;
    securityVersion: number;
    correlationId: string;
    now: Date;
  },
): Promise<boolean> {
  const alreadyActive = input.active && input.identityStatus === "active";
  const awaitingActivation =
    !input.active && input.identityStatus === "pending_activation";
  if (!alreadyActive && !awaitingActivation) {
    return false;
  }

  const [handoff] = await tx
    .select({
      id: partnerAuthTransactions.id,
      partnerAccountId: partnerAuthTransactions.partnerAccountId,
      partnerMembershipId: partnerAuthTransactions.partnerMembershipId,
      securityVersion: partnerAuthTransactions.securityVersion,
    })
    .from(partnerAuthTransactions)
    .where(
      and(
        eq(partnerAuthTransactions.partnerUserId, input.partnerUserId),
        eq(partnerAuthTransactions.purpose, "activation_mfa_setup"),
        eq(partnerAuthTransactions.securityVersion, input.securityVersion),
        isNull(partnerAuthTransactions.consumedAt),
      ),
    )
    .for("update")
    .limit(1);
  if (!handoff) return alreadyActive;

  const [binding] = await tx
    .select({
      membershipId: partnerAccountMemberships.id,
      membershipStatus: partnerAccountMemberships.status,
      roleKey: partnerAccountMemberships.roleKey,
    })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
    )
    .where(
      and(
        eq(partnerAccountMemberships.id, handoff.partnerMembershipId),
        eq(
          partnerAccountMemberships.partnerAccountId,
          handoff.partnerAccountId,
        ),
        eq(partnerAccountMemberships.partnerUserId, input.partnerUserId),
        inArray(partnerAccountMemberships.status, ["invited", "active"]),
        inArray(partnerAccountMemberships.migrationReviewStatus, [
          "not_required",
          "approved",
        ]),
        eq(partnerAccounts.portalAccessEnabled, true),
        eq(partnerAccounts.portalLifecycleStatus, "active"),
      ),
    )
    .for("update")
    .limit(1);
  if (!binding) return alreadyActive;

  if (binding.membershipStatus === "invited") {
    const [membership] = await tx
      .update(partnerAccountMemberships)
      .set({
        status: "active",
        acceptedAt: input.now,
        suspendedAt: null,
        removedAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(partnerAccountMemberships.id, binding.membershipId),
          eq(partnerAccountMemberships.status, "invited"),
        ),
      )
      .returning({ id: partnerAccountMemberships.id });
    if (!membership) return false;
  }

  if (awaitingActivation) {
    const [identity] = await tx
      .update(partnerUsers)
      .set({
        active: true,
        identityStatus: "active",
        updatedAt: input.now,
      })
      .where(
        and(
          eq(partnerUsers.id, input.partnerUserId),
          eq(partnerUsers.active, false),
          eq(partnerUsers.identityStatus, "pending_activation"),
          eq(partnerUsers.securityVersion, input.securityVersion),
        ),
      )
      .returning({ id: partnerUsers.id });
    if (!identity) {
      throw new Error("retired_activation_identity_changed");
    }
  }

  const [consumed] = await tx
    .update(partnerAuthTransactions)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(partnerAuthTransactions.id, handoff.id),
        isNull(partnerAuthTransactions.consumedAt),
      ),
    )
    .returning({ id: partnerAuthTransactions.id });
  if (!consumed) throw new Error("retired_activation_handoff_changed");

  const auditId = crypto.randomUUID();
  await tx.insert(auditLogs).values({
    id: auditId,
    actorType: "human",
    actorId: input.partnerUserId,
    actorLabel: input.email,
    actorRole: binding.roleKey,
    sessionId: null,
    authMethod: "password",
    correlationId: input.correlationId,
    requiredPermissions: [],
    outcome: "succeeded",
    surface: "/partners/login",
    action: "partner.auth.retired_activation_handoff_recovered",
    entityType: "partner_user",
    entityId: input.partnerUserId,
    meta: sanitizeAuditMetadata({
      eventId: auditId,
      partnerAccountId: handoff.partnerAccountId,
      partnerMembershipId: binding.membershipId,
      retiredAuthTransactionId: handoff.id,
    }),
    createdAt: input.now,
  });
  return true;
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
      };
      session: {
        id: string;
        activePartnerAccountId: string | null;
        activeMembershipId: string | null;
        authMethod: "legacy" | "magic_link" | "password" | "passkey";
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

    // Password authentication is the production portal boundary. Retire every
    // historical session shape that may not have proved the user's password.
    // The dormant routine magic-link path is accepted only while its explicit
    // feature flag is on and receives read-only capabilities when the account
    // principal is materialized.
    const normalizedAuthMethod = activePartnerSessionAuthMethod(
      sessionHint.authMethod,
    );
    if (!normalizedAuthMethod) {
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
      },
      session: {
        id: sessionHint.id,
        activePartnerAccountId: sessionHint.activePartnerAccountId ?? null,
        activeMembershipId: sessionHint.activeMembershipId ?? null,
        authMethod: normalizedAuthMethod,
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

export type PartnerPasswordLoginResult = {
  kind: "authenticated";
  sessionToken: string;
  partnerUserId: string;
  orgContactId: string | null;
  expiresAt: Date;
};

export async function loginWithPassword(
  email: string,
  password: string,
  request: NextRequest,
  options: { rememberMe?: boolean; now?: Date } = {},
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
    !(
      (candidate.active && candidate.identityStatus === "active") ||
      (!candidate.active && candidate.identityStatus === "pending_activation")
    ) ||
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
    const now = options.now ?? new Date();
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
      })
      .from(partnerUsers)
      .where(eq(partnerUsers.id, candidate.id))
      .for("update")
      .limit(1);
    if (
      !userRow ||
      !(
        (userRow.active && userRow.identityStatus === "active") ||
        (!userRow.active && userRow.identityStatus === "pending_activation")
      ) ||
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
          updatedAt: now,
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

    const identityIsActive = await recoverRetiredActivationHandoff(tx, {
      partnerUserId: userRow.id,
      email: userRow.email,
      identityStatus: userRow.identityStatus,
      active: userRow.active,
      securityVersion: userRow.securityVersion,
      correlationId: resolvePartnerAuthCorrelationId(request),
      now,
    });
    if (!identityIsActive) return null;

    const accountBinding = await findInitialPartnerAccountBinding(
      tx,
      userRow.id,
    );
    if (!accountBinding) return null;

    // A verified password supersedes every retired pre-session handoff and
    // outstanding routine login link for this identity. This also cleans up
    // artifacts an older instance may have written during a rolling deploy.
    await tx
      .update(partnerAuthTransactions)
      .set({ consumedAt: now })
      .where(
        and(
          eq(partnerAuthTransactions.partnerUserId, userRow.id),
          isNull(partnerAuthTransactions.consumedAt),
        ),
      );
    await tx
      .update(partnerLoginTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(partnerLoginTokens.partnerUserId, userRow.id),
          isNull(partnerLoginTokens.usedAt),
        ),
      );
    await tx
      .update(partnerSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(partnerSessions.partnerUserId, userRow.id),
          inArray(partnerSessions.authMethod, [
            "legacy",
            "magic_link",
            "mfa_step_up",
          ]),
          isNull(partnerSessions.revokedAt),
        ),
      );

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
      expiresAt,
    };
  });
}
