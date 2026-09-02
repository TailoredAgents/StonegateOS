import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { getDb, teamSessions } from "@/db";
import { requirePermission } from "@/lib/permissions";
import {
  selfSessionCollectionVersion,
  selfSessionStatus,
} from "@/lib/self-session-management";
import { getVerifiedRequestActor } from "@/lib/verified-actor-context";
import { isAdminRequest } from "../../../../web/admin";

const SELF_SESSION_LIMIT = 50;

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(
    request,
    "sessions.manage_self",
  );
  if (permissionError) return permissionError;

  const actor = getVerifiedRequestActor(request);
  if (
    actor?.type !== "human" ||
    !actor.id ||
    !actor.sessionId ||
    (actor.authMethod !== "team_session" && actor.authMethod !== "break_glass")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await getDb()
    .select({
      id: teamSessions.id,
      authMethod: teamSessions.authMethod,
      assuranceLevel: teamSessions.assuranceLevel,
      mfaVerifiedAt: teamSessions.mfaVerifiedAt,
      createdAt: teamSessions.createdAt,
      lastSeenAt: teamSessions.lastSeenAt,
      expiresAt: teamSessions.expiresAt,
      revokedAt: teamSessions.revokedAt,
    })
    .from(teamSessions)
    .where(eq(teamSessions.teamMemberId, actor.id))
    .orderBy(asc(teamSessions.createdAt), asc(teamSessions.id));

  const now = new Date();
  const currentSession = rows.find((session) => session.id === actor.sessionId);
  if (!currentSession) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const visibleRows = [
    currentSession,
    ...rows
      .filter((session) => session.id !== actor.sessionId)
      .slice(-(SELF_SESSION_LIMIT - 1))
      .reverse(),
  ];
  const activeOtherCount = rows.filter(
    (session) =>
      session.id !== actor.sessionId &&
      selfSessionStatus(session, now) === "active",
  ).length;

  return NextResponse.json(
    {
      ok: true,
      version: selfSessionCollectionVersion(rows),
      total: rows.length,
      limit: SELF_SESSION_LIMIT,
      truncated: rows.length > visibleRows.length,
      activeOtherCount,
      sessions: visibleRows.map((session) => ({
        current: session.id === actor.sessionId,
        authMethod: session.authMethod,
        assuranceLevel: session.assuranceLevel,
        mfaVerifiedAt: session.mfaVerifiedAt?.toISOString() ?? null,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        revokedAt: session.revokedAt?.toISOString() ?? null,
        status: selfSessionStatus(session, now),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
