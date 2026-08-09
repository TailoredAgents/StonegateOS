import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamSession, setTeamMemberPassword } from "@/lib/team-auth";
import {
  getTeamAuthCorrelationId,
  getVerifiedTeamAuthActor,
  recordTeamAuthAuditEventSafely,
  type TeamAuthAuditAction,
} from "@/lib/team-auth-audit";

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = getTeamAuthCorrelationId(request);
  let session: Awaited<ReturnType<typeof requireTeamSession>>;
  try {
    session = await requireTeamSession(request);
  } catch {
    await Promise.all([
      recordTeamAuthAuditEventSafely({
        action: "team.auth.password.update",
        outcome: "attempted",
        correlationId,
        surface: "/team/settings",
      }),
      recordTeamAuthAuditEventSafely({
        action: "team.auth.password.update",
        outcome: "failed",
        correlationId,
        surface: "/team/settings",
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
        action: "team.auth.password.update",
        outcome: "attempted",
        correlationId,
        surface: "/team/settings",
      }),
      recordTeamAuthAuditEventSafely({
        action: "team.auth.password.update",
        outcome: "denied",
        correlationId,
        surface: "/team/settings",
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
  const expectedAction: TeamAuthAuditAction = session.teamMember.passwordSet
    ? "team.auth.password.change"
    : "team.auth.password.setup";
  const expectedMode = session.teamMember.passwordSet ? "change" : "setup";
  await recordTeamAuthAuditEventSafely({
    action: expectedAction,
    outcome: "attempted",
    correlationId,
    surface: "/team/settings",
    actor,
    entityType: "team_member",
    entityId: session.teamMember.id,
    metadata: {
      passwordMode: expectedMode,
      authMethod: session.authMethod,
    },
  });

  const payload = (await request.json().catch(() => null)) as {
    password?: unknown;
  } | null;
  const password =
    typeof payload?.password === "string" ? payload.password : "";
  if (!password || password.length < 10) {
    await recordTeamAuthAuditEventSafely({
      action: expectedAction,
      outcome: "denied",
      correlationId,
      surface: "/team/settings",
      actor,
      entityType: "team_member",
      entityId: session.teamMember.id,
      metadata: {
        passwordMode: expectedMode,
        authMethod: session.authMethod,
        reasonCode: "password_too_short",
      },
    });
    return NextResponse.json(
      { ok: false, error: "password_too_short" },
      { status: 400 },
    );
  }

  let result: Awaited<ReturnType<typeof setTeamMemberPassword>>;
  try {
    result = await setTeamMemberPassword(
      session.teamMember.id,
      password,
      session.sessionId,
      {
        correlationId,
        surface: "/team/settings",
      },
    );
  } catch {
    await recordTeamAuthAuditEventSafely({
      action: expectedAction,
      outcome: "failed",
      correlationId,
      surface: "/team/settings",
      actor,
      entityType: "team_member",
      entityId: session.teamMember.id,
      metadata: {
        passwordMode: expectedMode,
        authMethod: session.authMethod,
        reasonCode: "password_update_failed",
      },
    });
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    revokedSessionCount: result.revokedSessionCount,
  });
}
