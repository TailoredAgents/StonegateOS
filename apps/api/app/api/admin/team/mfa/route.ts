import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { resolveTeamMfaActor, teamMfaError } from "@/lib/team-mfa-route";
import { getTeamMfaStatus } from "@/lib/team-mfa-service";

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "sessions.manage_self",
  );
  if (permissionError) return permissionError;
  const resolved = await resolveTeamMfaActor(request, {
    allowBreakGlass: true,
    requireEmail: false,
  });
  if (!resolved.ok) return resolved.response;
  try {
    const status = await getTeamMfaStatus({
      teamMemberId: resolved.actor.teamMemberId,
      sessionId: resolved.actor.sessionId,
    });
    return NextResponse.json(
      {
        ok: true,
        security: {
          ...status,
          configurationAllowed: resolved.authMethod === "team_session",
          recentMfaMaximumAgeSeconds: 900,
        },
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
      "Team security status is temporarily unavailable.",
    );
  }
}
