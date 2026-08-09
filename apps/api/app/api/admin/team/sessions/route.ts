import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { count, desc, eq } from "drizzle-orm";
import { getDb, teamMembers, teamSessions } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const SESSION_LIMIT = 200;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const memberId = request.nextUrl.searchParams.get("memberId")?.trim() ?? "";
  if (memberId && !isUuid(memberId)) {
    return NextResponse.json(
      { error: "invalid_member_id", retryable: false },
      { status: 422 },
    );
  }

  const db = getDb();
  const where = memberId ? eq(teamSessions.teamMemberId, memberId) : undefined;
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: teamSessions.id,
        memberId: teamSessions.teamMemberId,
        memberName: teamMembers.name,
        memberEmail: teamMembers.email,
        authMethod: teamSessions.authMethod,
        createdAt: teamSessions.createdAt,
        lastSeenAt: teamSessions.lastSeenAt,
        expiresAt: teamSessions.expiresAt,
        revokedAt: teamSessions.revokedAt,
      })
      .from(teamSessions)
      .innerJoin(teamMembers, eq(teamMembers.id, teamSessions.teamMemberId))
      .where(where)
      .orderBy(desc(teamSessions.lastSeenAt), desc(teamSessions.id))
      .limit(SESSION_LIMIT),
    db.select({ total: count() }).from(teamSessions).where(where),
  ]);

  const now = Date.now();
  return NextResponse.json(
    {
      ok: true,
      total: Number(totals[0]?.total ?? 0),
      limit: SESSION_LIMIT,
      truncated: Number(totals[0]?.total ?? 0) > rows.length,
      sessions: rows.map((session) => ({
        id: session.id,
        memberId: session.memberId,
        memberName: session.memberName,
        memberEmail: session.memberEmail,
        authMethod: session.authMethod,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        revokedAt: session.revokedAt?.toISOString() ?? null,
        status: session.revokedAt
          ? "revoked"
          : session.expiresAt.getTime() <= now
            ? "expired"
            : "active",
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
