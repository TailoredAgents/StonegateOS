import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { isAllowedTeamMutationOrigin } from "@/lib/team-mutation";
import {
  enforceTeamMfaRateLimit,
  getTeamMfaCorrelationId,
  resolveTeamMfaActor,
  teamMfaError,
} from "@/lib/team-mfa-route";
import { stepUpTeamMfa } from "@/lib/team-mfa-service";

export async function POST(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "sessions.manage_self",
  );
  if (permissionError) return permissionError;
  const correlationId = getTeamMfaCorrelationId(request);
  if (!isAllowedTeamMutationOrigin(request)) {
    return teamMfaError(
      correlationId,
      403,
      "invalid_origin",
      "The security request origin could not be verified.",
    );
  }
  const resolved = await resolveTeamMfaActor(request);
  if (!resolved.ok) return resolved.response;
  const limited = await enforceTeamMfaRateLimit({
    action: "team_mfa_verification",
    request,
    actor: resolved.actor,
  });
  if (limited) return limited;
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const code = typeof body?.["code"] === "string" ? body["code"].trim() : "";
  const recoveryCode =
    typeof body?.["recoveryCode"] === "string"
      ? body["recoveryCode"].trim()
      : "";
  if (
    Boolean(code) === Boolean(recoveryCode) ||
    (code && !/^\d{6}$/u.test(code)) ||
    recoveryCode.length > 40
  ) {
    return teamMfaError(
      resolved.actor.correlationId,
      422,
      "invalid",
      "Enter either a six-digit authenticator code or one recovery code.",
      { fieldErrors: { mfa: "Use exactly one verification method." } },
    );
  }
  try {
    const result = await stepUpTeamMfa({
      actor: resolved.actor,
      ...(code ? { code } : { recoveryCode }),
    });
    if (result.kind !== "success") {
      const status =
        result.kind === "session_unavailable"
          ? 401
          : result.kind === "not_enrolled"
            ? 409
            : 422;
      return teamMfaError(
        resolved.actor.correlationId,
        status,
        result.kind,
        result.kind === "invalid_code"
          ? "That verification code was not accepted."
          : result.kind === "not_enrolled"
            ? "Set up an authenticator before verifying."
            : "Your Team session is no longer available.",
      );
    }
    return NextResponse.json(
      {
        ok: true,
        assuranceLevel: "aal2",
        verifiedAt: result.verifiedAt.toISOString(),
        recentMfaMaximumAgeSeconds: 900,
        recoveryCodeUsed: result.recoveryCodeUsed,
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "x-correlation-id": resolved.actor.correlationId,
        },
      },
    );
  } catch {
    return teamMfaError(
      resolved.actor.correlationId,
      503,
      "mfa_unavailable",
      "Multi-factor verification is temporarily unavailable.",
    );
  }
}
