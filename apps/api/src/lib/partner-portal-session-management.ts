import { and, desc, eq, isNull } from "drizzle-orm";
import { auditLogs, getDb, partnerSessions } from "@/db";
import {
  selfSessionCollectionVersion,
  selfSessionStatus,
} from "@/lib/self-session-management";
import { portalV2SessionHandle } from "@/lib/partner-portal-v2-security";

export type PartnerSelfSession = {
  id: string;
  authMethod: string;
  assuranceLevel: string;
  mfaVerifiedAt: Date | null;
  deviceName: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export async function listPartnerSelfSessions(
  partnerUserId: string,
): Promise<PartnerSelfSession[]> {
  return getDb()
    .select({
      id: partnerSessions.id,
      authMethod: partnerSessions.authMethod,
      assuranceLevel: partnerSessions.assuranceLevel,
      mfaVerifiedAt: partnerSessions.mfaVerifiedAt,
      deviceName: partnerSessions.deviceName,
      userAgent: partnerSessions.userAgent,
      createdAt: partnerSessions.createdAt,
      lastSeenAt: partnerSessions.lastSeenAt,
      expiresAt: partnerSessions.expiresAt,
      revokedAt: partnerSessions.revokedAt,
    })
    .from(partnerSessions)
    .where(eq(partnerSessions.partnerUserId, partnerUserId))
    .orderBy(desc(partnerSessions.lastSeenAt), desc(partnerSessions.id))
    .limit(100);
}

export function partnerSelfSessionVersion(
  sessions: readonly PartnerSelfSession[],
): string {
  return selfSessionCollectionVersion(sessions);
}

export function serializePartnerSelfSession(
  session: PartnerSelfSession,
  currentSessionId: string,
  now = new Date(),
): Record<string, unknown> {
  return {
    handle: portalV2SessionHandle(session.id),
    current: session.id === currentSessionId,
    status: selfSessionStatus(session, now),
    authMethod: session.authMethod,
    assuranceLevel: session.assuranceLevel,
    mfaVerifiedAt: session.mfaVerifiedAt?.toISOString() ?? null,
    deviceName: session.deviceName?.slice(0, 160) ?? null,
    userAgent: session.userAgent?.slice(0, 500) ?? null,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    revokedAt: session.revokedAt?.toISOString() ?? null,
  };
}

export async function revokePartnerSelfSession(input: {
  partnerUserId: string;
  targetSessionId: string;
  actorSessionId: string;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(partnerSessions)
      .set({ revokedAt: now, lastSeenAt: now })
      .where(
        and(
          eq(partnerSessions.id, input.targetSessionId),
          eq(partnerSessions.partnerUserId, input.partnerUserId),
          isNull(partnerSessions.revokedAt),
        ),
      )
      .returning({ id: partnerSessions.id });
    if (!updated) return false;
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.partnerUserId,
      sessionId: input.actorSessionId,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      outcome: "succeeded",
      surface: "partner_portal_v2",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: "partner.session.revoked",
      entityType: "partner_session",
      entityId: portalV2SessionHandle(input.targetSessionId),
      meta: { currentSession: input.targetSessionId === input.actorSessionId },
      createdAt: now,
    });
    return true;
  });
}
