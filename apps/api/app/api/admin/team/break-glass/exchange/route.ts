import type { ActionPolicy } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import {
  createBreakGlassTeamSession,
  getClientIp,
  type BreakGlassSessionType,
} from "@/lib/team-auth";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import {
  beginTeamMutation,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationSuccessResponse,
} from "@/lib/team-mutation";

function parseSessionType(value: unknown): BreakGlassSessionType | null {
  return value === "owner" || value === "crew" ? value : null;
}

function safeHeaderValue(
  value: string | null,
  maxLength: number,
): string | null {
  const normalized = [...(value?.trim() ?? "")]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("");
  return normalized.length > 0 ? normalized.slice(0, maxLength) : null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["service"],
    requiredPermissions: ["access.break_glass"],
    risk: "normal",
    requiresIdempotency: false,
    auditAction: "team.break_glass.session_created",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;

  const payload = (await request.json().catch(() => null)) as {
    legacyType?: unknown;
  } | null;
  const sessionType = parseSessionType(payload?.legacyType);

  let rateLimit: { limited: boolean; retryAfterSeconds: number };
  try {
    rateLimit = await consumeTeamAuthRateLimit({
      action: "break_glass_exchange",
      request,
      identity: {
        kind: "break_glass",
        value: sessionType ?? "invalid",
      },
    });
  } catch {
    return teamMutationErrorResponse(
      "internal",
      "Recovery is temporarily unavailable. Try again later.",
      {
        status: 503,
        retryable: true,
        retryAfter: "60",
        correlationId: boundary.mutation.correlationId,
      },
    );
  }
  if (rateLimit.limited) {
    return teamMutationErrorResponse(
      "rate_limited",
      "Recovery is temporarily unavailable. Try again later.",
      {
        retryable: true,
        retryAfter: String(rateLimit.retryAfterSeconds),
        correlationId: boundary.mutation.correlationId,
      },
    );
  }

  // The Site intentionally sends `invalid` after performing constant-time
  // legacy-cookie checks. It still consumes the same durable rate-limit path,
  // but it can never select a member or create a session.
  if (!sessionType) {
    return teamMutationErrorResponse(
      "unauthorized",
      "Recovery could not be completed.",
      { correlationId: boundary.mutation.correlationId },
    );
  }

  try {
    const result = await createBreakGlassTeamSession({
      sessionType,
      clientIp: safeHeaderValue(getClientIp(request), 128),
      userAgent: safeHeaderValue(
        request.headers.get("x-team-client-user-agent"),
        512,
      ),
      audit: boundary.mutation.audit,
    });
    if (!result) {
      return teamMutationErrorResponse(
        "internal",
        "Recovery is temporarily unavailable. Try again later.",
        {
          status: 503,
          retryable: false,
          correlationId: boundary.mutation.correlationId,
        },
      );
    }

    return teamMutationSuccessResponse(
      boundary.mutation,
      {
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt.toISOString(),
      },
      {
        auditEventId: result.auditEventId,
        committedAt: result.committedAt,
        entityType: "team_session",
        entityId: result.sessionId,
      },
      201,
    );
  } catch (error) {
    return teamMutationExceptionResponse(error, boundary.mutation);
  }
}
