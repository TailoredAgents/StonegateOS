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
import { startTeamTotpEnrollment } from "@/lib/team-mfa-service";

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
    action: "team_mfa_enrollment",
    request,
    actor: resolved.actor,
  });
  if (limited) return limited;
  try {
    const result = await startTeamTotpEnrollment({ actor: resolved.actor });
    if (result.kind === "recent_mfa_required") {
      return teamMfaError(
        resolved.actor.correlationId,
        403,
        "mfa_step_up_required",
        "Verify your current authenticator before replacing it.",
        { fieldErrors: { mfa: "Complete multi-factor verification first." } },
      );
    }
    if (result.kind === "session_unavailable") {
      return teamMfaError(
        resolved.actor.correlationId,
        401,
        "unauthorized",
        "Your Team session is no longer available.",
      );
    }
    return NextResponse.json(
      {
        ok: true,
        enrollment: {
          challengeId: result.challengeId,
          secret: result.secret,
          otpauthUri: result.otpauthUri,
          expiresAt: result.expiresAt.toISOString(),
        },
      },
      {
        status: 201,
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
      "Authenticator enrollment is temporarily unavailable.",
    );
  }
}
