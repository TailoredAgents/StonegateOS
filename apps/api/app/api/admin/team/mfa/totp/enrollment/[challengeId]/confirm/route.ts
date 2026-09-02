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
import { confirmTeamTotpEnrollment } from "@/lib/team-mfa-service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ challengeId: string }> },
): Promise<Response> {
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
  const { challengeId } = await context.params;
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const code = typeof body?.["code"] === "string" ? body["code"].trim() : "";
  const label = typeof body?.["label"] === "string" ? body["label"].trim() : "";
  if (
    !UUID_PATTERN.test(challengeId) ||
    !/^\d{6}$/u.test(code) ||
    label.length > 80
  ) {
    return teamMfaError(
      resolved.actor.correlationId,
      422,
      "invalid",
      "Enter the current six-digit authenticator code.",
      { fieldErrors: { code: "Use a six-digit code." } },
    );
  }
  try {
    const result = await confirmTeamTotpEnrollment({
      actor: resolved.actor,
      challengeId,
      code,
      label: label || null,
    });
    if (result.kind !== "success") {
      const status =
        result.kind === "session_unavailable"
          ? 401
          : result.kind === "invalid_code"
            ? 422
            : 410;
      return teamMfaError(
        resolved.actor.correlationId,
        status,
        result.kind,
        result.kind === "invalid_code"
          ? "That authenticator code was not accepted."
          : result.kind === "expired"
            ? "This enrollment expired. Start again."
            : result.kind === "session_unavailable"
              ? "Your Team session is no longer available."
              : "This enrollment is no longer available.",
      );
    }
    return NextResponse.json(
      {
        ok: true,
        method: { id: result.methodId, type: "totp" },
        recoveryCodes: result.recoveryCodes,
        verifiedAt: result.verifiedAt.toISOString(),
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
      "Authenticator enrollment is temporarily unavailable.",
    );
  }
}
