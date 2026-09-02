import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { requireTeamSession } from "@/lib/team-auth";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import type { TeamMfaActor } from "@/lib/team-mfa-service";
import { isAdminRequest } from "../../app/api/web/admin";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export function getTeamMfaCorrelationId(request: NextRequest): string {
  const value = request.headers.get("x-correlation-id")?.trim() ?? "";
  return CORRELATION_ID_PATTERN.test(value) ? value : randomUUID();
}

export function teamMfaError(
  correlationId: string,
  status: number,
  code: string,
  message: string,
  options?: {
    retryAfterSeconds?: number;
    fieldErrors?: Record<string, string>;
  },
): NextResponse {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "x-correlation-id": correlationId,
  });
  if (options?.retryAfterSeconds) {
    headers.set("Retry-After", String(options.retryAfterSeconds));
  }
  return NextResponse.json(
    {
      ok: false,
      code,
      message,
      retryable: status === 429 || status >= 500,
      correlationId,
      ...(options?.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
    },
    { status, headers },
  );
}

export async function resolveTeamMfaActor(
  request: NextRequest,
  options: { allowBreakGlass?: boolean; requireEmail?: boolean } = {},
): Promise<
  | {
      ok: true;
      actor: TeamMfaActor;
      authMethod: "team_session" | "break_glass";
    }
  | { ok: false; response: NextResponse }
> {
  const correlationId = getTeamMfaCorrelationId(request);
  if (!isAdminRequest(request)) {
    return {
      ok: false,
      response: teamMfaError(
        correlationId,
        401,
        "unauthorized",
        "A valid Team session is required.",
      ),
    };
  }
  const permissionError = await requirePermission(
    request,
    "sessions.manage_self",
  );
  if (permissionError) {
    return {
      ok: false,
      response: teamMfaError(
        correlationId,
        permissionError.status === 401 ? 401 : 403,
        permissionError.status === 401 ? "unauthorized" : "forbidden",
        "Your Team access does not allow security settings.",
      ),
    };
  }
  const session = await requireTeamSession(request);
  if (!session.ok) {
    return {
      ok: false,
      response: teamMfaError(
        correlationId,
        401,
        "unauthorized",
        "Your Team session has expired or been revoked.",
      ),
    };
  }
  if (session.authMethod === "break_glass" && !options.allowBreakGlass) {
    return {
      ok: false,
      response: teamMfaError(
        correlationId,
        403,
        "break_glass_not_allowed",
        "Emergency recovery sessions cannot configure or verify an authenticator.",
      ),
    };
  }
  if (options.requireEmail !== false && !session.teamMember.email) {
    return {
      ok: false,
      response: teamMfaError(
        correlationId,
        422,
        "email_required",
        "Add a verified Team email before configuring an authenticator.",
      ),
    };
  }
  return {
    ok: true,
    authMethod: session.authMethod,
    actor: {
      teamMemberId: session.teamMember.id,
      email: session.teamMember.email ?? session.teamMember.id,
      roleSlug: session.teamMember.roleSlug,
      sessionId: session.sessionId,
      correlationId,
    },
  };
}

export async function enforceTeamMfaRateLimit(input: {
  action:
    | "team_mfa_enrollment"
    | "team_mfa_verification"
    | "team_mfa_revocation";
  request: NextRequest;
  actor: TeamMfaActor;
}): Promise<NextResponse | null> {
  const result = await consumeTeamAuthRateLimit({
    action: input.action,
    request: input.request,
    identity: { kind: "team_member", value: input.actor.teamMemberId },
  });
  return result.limited
    ? teamMfaError(
        input.actor.correlationId,
        429,
        "rate_limited",
        "Too many security attempts were made. Wait before trying again.",
        { retryAfterSeconds: result.retryAfterSeconds },
      )
    : null;
}
