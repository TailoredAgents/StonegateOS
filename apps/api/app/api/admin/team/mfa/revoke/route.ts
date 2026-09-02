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
import { revokeTeamMfa } from "@/lib/team-mfa-service";

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
    action: "team_mfa_revocation",
    request,
    actor: resolved.actor,
  });
  if (limited) return limited;
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (body?.["confirm"] !== "REMOVE") {
    return teamMfaError(
      resolved.actor.correlationId,
      422,
      "invalid",
      "Type REMOVE to disable your authenticator.",
      { fieldErrors: { confirm: "Type REMOVE exactly." } },
    );
  }
  try {
    const result = await revokeTeamMfa({ actor: resolved.actor });
    if (result.kind !== "success") {
      const status =
        result.kind === "session_unavailable"
          ? 401
          : result.kind === "recent_mfa_required"
            ? 403
            : 409;
      return teamMfaError(
        resolved.actor.correlationId,
        status,
        result.kind,
        result.kind === "recent_mfa_required"
          ? "Verify your authenticator before disabling it."
          : result.kind === "not_enrolled"
            ? "No active authenticator is enrolled."
            : "Your Team session is no longer available.",
      );
    }
    return NextResponse.json(
      { ok: true, revokedSessionCount: result.revokedSessionCount },
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
      "Authenticator removal is temporarily unavailable.",
    );
  }
}
