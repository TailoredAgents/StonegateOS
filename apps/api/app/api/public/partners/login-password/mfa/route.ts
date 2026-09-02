import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { completePartnerPasswordMfa } from "@/lib/partner-password-mfa-auth";
import { resolvePartnerAuthCorrelationId } from "@/lib/partner-portal-auth";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

const TRANSACTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function response(
  correlationId: string,
  status: number,
  body: Record<string, unknown>,
  retryAfterSeconds?: number,
): NextResponse {
  return NextResponse.json(
    { ...body, correlationId },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "x-correlation-id": correlationId,
        ...(retryAfterSeconds
          ? { "Retry-After": String(retryAfterSeconds) }
          : {}),
      },
    },
  );
}

function bearerTransaction(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const token = authorization.slice(7).trim();
  return TRANSACTION_TOKEN_PATTERN.test(token) ? token : null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = resolvePartnerAuthCorrelationId(request);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return response(correlationId, 403, {
      ok: false,
      error: "invalid_origin",
      message: "The sign-in request origin could not be verified.",
    });
  }
  const transactionToken = bearerTransaction(request);
  if (!transactionToken) {
    return response(correlationId, 401, {
      ok: false,
      error: "invalid_or_expired_transaction",
      message: "This verification attempt is no longer available.",
    });
  }

  let rateLimit: { limited: boolean; retryAfterSeconds: number };
  try {
    rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_password_mfa",
      request,
      identity: { kind: "token", value: transactionToken },
    });
  } catch {
    return response(
      correlationId,
      503,
      {
        ok: false,
        error: "temporarily_unavailable",
        message: "Verification is temporarily unavailable.",
      },
      60,
    );
  }
  if (rateLimit.limited) {
    return response(
      correlationId,
      429,
      {
        ok: false,
        error: "rate_limited",
        message: "Too many verification attempts were made. Wait and retry.",
      },
      rateLimit.retryAfterSeconds,
    );
  }

  let payload: unknown;
  try {
    payload = await readBoundedJsonRequest(request, { maximumBytes: 2 * 1024 });
  } catch (error) {
    const failure =
      error instanceof BoundedJsonRequestError
        ? error
        : new BoundedJsonRequestError(
            "invalid_body",
            "The request could not be read.",
            400,
          );
    return response(correlationId, failure.status, {
      ok: false,
      error: failure.code,
      message: "Use a valid verification request.",
    });
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).some((key) => key !== "code" && key !== "recoveryCode")
  ) {
    return response(correlationId, 422, {
      ok: false,
      error: "invalid_request",
      message: "Enter one authenticator or recovery code.",
    });
  }
  const record = payload as Record<string, unknown>;
  const code = typeof record["code"] === "string" ? record["code"].trim() : "";
  const recoveryCode =
    typeof record["recoveryCode"] === "string"
      ? record["recoveryCode"].trim()
      : "";
  if (
    Boolean(code) === Boolean(recoveryCode) ||
    (code && !/^\d{6}$/u.test(code)) ||
    recoveryCode.length > 40
  ) {
    return response(correlationId, 422, {
      ok: false,
      error: "invalid_request",
      message: "Enter one six-digit authenticator code or recovery code.",
      fieldErrors: { mfa: "Use exactly one verification method." },
    });
  }

  try {
    const result = await completePartnerPasswordMfa({
      transactionToken,
      request,
      correlationId,
      ...(code ? { code } : { recoveryCode }),
    });
    if (result.kind === "success") {
      return response(correlationId, 200, {
        ok: true,
        status: "authenticated",
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt.toISOString(),
        assuranceLevel: "aal2",
        recoveryCodeUsed: result.recoveryCodeUsed,
      });
    }
    if (result.kind === "invalid_code") {
      return response(correlationId, result.attemptsRemaining ? 422 : 401, {
        ok: false,
        error: result.attemptsRemaining
          ? "invalid_mfa_code"
          : "mfa_attempts_exhausted",
        message: result.attemptsRemaining
          ? "That verification code was not accepted."
          : "This verification attempt is no longer available. Sign in again.",
        attemptsRemaining: result.attemptsRemaining,
      });
    }
    if (result.kind === "expired") {
      return response(correlationId, 410, {
        ok: false,
        error: "transaction_expired",
        message: "This verification attempt expired. Sign in again.",
      });
    }
    if (result.kind === "mfa_enrollment_required") {
      return response(correlationId, 409, {
        ok: false,
        error: "mfa_enrollment_required",
        message:
          "Authenticator setup is incomplete. Contact Stonegate support to recover access.",
        recovery: "contact_support",
      });
    }
    return response(correlationId, 401, {
      ok: false,
      error: "invalid_or_expired_transaction",
      message: "This verification attempt is no longer available.",
    });
  } catch {
    return response(
      correlationId,
      503,
      {
        ok: false,
        error: "temporarily_unavailable",
        message: "Verification is temporarily unavailable.",
      },
      60,
    );
  }
}
