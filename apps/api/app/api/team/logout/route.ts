import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamSession, revokeTeamSession } from "@/lib/team-auth";
import {
  getTeamAuthCorrelationId,
  getVerifiedTeamAuthActor,
  recordTeamAuthAuditEventSafely,
} from "@/lib/team-auth-audit";

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = getTeamAuthCorrelationId(request);
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : header.trim();
  if (!token) {
    await Promise.all([
      recordTeamAuthAuditEventSafely({
        action: "team.auth.logout",
        outcome: "attempted",
        correlationId,
        surface: "/team",
      }),
      recordTeamAuthAuditEventSafely({
        action: "team.auth.logout",
        outcome: "denied",
        correlationId,
        surface: "/team",
        metadata: { reasonCode: "unauthorized" },
      }),
    ]);
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  let session: Awaited<ReturnType<typeof requireTeamSession>>;
  try {
    session = await requireTeamSession(request);
  } catch {
    await Promise.all([
      recordTeamAuthAuditEventSafely({
        action: "team.auth.logout",
        outcome: "attempted",
        correlationId,
        surface: "/team",
      }),
      recordTeamAuthAuditEventSafely({
        action: "team.auth.logout",
        outcome: "failed",
        correlationId,
        surface: "/team",
        metadata: { reasonCode: "session_verification_unavailable" },
      }),
    ]);
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
  if (!session.ok) {
    await Promise.all([
      recordTeamAuthAuditEventSafely({
        action: "team.auth.logout",
        outcome: "attempted",
        correlationId,
        surface: "/team",
      }),
      recordTeamAuthAuditEventSafely({
        action: "team.auth.logout",
        outcome: "denied",
        correlationId,
        surface: "/team",
        metadata: { reasonCode: session.error },
      }),
    ]);
    return NextResponse.json(
      { ok: false, error: session.error },
      { status: session.status },
    );
  }

  const actor = getVerifiedTeamAuthActor({
    memberId: session.teamMember.id,
    roleSlug: session.teamMember.roleSlug,
    sessionId: session.sessionId,
    authMethod: session.authMethod,
  });
  await recordTeamAuthAuditEventSafely({
    action: "team.auth.logout",
    outcome: "attempted",
    correlationId,
    surface: "/team",
    actor,
    entityType: "team_session",
    entityId: session.sessionId,
    metadata: { authMethod: session.authMethod },
  });
  try {
    await revokeTeamSession(token, {
      correlationId,
      surface: "/team",
    });
  } catch {
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.logout",
      outcome: "failed",
      correlationId,
      surface: "/team",
      actor,
      entityType: "team_session",
      entityId: session.sessionId,
      metadata: {
        authMethod: session.authMethod,
        reasonCode: "session_revocation_failed",
      },
    });
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}
