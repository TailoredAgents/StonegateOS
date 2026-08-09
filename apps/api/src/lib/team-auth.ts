import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import {
  getDb,
  teamLoginTokens,
  teamMembers,
  teamRoles,
  teamSessions,
} from "@/db";
import {
  computeEffectivePermissions,
  permissionMatches,
} from "@/lib/permissions";
import {
  getVerifiedTeamAuthActor,
  insertTeamAuthSuccessAuditEvent,
  type TeamAuthSuccessAuditContext,
} from "@/lib/team-auth-audit";
import type { TeamMutationAuditWriter } from "@/lib/team-mutation";
import { resolvePublicSiteBaseUrl as resolvePublicSiteBaseUrlInternal } from "@/lib/public-site-url";
import {
  normalizeTeamMemberEmail,
  normalizeTeamMemberPhoneE164,
  selectUnambiguousActiveIdentity,
} from "@/lib/team-member-identity";

export function normalizeEmail(value: unknown): string | null {
  return normalizeTeamMemberEmail(value);
}

export function normalizePhoneE164(value: unknown): string | null {
  return normalizeTeamMemberPhoneE164(value);
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

export type TeamSessionAuthMethod = "team_session" | "break_glass";
export type BreakGlassSessionType = "owner" | "crew";

const BREAK_GLASS_SESSION_TTL_MINUTES = 60;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function configuredBreakGlassMemberId(
  sessionType: BreakGlassSessionType,
): string | null {
  const envName =
    sessionType === "owner"
      ? "TEAM_BREAK_GLASS_OWNER_MEMBER_ID"
      : "TEAM_BREAK_GLASS_CREW_MEMBER_ID";
  const value = process.env[envName]?.trim() ?? "";
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function breakGlassRequiredPermission(
  sessionType: BreakGlassSessionType,
): "access.manage" | "appointments.read" {
  return sessionType === "owner" ? "access.manage" : "appointments.read";
}

function permissionIsExplicitlyDenied(
  deniedPermissions: string[] | null | undefined,
  requiredPermission: string,
): boolean {
  return (deniedPermissions ?? []).some((denied) =>
    permissionMatches(denied.trim(), requiredPermission),
  );
}

export type BreakGlassSessionResult = {
  sessionToken: string;
  sessionId: string;
  expiresAt: Date;
  teamMemberId: string;
  auditEventId: string;
  committedAt: string;
};

/**
 * Exchange one configured legacy recovery type for a normal opaque session.
 *
 * The caller never supplies a member ID. The locked member row, permission
 * check, prior break-glass revocation, new session, and success audit all share
 * one transaction. A missing/inactive/denied target fails closed.
 */
export async function createBreakGlassTeamSession(input: {
  sessionType: BreakGlassSessionType;
  clientIp: string | null;
  userAgent: string | null;
  audit: TeamMutationAuditWriter;
  now?: Date;
}): Promise<BreakGlassSessionResult | null> {
  const teamMemberId = configuredBreakGlassMemberId(input.sessionType);
  if (!teamMemberId) return null;

  const requiredPermission = breakGlassRequiredPermission(input.sessionType);
  const db = getDb();
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [memberRow] = await tx
      .select({
        id: teamMembers.id,
        active: teamMembers.active,
        roleSlug: teamRoles.slug,
        rolePermissions: teamRoles.permissions,
        permissionsGrant: teamMembers.permissionsGrant,
        permissionsDeny: teamMembers.permissionsDeny,
      })
      .from(teamMembers)
      .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
      .where(eq(teamMembers.id, teamMemberId))
      .for("update")
      .limit(1);

    if (!memberRow?.id || memberRow.active !== true) return null;

    const effectivePermissions = computeEffectivePermissions({
      rolePermissions: memberRow.rolePermissions ?? [],
      grant: memberRow.permissionsGrant ?? [],
      deny: memberRow.permissionsDeny ?? [],
    });
    if (
      permissionIsExplicitlyDenied(
        memberRow.permissionsDeny,
        requiredPermission,
      ) ||
      !effectivePermissions.some((permission) =>
        permissionMatches(permission, requiredPermission),
      )
    ) {
      return null;
    }

    // Serialize exchanges through the member lock and keep at most one live
    // recovery session per configured member. Normal sessions are untouched.
    await tx
      .update(teamSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(teamSessions.teamMemberId, teamMemberId),
          eq(teamSessions.authMethod, "break_glass"),
          isNull(teamSessions.revokedAt),
        ),
      );

    const sessionId = crypto.randomUUID();
    const sessionToken = randomToken(32);
    const sessionHash = sha256Base64Url(sessionToken);
    const expiresAt = new Date(
      now.getTime() + BREAK_GLASS_SESSION_TTL_MINUTES * 60 * 1_000,
    );

    await tx.insert(teamSessions).values({
      id: sessionId,
      teamMemberId,
      sessionHash,
      authMethod: "break_glass",
      ip: input.clientIp,
      userAgent: input.userAgent,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
    });

    const auditReceipt = await input.audit.insertSuccess(tx, {
      entityType: "team_session",
      entityId: sessionId,
      after: {
        teamMemberId,
        authMethod: "break_glass",
        expiresAt: expiresAt.toISOString(),
      },
      metadata: {
        recoveryType: input.sessionType,
        requiredPermission,
      },
      committedAt: now,
    });

    return {
      sessionToken,
      sessionId,
      expiresAt,
      teamMemberId,
      auditEventId: auditReceipt.auditEventId,
      committedAt: auditReceipt.committedAt,
    };
  });
}

export async function findActiveTeamMemberByEmail(email: string): Promise<{
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  phoneE164: string | null;
  passwordHash: string | null;
} | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  const db = getDb();
  const rows = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      email: teamMembers.email,
      active: teamMembers.active,
      phoneE164: teamMembers.phoneE164,
      passwordHash: teamMembers.passwordHash,
    })
    .from(teamMembers)
    .where(eq(teamMembers.emailNormalized, normalizedEmail))
    .limit(2);

  const row = selectUnambiguousActiveIdentity(rows);
  if (!row?.id) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    active: row.active ?? true,
    phoneE164: row.phoneE164 ?? null,
    passwordHash: row.passwordHash ?? null,
  };
}

export async function findActiveTeamMemberByPhone(phoneE164: string): Promise<{
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  phoneE164: string | null;
  passwordHash: string | null;
} | null> {
  const normalizedPhone = normalizeTeamMemberPhoneE164(phoneE164);
  if (!normalizedPhone) return null;

  const db = getDb();
  const rows = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      email: teamMembers.email,
      active: teamMembers.active,
      phoneE164: teamMembers.phoneE164,
      passwordHash: teamMembers.passwordHash,
    })
    .from(teamMembers)
    .where(eq(teamMembers.phoneE164, normalizedPhone))
    .limit(2);

  const row = selectUnambiguousActiveIdentity(rows);
  if (!row?.id) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    active: row.active ?? true,
    phoneE164: row.phoneE164 ?? null,
    passwordHash: row.passwordHash ?? null,
  };
}

export async function createTeamLoginToken(
  teamMemberId: string,
  request: NextRequest,
  ttlMinutes = 30,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const db = getDb();
  const rawToken = randomToken(32);
  const tokenHash = sha256Base64Url(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  await db.transaction(async (tx) => {
    const [member] = await tx
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(eq(teamMembers.id, teamMemberId))
      .for("update")
      .limit(1);
    if (!member?.id) {
      throw new Error("Cannot issue a login token for an unknown team member");
    }

    await tx
      .delete(teamLoginTokens)
      .where(
        and(
          eq(teamLoginTokens.teamMemberId, teamMemberId),
          gt(teamLoginTokens.expiresAt, now),
        ),
      );
    await tx.insert(teamLoginTokens).values({
      teamMemberId,
      tokenHash,
      requestedIp: getClientIp(request),
      userAgent: getUserAgent(request),
      expiresAt,
      createdAt: now,
    });
  });

  return { rawToken, expiresAt };
}

export async function exchangeTeamLoginToken(
  rawToken: string,
  request: NextRequest,
  sessionDays: number,
  successAudit: TeamAuthSuccessAuditContext,
): Promise<{
  sessionToken: string;
  sessionId: string;
  teamMember: {
    id: string;
    name: string;
    email: string | null;
    roleSlug: string | null;
    passwordSet: boolean;
  };
  needsPasswordSetup: boolean;
} | null> {
  const db = getDb();
  const tokenHash = sha256Base64Url(rawToken);
  const now = new Date();

  return db.transaction(async (tx) => {
    const [tokenCandidate] = await tx
      .select({ teamMemberId: teamLoginTokens.teamMemberId })
      .from(teamLoginTokens)
      .where(
        and(
          eq(teamLoginTokens.tokenHash, tokenHash),
          gt(teamLoginTokens.expiresAt, now),
        ),
      )
      .limit(1);
    if (!tokenCandidate?.teamMemberId) return null;

    const [memberRow] = await tx
      .select({
        id: teamMembers.id,
        name: teamMembers.name,
        email: teamMembers.email,
        active: teamMembers.active,
        passwordHash: teamMembers.passwordHash,
        roleSlug: teamRoles.slug,
      })
      .from(teamMembers)
      .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
      .where(eq(teamMembers.id, tokenCandidate.teamMemberId))
      .for("update", { of: teamMembers })
      .limit(1);

    if (!memberRow?.id || !memberRow.active) return null;

    // Login-link creation takes the same member lock before replacing tokens.
    // Keeping this lock order prevents a create/exchange deadlock while the
    // conditional delete below preserves one-time consumption under replay.
    const [consumedToken] = await tx
      .delete(teamLoginTokens)
      .where(
        and(
          eq(teamLoginTokens.tokenHash, tokenHash),
          eq(teamLoginTokens.teamMemberId, memberRow.id),
          gt(teamLoginTokens.expiresAt, now),
        ),
      )
      .returning({ teamMemberId: teamLoginTokens.teamMemberId });
    if (!consumedToken?.teamMemberId) return null;

    const sessionId = crypto.randomUUID();
    const sessionToken = randomToken(32);
    const sessionHash = sha256Base64Url(sessionToken);
    const expiresAt = new Date(
      now.getTime() + sessionDays * 24 * 60 * 60 * 1000,
    );

    await tx.insert(teamSessions).values({
      id: sessionId,
      teamMemberId: memberRow.id,
      sessionHash,
      authMethod: "team_session",
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
    });

    const actor = getVerifiedTeamAuthActor({
      memberId: memberRow.id,
      roleSlug: memberRow.roleSlug,
      sessionId,
      authMethod: "team_session",
    });
    await insertTeamAuthSuccessAuditEvent(tx, {
      ...successAudit,
      action: "team.auth.magic_link.consume",
      actor,
      entityType: "team_session",
      entityId: sessionId,
      metadata: { tokenConsumed: true },
      committedAt: now,
    });
    await insertTeamAuthSuccessAuditEvent(tx, {
      ...successAudit,
      action: "team.auth.magic_link.exchange",
      actor,
      entityType: "team_session",
      entityId: sessionId,
      metadata: {
        authMethod: "team_session",
        tokenConsumed: true,
        sessionCreated: true,
      },
      committedAt: now,
    });

    return {
      sessionToken,
      sessionId,
      teamMember: {
        id: memberRow.id,
        name: memberRow.name,
        email: memberRow.email ?? null,
        roleSlug: memberRow.roleSlug ?? null,
        passwordSet: Boolean(memberRow.passwordHash),
      },
      needsPasswordSetup: !memberRow.passwordHash,
    };
  });
}

export async function revokeTeamSession(
  sessionToken: string,
  successAudit: TeamAuthSuccessAuditContext,
): Promise<void> {
  const db = getDb();
  const sessionHash = sha256Base64Url(sessionToken);
  const now = new Date();
  await db.transaction(async (tx) => {
    const [sessionRow] = await tx
      .select({
        id: teamSessions.id,
        teamMemberId: teamSessions.teamMemberId,
        authMethod: teamSessions.authMethod,
        revokedAt: teamSessions.revokedAt,
        roleSlug: teamRoles.slug,
      })
      .from(teamSessions)
      .leftJoin(teamMembers, eq(teamSessions.teamMemberId, teamMembers.id))
      .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
      .where(eq(teamSessions.sessionHash, sessionHash))
      .for("update", { of: teamSessions })
      .limit(1);
    if (
      !sessionRow?.id ||
      !sessionRow.teamMemberId ||
      sessionRow.revokedAt ||
      (sessionRow.authMethod !== "team_session" &&
        sessionRow.authMethod !== "break_glass")
    ) {
      throw new Error("Cannot revoke an inactive team session");
    }

    const [revoked] = await tx
      .update(teamSessions)
      .set({ revokedAt: now })
      .where(
        and(eq(teamSessions.id, sessionRow.id), isNull(teamSessions.revokedAt)),
      )
      .returning({ id: teamSessions.id });
    if (!revoked?.id) {
      throw new Error("Cannot revoke an inactive team session");
    }

    await insertTeamAuthSuccessAuditEvent(tx, {
      ...successAudit,
      action: "team.auth.logout",
      actor: getVerifiedTeamAuthActor({
        memberId: sessionRow.teamMemberId,
        roleSlug: sessionRow.roleSlug,
        sessionId: sessionRow.id,
        authMethod: sessionRow.authMethod,
      }),
      entityType: "team_session",
      entityId: sessionRow.id,
      metadata: { authMethod: sessionRow.authMethod },
      committedAt: now,
    });
  });
}

export async function requireTeamSession(request: NextRequest): Promise<
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      sessionId: string;
      authMethod: TeamSessionAuthMethod;
      teamMember: {
        id: string;
        name: string;
        email: string | null;
        roleSlug: string | null;
        passwordSet: boolean;
        permissions: string[];
      };
    }
> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : header.trim();
  if (!token) return { ok: false, status: 401, error: "unauthorized" };

  const sessionHash = sha256Base64Url(token);
  const now = new Date();
  const db = getDb();
  const [sessionRow] = await db
    .select({
      id: teamSessions.id,
      teamMemberId: teamSessions.teamMemberId,
      authMethod: teamSessions.authMethod,
      expiresAt: teamSessions.expiresAt,
      revokedAt: teamSessions.revokedAt,
    })
    .from(teamSessions)
    .where(eq(teamSessions.sessionHash, sessionHash))
    .limit(1);

  if (!sessionRow?.id) return { ok: false, status: 401, error: "unauthorized" };
  if (
    sessionRow.authMethod !== "team_session" &&
    sessionRow.authMethod !== "break_glass"
  ) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  if (sessionRow.revokedAt)
    return { ok: false, status: 401, error: "session_revoked" };
  if (sessionRow.expiresAt <= now)
    return { ok: false, status: 401, error: "session_expired" };

  const [memberRow] = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      email: teamMembers.email,
      active: teamMembers.active,
      passwordHash: teamMembers.passwordHash,
      roleSlug: teamRoles.slug,
      rolePermissions: teamRoles.permissions,
      permissionsGrant: teamMembers.permissionsGrant,
      permissionsDeny: teamMembers.permissionsDeny,
    })
    .from(teamMembers)
    .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
    .where(eq(teamMembers.id, sessionRow.teamMemberId))
    .limit(1);

  if (!memberRow?.id || !memberRow.active)
    return { ok: false, status: 401, error: "unauthorized" };

  await db
    .update(teamSessions)
    .set({ lastSeenAt: now })
    .where(eq(teamSessions.id, sessionRow.id));

  const roleSlug = memberRow.roleSlug
    ? memberRow.roleSlug.trim().toLowerCase()
    : null;
  const permissions = computeEffectivePermissions({
    rolePermissions: memberRow.rolePermissions ?? [],
    grant: memberRow.permissionsGrant ?? [],
    deny: memberRow.permissionsDeny ?? [],
  });

  return {
    ok: true,
    sessionId: sessionRow.id,
    authMethod: sessionRow.authMethod,
    teamMember: {
      id: memberRow.id,
      name: memberRow.name,
      email: memberRow.email ?? null,
      roleSlug,
      passwordSet: Boolean(memberRow.passwordHash),
      permissions,
    },
  };
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
  if (!salt.length || !stored.length) return false;
  const derived = scryptHash(password, salt);
  return crypto.timingSafeEqual(stored, derived);
}

export async function setTeamMemberPassword(
  teamMemberId: string,
  password: string,
  currentSessionId: string,
  successAudit: TeamAuthSuccessAuditContext,
): Promise<{
  revokedSessionCount: number;
  passwordMode: "setup" | "change";
}> {
  const db = getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [memberBefore] = await tx
      .select({
        id: teamMembers.id,
        active: teamMembers.active,
        passwordHash: teamMembers.passwordHash,
        roleSlug: teamRoles.slug,
      })
      .from(teamMembers)
      .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
      .where(eq(teamMembers.id, teamMemberId))
      .for("update", { of: teamMembers })
      .limit(1);
    if (!memberBefore?.id || memberBefore.active !== true)
      throw new Error("Cannot set a password for an unknown member");

    const [currentSession] = await tx
      .select({
        id: teamSessions.id,
        authMethod: teamSessions.authMethod,
      })
      .from(teamSessions)
      .where(
        and(
          eq(teamSessions.id, currentSessionId),
          eq(teamSessions.teamMemberId, teamMemberId),
          isNull(teamSessions.revokedAt),
          gt(teamSessions.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !currentSession?.id ||
      (currentSession.authMethod !== "team_session" &&
        currentSession.authMethod !== "break_glass")
    ) {
      throw new Error("Cannot update a password from an inactive session");
    }

    const [updated] = await tx
      .update(teamMembers)
      .set({
        passwordHash: hashPassword(password),
        passwordSetAt: now,
        updatedAt: now,
      })
      .where(eq(teamMembers.id, teamMemberId))
      .returning({ id: teamMembers.id });
    if (!updated)
      throw new Error("Cannot set a password for an unknown member");

    const revokedSessions = await tx
      .update(teamSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(teamSessions.teamMemberId, teamMemberId),
          ne(teamSessions.id, currentSessionId),
          isNull(teamSessions.revokedAt),
        ),
      )
      .returning({ id: teamSessions.id });
    await tx
      .delete(teamLoginTokens)
      .where(eq(teamLoginTokens.teamMemberId, teamMemberId));

    const passwordMode = memberBefore.passwordHash ? "change" : "setup";
    await insertTeamAuthSuccessAuditEvent(tx, {
      ...successAudit,
      action:
        passwordMode === "change"
          ? "team.auth.password.change"
          : "team.auth.password.setup",
      actor: getVerifiedTeamAuthActor({
        memberId: memberBefore.id,
        roleSlug: memberBefore.roleSlug,
        sessionId: currentSession.id,
        authMethod: currentSession.authMethod,
      }),
      entityType: "team_member",
      entityId: memberBefore.id,
      metadata: {
        passwordMode,
        revokedSessionCount: revokedSessions.length,
        authMethod: currentSession.authMethod,
      },
      committedAt: now,
    });

    return {
      revokedSessionCount: revokedSessions.length,
      passwordMode,
    };
  });
}

export async function loginWithPassword(
  email: string,
  password: string,
  request: NextRequest,
  sessionDays: number,
  successAudit: TeamAuthSuccessAuditContext,
): Promise<{
  sessionToken: string;
  sessionId: string;
  teamMember: {
    id: string;
    name: string;
    roleSlug: string | null;
    passwordSet: boolean;
  };
} | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  const db = getDb();
  return db.transaction(async (tx) => {
    const memberRows = await tx
      .select({
        id: teamMembers.id,
        name: teamMembers.name,
        active: teamMembers.active,
        passwordHash: teamMembers.passwordHash,
        roleSlug: teamRoles.slug,
      })
      .from(teamMembers)
      .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
      .where(eq(teamMembers.emailNormalized, normalizedEmail))
      .for("update", { of: teamMembers })
      .limit(2);

    const memberRow = selectUnambiguousActiveIdentity(memberRows);
    if (!memberRow?.id || !memberRow.active || !memberRow.passwordHash) {
      return null;
    }
    if (!verifyPassword(password, memberRow.passwordHash)) return null;

    const now = new Date();
    const sessionId = crypto.randomUUID();
    const sessionToken = randomToken(32);
    const sessionHash = sha256Base64Url(sessionToken);
    const expiresAt = new Date(
      now.getTime() + sessionDays * 24 * 60 * 60 * 1000,
    );

    await tx.insert(teamSessions).values({
      id: sessionId,
      teamMemberId: memberRow.id,
      sessionHash,
      authMethod: "team_session",
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
    });

    await insertTeamAuthSuccessAuditEvent(tx, {
      ...successAudit,
      action: "team.auth.password.login",
      actor: getVerifiedTeamAuthActor({
        memberId: memberRow.id,
        roleSlug: memberRow.roleSlug,
        sessionId,
        authMethod: "team_session",
      }),
      entityType: "team_session",
      entityId: sessionId,
      metadata: {
        identityKind: "email",
        authMethod: "team_session",
        sessionCreated: true,
      },
      committedAt: now,
    });

    return {
      sessionToken,
      sessionId,
      teamMember: {
        id: memberRow.id,
        name: memberRow.name,
        roleSlug: memberRow.roleSlug ?? null,
        passwordSet: Boolean(memberRow.passwordHash),
      },
    };
  });
}
