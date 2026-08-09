import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { loginWithPassword, normalizeEmail } from "@/lib/team-auth";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import { describeTeamAuthInfrastructureError } from "@/lib/team-auth-error-observability";
import {
  getTeamAuthCorrelationId,
  recordTeamAuthAuditEventSafely,
} from "@/lib/team-auth-audit";

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = getTeamAuthCorrelationId(request);
  const payload = (await request.json().catch(() => null)) as {
    email?: unknown;
    password?: unknown;
  } | null;
  const email = normalizeEmail(payload?.email);
  const password =
    typeof payload?.password === "string" ? payload.password : null;
  await recordTeamAuthAuditEventSafely({
    action: "team.auth.password.login",
    outcome: "attempted",
    correlationId,
    surface: "/team/login",
    metadata: { identityKind: "email" },
  });
  if (!email || !password) {
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.password.login",
      outcome: "denied",
      correlationId,
      surface: "/team/login",
      metadata: {
        identityKind: "email",
        reasonCode: "invalid_credentials",
      },
    });
    return NextResponse.json(
      { ok: false, error: "invalid_credentials" },
      { status: 401 },
    );
  }

  let rateLimit: { limited: boolean; retryAfterSeconds: number };
  try {
    rateLimit = await consumeTeamAuthRateLimit({
      action: "password_login",
      request,
      identity: { kind: "email", value: email },
    });
  } catch (error) {
    console.error(
      "[team.auth] password_rate_limit_unavailable",
      describeTeamAuthInfrastructureError(error),
    );
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.password.login",
      outcome: "failed",
      correlationId,
      surface: "/team/login",
      metadata: {
        identityKind: "email",
        reasonCode: "rate_limit_unavailable",
      },
    });
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503, headers: { "Retry-After": "60" } },
    );
  }
  if (rateLimit.limited) {
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.password.login",
      outcome: "denied",
      correlationId,
      surface: "/team/login",
      metadata: {
        identityKind: "email",
        reasonCode: "rate_limited",
      },
    });
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  let session: Awaited<ReturnType<typeof loginWithPassword>>;
  try {
    session = await loginWithPassword(email, password, request, 30, {
      correlationId,
      surface: "/team/login",
    });
  } catch {
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.password.login",
      outcome: "failed",
      correlationId,
      surface: "/team/login",
      metadata: {
        identityKind: "email",
        reasonCode: "session_creation_failed",
      },
    });
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
  if (!session) {
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.password.login",
      outcome: "denied",
      correlationId,
      surface: "/team/login",
      metadata: {
        identityKind: "email",
        reasonCode: "invalid_credentials",
      },
    });
    return NextResponse.json(
      { ok: false, error: "invalid_credentials" },
      { status: 401 },
    );
  }

  return NextResponse.json({
    ok: true,
    sessionToken: session.sessionToken,
    teamMember: session.teamMember,
  });
}
