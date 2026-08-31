import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import {
  contacts,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerLoginTokens,
  partnerSessions,
  partnerUsers,
} from "@/db";
import { normalizePhone } from "../../app/api/web/utils";
import { resolvePublicSiteBaseUrl as resolvePublicSiteBaseUrlInternal } from "@/lib/public-site-url";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const PARTNER_SESSION_LAST_SEEN_TOUCH_MS = 5 * 60 * 1000;

async function findInitialPartnerAccountBinding(
  tx: TeamMutationTransaction,
  partnerUserId: string,
): Promise<{ accountId: string; membershipId: string } | null> {
  const [membership] = await tx
    .select({
      accountId: partnerAccountMemberships.partnerAccountId,
      membershipId: partnerAccountMemberships.id,
    })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
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

export async function findActivePartnerUserByEmail(email: string): Promise<{
  id: string;
  orgContactId: string;
  name: string;
  email: string;
  phoneE164: string | null;
  active: boolean;
  passwordHash: string | null;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      name: partnerUsers.name,
      email: partnerUsers.email,
      phoneE164: partnerUsers.phoneE164,
      active: partnerUsers.active,
      passwordHash: partnerUsers.passwordHash,
    })
    .from(partnerUsers)
    .innerJoin(contacts, eq(partnerUsers.orgContactId, contacts.id))
    .where(
      and(
        eq(partnerUsers.email, email),
        eq(partnerUsers.active, true),
        eq(contacts.partnerStatus, "partner"),
        isNull(contacts.deletedAt),
      ),
    )
    .limit(1);

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

export async function findActivePartnerUserByPhone(phoneE164: string): Promise<{
  id: string;
  orgContactId: string;
  name: string;
  email: string;
  phoneE164: string | null;
  active: boolean;
  passwordHash: string | null;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      name: partnerUsers.name,
      email: partnerUsers.email,
      phoneE164: partnerUsers.phoneE164,
      active: partnerUsers.active,
      passwordHash: partnerUsers.passwordHash,
    })
    .from(partnerUsers)
    .innerJoin(contacts, eq(partnerUsers.orgContactId, contacts.id))
    .where(
      and(
        eq(partnerUsers.phoneE164, phoneE164),
        eq(partnerUsers.active, true),
        eq(contacts.partnerStatus, "partner"),
        isNull(contacts.deletedAt),
      ),
    )
    .limit(1);

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
  const db = getDb();
  const now = new Date();

  return db.transaction(async (tx) => {
    const [eligible] = await tx
      .select({ id: partnerUsers.id })
      .from(partnerUsers)
      .innerJoin(contacts, eq(partnerUsers.orgContactId, contacts.id))
      .where(
        and(
          eq(partnerUsers.id, partnerUserId),
          eq(partnerUsers.active, true),
          eq(contacts.partnerStatus, "partner"),
          isNull(contacts.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!eligible?.id) {
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
  orgContactId: string;
  needsPasswordSetup: boolean;
  expiresAt: Date;
} | null> {
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
        passwordHash: partnerUsers.passwordHash,
        securityVersion: partnerUsers.securityVersion,
        partnerStatus: contacts.partnerStatus,
        orgDeletedAt: contacts.deletedAt,
      })
      .from(partnerUsers)
      .innerJoin(contacts, eq(partnerUsers.orgContactId, contacts.id))
      .where(eq(partnerUsers.id, tokenRow.partnerUserId))
      .for("update")
      .limit(1);

    if (
      !userRow?.id ||
      !userRow.active ||
      userRow.partnerStatus !== "partner" ||
      userRow.orgDeletedAt
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
    await tx.insert(partnerSessions).values({
      partnerUserId: userRow.id,
      activePartnerAccountId: accountBinding?.accountId ?? null,
      activeMembershipId: accountBinding?.membershipId ?? null,
      sessionHash,
      authMethod: "magic_link",
      assuranceLevel: "aal1",
      securityVersion: userRow.securityVersion,
      accountSelectedAt: accountBinding ? now : null,
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
        orgContactId: string;
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
        passwordHash: partnerUsers.passwordHash,
        mfaRequired: partnerUsers.mfaRequired,
        mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
        securityVersion: partnerUsers.securityVersion,
        partnerStatus: contacts.partnerStatus,
        orgDeletedAt: contacts.deletedAt,
      })
      .from(partnerUsers)
      .innerJoin(contacts, eq(partnerUsers.orgContactId, contacts.id))
      .where(eq(partnerUsers.id, sessionHint.partnerUserId))
      .limit(1);

    if (
      !userRow?.id ||
      !userRow.active ||
      userRow.partnerStatus !== "partner" ||
      userRow.orgDeletedAt
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

const SCRYPT_KEYLEN = 64;

function scryptHash(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = scryptHash(password, salt);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  if (!encoded.startsWith("scrypt$")) return false;
  const parts = encoded.split("$");
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1] ?? "", "base64url");
  const stored = Buffer.from(parts[2] ?? "", "base64url");
  if (!salt.length || stored.length !== SCRYPT_KEYLEN) return false;
  const derived = scryptHash(password, salt);
  return crypto.timingSafeEqual(stored, derived);
}

export async function setPartnerPassword(
  partnerUserId: string,
  password: string,
): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const passwordHash = hashPassword(password);
  return db.transaction(async (tx) => {
    const [eligible] = await tx
      .select({ id: partnerUsers.id })
      .from(partnerUsers)
      .innerJoin(contacts, eq(partnerUsers.orgContactId, contacts.id))
      .where(
        and(
          eq(partnerUsers.id, partnerUserId),
          eq(partnerUsers.active, true),
          eq(contacts.partnerStatus, "partner"),
          isNull(contacts.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!eligible?.id) return false;
    const [updated] = await tx
      .update(partnerUsers)
      .set({ passwordHash, passwordSetAt: now, updatedAt: now })
      .where(
        and(eq(partnerUsers.id, partnerUserId), eq(partnerUsers.active, true)),
      )
      .returning({ id: partnerUsers.id });
    return Boolean(updated?.id);
  });
}

export async function loginWithPassword(
  email: string,
  password: string,
  request: NextRequest,
  sessionDays = 30,
): Promise<{
  sessionToken: string;
  partnerUserId: string;
  orgContactId: string;
  expiresAt: Date;
} | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [userRow] = await tx
      .select({
        id: partnerUsers.id,
        orgContactId: partnerUsers.orgContactId,
        active: partnerUsers.active,
        passwordHash: partnerUsers.passwordHash,
        securityVersion: partnerUsers.securityVersion,
        partnerStatus: contacts.partnerStatus,
        orgDeletedAt: contacts.deletedAt,
      })
      .from(partnerUsers)
      .innerJoin(contacts, eq(partnerUsers.orgContactId, contacts.id))
      .where(eq(partnerUsers.email, email))
      .for("update")
      .limit(1);

    if (
      !userRow?.id ||
      !userRow.active ||
      !userRow.passwordHash ||
      userRow.partnerStatus !== "partner" ||
      userRow.orgDeletedAt ||
      !verifyPassword(password, userRow.passwordHash)
    ) {
      return null;
    }

    const now = new Date();
    const sessionToken = randomToken(32);
    const sessionHash = sha256Base64Url(sessionToken);
    const expiresAt = new Date(
      now.getTime() + sessionDays * 24 * 60 * 60 * 1000,
    );
    const accountBinding = await findInitialPartnerAccountBinding(
      tx,
      userRow.id,
    );
    await tx.insert(partnerSessions).values({
      partnerUserId: userRow.id,
      activePartnerAccountId: accountBinding?.accountId ?? null,
      activeMembershipId: accountBinding?.membershipId ?? null,
      sessionHash,
      authMethod: "password",
      assuranceLevel: "aal1",
      securityVersion: userRow.securityVersion,
      accountSelectedAt: accountBinding ? now : null,
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
      expiresAt,
    };
  });
}
