import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, teamLoginTokens, teamMembers, teamRoles, teamSessions } from "@/db";
import { resolvePublicSiteBaseUrl as resolvePublicSiteBaseUrlInternal } from "@/lib/public-site-url";

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

export function resolvePublicSiteBaseUrl(): string | null {
  return resolvePublicSiteBaseUrlInternal({ devFallbackLocalhost: true });
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

export async function findActiveTeamMemberByEmail(email: string): Promise<{
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  passwordHash: string | null;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      email: teamMembers.email,
      active: teamMembers.active,
      passwordHash: teamMembers.passwordHash
    })
    .from(teamMembers)
    .where(eq(teamMembers.email, email))
    .limit(1);

  if (!row?.id || !row.active) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    active: row.active ?? true,
    passwordHash: row.passwordHash ?? null
  };
}

export async function createTeamLoginToken(
  teamMemberId: string,
  request: NextRequest,
  ttlMinutes = 30
): Promise<{ rawToken: string; expiresAt: Date }> {
  const db = getDb();
  const rawToken = randomToken(32);
  const tokenHash = sha256Base64Url(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  await db.insert(teamLoginTokens).values({
    teamMemberId,
    tokenHash,
    requestedIp: getClientIp(request),
    userAgent: getUserAgent(request),
    expiresAt,
    createdAt: now
  });

  return { rawToken, expiresAt };
}

export async function exchangeTeamLoginToken(
  rawToken: string,
  request: NextRequest,
  sessionDays = 14
): Promise<
  | {
      sessionToken: string;
      teamMember: { id: string; name: string; email: string | null; roleSlug: string | null; passwordSet: boolean };
      needsPasswordSetup: boolean;
    }
  | null
> {
  const db = getDb();
  const tokenHash = sha256Base64Url(rawToken);
  const now = new Date();

  const [tokenRow] = await db
    .select({
      id: teamLoginTokens.id,
      teamMemberId: teamLoginTokens.teamMemberId,
      expiresAt: teamLoginTokens.expiresAt
    })
    .from(teamLoginTokens)
    .where(eq(teamLoginTokens.tokenHash, tokenHash))
    .limit(1);

  if (!tokenRow?.id) return null;
  if (tokenRow.expiresAt <= now) return null;

  // One-time token: delete after use.
  await db.delete(teamLoginTokens).where(eq(teamLoginTokens.id, tokenRow.id));

  const [memberRow] = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      email: teamMembers.email,
      active: teamMembers.active,
      passwordHash: teamMembers.passwordHash,
      roleSlug: teamRoles.slug
    })
    .from(teamMembers)
    .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
    .where(eq(teamMembers.id, tokenRow.teamMemberId))
    .limit(1);

  if (!memberRow?.id || !memberRow.active) return null;

  const sessionToken = randomToken(32);
  const sessionHash = sha256Base64Url(sessionToken);
  const expiresAt = new Date(now.getTime() + sessionDays * 24 * 60 * 60 * 1000);

  await db.insert(teamSessions).values({
    teamMemberId: memberRow.id,
    sessionHash,
    ip: getClientIp(request),
    userAgent: getUserAgent(request),
    expiresAt,
    createdAt: now,
    lastSeenAt: now
  });

  return {
    sessionToken,
    teamMember: {
      id: memberRow.id,
      name: memberRow.name,
      email: memberRow.email ?? null,
      roleSlug: memberRow.roleSlug ?? null,
      passwordSet: Boolean(memberRow.passwordHash)
    },
    needsPasswordSetup: !memberRow.passwordHash
  };
}

export async function revokeTeamSession(sessionToken: string): Promise<void> {
  const db = getDb();
  const sessionHash = sha256Base64Url(sessionToken);
  await db.update(teamSessions).set({ revokedAt: new Date() }).where(eq(teamSessions.sessionHash, sessionHash));
}

export async function requireTeamSession(
  request: NextRequest
): Promise<
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      teamMember: { id: string; name: string; email: string | null; roleSlug: string | null; passwordSet: boolean };
    }
> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim();
  if (!token) return { ok: false, status: 401, error: "unauthorized" };

  const sessionHash = sha256Base64Url(token);
  const now = new Date();
  const db = getDb();
  const [sessionRow] = await db
    .select({
      id: teamSessions.id,
      teamMemberId: teamSessions.teamMemberId,
      expiresAt: teamSessions.expiresAt,
      revokedAt: teamSessions.revokedAt
    })
    .from(teamSessions)
    .where(eq(teamSessions.sessionHash, sessionHash))
    .limit(1);

  if (!sessionRow?.id) return { ok: false, status: 401, error: "unauthorized" };
  if (sessionRow.revokedAt) return { ok: false, status: 401, error: "session_revoked" };
  if (sessionRow.expiresAt <= now) return { ok: false, status: 401, error: "session_expired" };

  const [memberRow] = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      email: teamMembers.email,
      active: teamMembers.active,
      passwordHash: teamMembers.passwordHash,
      roleSlug: teamRoles.slug
    })
    .from(teamMembers)
    .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
    .where(eq(teamMembers.id, sessionRow.teamMemberId))
    .limit(1);

  if (!memberRow?.id || !memberRow.active) return { ok: false, status: 401, error: "unauthorized" };

  await db.update(teamSessions).set({ lastSeenAt: now }).where(eq(teamSessions.id, sessionRow.id));

  return {
    ok: true,
    teamMember: {
      id: memberRow.id,
      name: memberRow.name,
      email: memberRow.email ?? null,
      roleSlug: memberRow.roleSlug ?? null,
      passwordSet: Boolean(memberRow.passwordHash)
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

export async function setTeamMemberPassword(teamMemberId: string, password: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .update(teamMembers)
    .set({ passwordHash: hashPassword(password), passwordSetAt: now, updatedAt: now })
    .where(eq(teamMembers.id, teamMemberId));
}

export async function loginWithPassword(
  email: string,
  password: string,
  request: NextRequest,
  sessionDays = 14
): Promise<
  | { sessionToken: string; teamMember: { id: string; name: string; roleSlug: string | null; passwordSet: boolean } }
  | null
> {
  const db = getDb();
  const [memberRow] = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      active: teamMembers.active,
      passwordHash: teamMembers.passwordHash,
      roleSlug: teamRoles.slug
    })
    .from(teamMembers)
    .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
    .where(eq(teamMembers.email, email))
    .limit(1);

  if (!memberRow?.id || !memberRow.active || !memberRow.passwordHash) return null;
  if (!verifyPassword(password, memberRow.passwordHash)) return null;

  const now = new Date();
  const sessionToken = randomToken(32);
  const sessionHash = sha256Base64Url(sessionToken);
  const expiresAt = new Date(now.getTime() + sessionDays * 24 * 60 * 60 * 1000);

  await db.insert(teamSessions).values({
    teamMemberId: memberRow.id,
    sessionHash,
    ip: getClientIp(request),
    userAgent: getUserAgent(request),
    expiresAt,
    createdAt: now,
    lastSeenAt: now
  });

  return {
    sessionToken,
    teamMember: {
      id: memberRow.id,
      name: memberRow.name,
      roleSlug: memberRow.roleSlug ?? null,
      passwordSet: Boolean(memberRow.passwordHash)
    }
  };
}

