import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { exchangeTeamLoginToken } from "@/lib/team-auth";
import {
  getTeamAuthCorrelationId,
  recordTeamAuthAuditEventSafely,
} from "@/lib/team-auth-audit";

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = getTeamAuthCorrelationId(request);
  const payload = (await request.json().catch(() => null)) as {
    token?: unknown;
  } | null;
  const rawToken =
    typeof payload?.token === "string" ? payload.token.trim() : "";
  await Promise.all([
    recordTeamAuthAuditEventSafely({
      action: "team.auth.magic_link.consume",
      outcome: "attempted",
      correlationId,
      surface: "/team/auth",
    }),
    recordTeamAuthAuditEventSafely({
      action: "team.auth.magic_link.exchange",
      outcome: "attempted",
      correlationId,
      surface: "/team/auth",
    }),
  ]);
  if (!rawToken) {
    await Promise.all([
      recordTeamAuthAuditEventSafely({
        action: "team.auth.magic_link.consume",
        outcome: "denied",
        correlationId,
        surface: "/team/auth",
        metadata: { reasonCode: "token_required" },
      }),
      recordTeamAuthAuditEventSafely({
        action: "team.auth.magic_link.exchange",
        outcome: "denied",
        correlationId,
        surface: "/team/auth",
        metadata: { reasonCode: "token_required" },
      }),
    ]);
    return NextResponse.json(
      { ok: false, error: "token_required" },
      { status: 400 },
    );
  }

  let result: Awaited<ReturnType<typeof exchangeTeamLoginToken>>;
  try {
    result = await exchangeTeamLoginToken(rawToken, request, 30, {
      correlationId,
      surface: "/team/auth",
    });
  } catch {
    await Promise.all([
      recordTeamAuthAuditEventSafely({
        action: "team.auth.magic_link.consume",
        outcome: "failed",
        correlationId,
        surface: "/team/auth",
        metadata: { reasonCode: "exchange_unavailable" },
      }),
      recordTeamAuthAuditEventSafely({
        action: "team.auth.magic_link.exchange",
        outcome: "failed",
        correlationId,
        surface: "/team/auth",
        metadata: { reasonCode: "exchange_unavailable" },
      }),
    ]);
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
  if (!result) {
    await Promise.all([
      recordTeamAuthAuditEventSafely({
        action: "team.auth.magic_link.consume",
        outcome: "denied",
        correlationId,
        surface: "/team/auth",
        metadata: { reasonCode: "invalid_or_expired" },
      }),
      recordTeamAuthAuditEventSafely({
        action: "team.auth.magic_link.exchange",
        outcome: "denied",
        correlationId,
        surface: "/team/auth",
        metadata: { reasonCode: "invalid_or_expired" },
      }),
    ]);
    return NextResponse.json(
      { ok: false, error: "invalid_or_expired" },
      { status: 401 },
    );
  }

  return NextResponse.json({
    ok: true,
    sessionToken: result.sessionToken,
    teamMember: result.teamMember,
    needsPasswordSetup: result.needsPasswordSetup,
  });
}
