import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, partnerLoginTokens, partnerSessions, partnerUsers } from "@/db";
import { normalizePhone } from "../../app/api/web/utils";

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
    return null;
  }
}

export function resolvePublicSiteBaseUrl(): string | null {
  const raw = (process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "").trim();
  if (!raw) {
    return process.env["NODE_ENV"] === "development" ? "http://localhost:3000" : null;
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    // This value is used in links sent via SMS/email. Never allow bind/private hosts,
    // even if NODE_ENV is accidentally misconfigured in production.
    const lowered = url.hostname.toLowerCase();
    if (lowered === "localhost" || lowered === "127.0.0.1" || lowered === "0.0.0.0") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return process.env["NODE_ENV"] === "development" ? "http://localhost:3000" : null;
  }
}

export function resolveRequestOriginBaseUrl(request: NextRequest): string | null {
  const origin = (request.headers.get("origin") ?? "").trim();
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const lowered = url.hostname.toLowerCase();
    if (lowered === "localhost" || lowered === "127.0.0.1" || lowered === "0.0.0.0") return null;
    // Only allow http in development; otherwise require https.
    if (process.env["NODE_ENV"] !== "development" && url.protocol !== "https:") return null;
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
      passwordHash: partnerUsers.passwordHash
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.email, email))
    .limit(1);

  if (!row?.id || !row.active) return null;
  return {
    id: row.id,
    orgContactId: row.orgContactId,
    name: row.name,
    email: row.email,
    phoneE164: row.phoneE164 ?? null,
    active: row.active ?? true,
    passwordHash: row.passwordHash ?? null
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
      passwordHash: partnerUsers.passwordHash
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.phoneE164, phoneE164))
    .limit(1);

  if (!row?.id || !row.active) return null;
  return {
    id: row.id,
    orgContactId: row.orgContactId,
    name: row.name,
    email: row.email,
    phoneE164: row.phoneE164 ?? null,
    active: row.active ?? true,
    passwordHash: row.passwordHash ?? null
  };
}

export async function createPartnerLoginToken(
  partnerUserId: string,
  request: NextRequest,
  ttlMinutes = 30
): Promise<{ rawToken: string; expiresAt: Date }> {
  const db = getDb();
  const rawToken = randomToken(32);
  const tokenHash = sha256Base64Url(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  await db.insert(partnerLoginTokens).values({
    partnerUserId,
    tokenHash,
    requestedIp: getClientIp(request),
    userAgent: getUserAgent(request),
    expiresAt,
    createdAt: now
  });

  return { rawToken, expiresAt };
}

export async function exchangePartnerLoginToken(
  rawToken: string,
  request: NextRequest,
  sessionDays = 30
): Promise<{ sessionToken: string; partnerUserId: string; orgContactId: string; needsPasswordSetup: boolean } | null> {
  const db = getDb();
  const tokenHash = sha256Base64Url(rawToken);
  const now = new Date();

  const [tokenRow] = await db
    .select({
      id: partnerLoginTokens.id,
      partnerUserId: partnerLoginTokens.partnerUserId
    })
    .from(partnerLoginTokens)
    .where(
      and(
        eq(partnerLoginTokens.tokenHash, tokenHash),
        isNull(partnerLoginTokens.usedAt),
        gt(partnerLoginTokens.expiresAt, now)
      )
    )
    .limit(1);

  if (!tokenRow?.id) return null;

  const [userRow] = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      active: partnerUsers.active,
      passwordHash: partnerUsers.passwordHash
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.id, tokenRow.partnerUserId))
    .limit(1);

  if (!userRow?.id || !userRow.active) return null;

  await db
    .update(partnerLoginTokens)
    .set({ usedAt: now })
    .where(eq(partnerLoginTokens.id, tokenRow.id));

  const sessionToken = randomToken(32);
  const sessionHash = sha256Base64Url(sessionToken);
  const expiresAt = new Date(now.getTime() + sessionDays * 24 * 60 * 60 * 1000);

  await db.insert(partnerSessions).values({
    partnerUserId: userRow.id,
    sessionHash,
    ip: getClientIp(request),
    userAgent: getUserAgent(request),
    expiresAt,
    createdAt: now,
    lastSeenAt: now
  });

  return {
    sessionToken,
    partnerUserId: userRow.id,
    orgContactId: userRow.orgContactId,
    needsPasswordSetup: !userRow.passwordHash
  };
}

export async function revokePartnerSession(sessionToken: string): Promise<void> {
  const db = getDb();
  const sessionHash = sha256Base64Url(sessionToken);
  await db
    .update(partnerSessions)
    .set({ revokedAt: new Date() })
    .where(eq(partnerSessions.sessionHash, sessionHash));
}

export async function requirePartnerSession(
  request: NextRequest
): Promise<
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      partnerUser: { id: string; orgContactId: string; email: string; name: string; passwordSet: boolean };
    }
> {
  const header = request.headers.get("authorization") ?? "";
  const token =
    header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim();
  if (!token) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const sessionHash = sha256Base64Url(token);
  const now = new Date();
  const db = getDb();
  const [sessionRow] = await db
    .select({
      id: partnerSessions.id,
      partnerUserId: partnerSessions.partnerUserId,
      expiresAt: partnerSessions.expiresAt,
      revokedAt: partnerSessions.revokedAt
    })
    .from(partnerSessions)
    .where(eq(partnerSessions.sessionHash, sessionHash))
    .limit(1);

  if (!sessionRow?.id) return { ok: false, status: 401, error: "unauthorized" };
  if (sessionRow.revokedAt) return { ok: false, status: 401, error: "session_revoked" };
  if (sessionRow.expiresAt <= now) return { ok: false, status: 401, error: "session_expired" };

  const [userRow] = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      email: partnerUsers.email,
      name: partnerUsers.name,
      active: partnerUsers.active,
      passwordHash: partnerUsers.passwordHash
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.id, sessionRow.partnerUserId))
    .limit(1);

  if (!userRow?.id || !userRow.active) return { ok: false, status: 401, error: "unauthorized" };

  await db
    .update(partnerSessions)
    .set({ lastSeenAt: now })
    .where(eq(partnerSessions.id, sessionRow.id));

  return {
    ok: true,
    partnerUser: {
      id: userRow.id,
      orgContactId: userRow.orgContactId,
      email: userRow.email,
      name: userRow.name,
      passwordSet: Boolean(userRow.passwordHash)
    }
  };
}

const SCRYPT_KEYLEN = 64;

function scryptHash(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN) as Buffer;
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
  if (!salt.length || !stored.length) return false;
  const derived = scryptHash(password, salt);
  return crypto.timingSafeEqual(stored, derived);
}

export async function setPartnerPassword(partnerUserId: string, password: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .update(partnerUsers)
    .set({ passwordHash: hashPassword(password), passwordSetAt: now, updatedAt: now })
    .where(eq(partnerUsers.id, partnerUserId));
}

export async function loginWithPassword(
  email: string,
  password: string,
  request: NextRequest,
  sessionDays = 30
): Promise<{ sessionToken: string; partnerUserId: string; orgContactId: string } | null> {
  const db = getDb();
  const [userRow] = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      active: partnerUsers.active,
      passwordHash: partnerUsers.passwordHash
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.email, email))
    .limit(1);

  if (!userRow?.id || !userRow.active || !userRow.passwordHash) return null;
  if (!verifyPassword(password, userRow.passwordHash)) return null;

  const now = new Date();
  const sessionToken = randomToken(32);
  const sessionHash = sha256Base64Url(sessionToken);
  const expiresAt = new Date(now.getTime() + sessionDays * 24 * 60 * 60 * 1000);

  await db.insert(partnerSessions).values({
    partnerUserId: userRow.id,
    sessionHash,
    ip: getClientIp(request),
    userAgent: getUserAgent(request),
    expiresAt,
    createdAt: now,
    lastSeenAt: now
  });

  return { sessionToken, partnerUserId: userRow.id, orgContactId: userRow.orgContactId };
}
