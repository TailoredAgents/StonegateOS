import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { startPartnerActivationMfa } from "@/lib/partner-activation-mfa-auth";
import { arePartnerPurposeAuthTokensEnabled } from "@/lib/partner-portal-feature-flags";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

function bearerToken(request: NextRequest): string {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : "";
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!arePartnerPurposeAuthTokensEnabled()) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const token = bearerToken(request);
  if (!token) {
    return createPartnerPortalV2ErrorResponse(
      "unauthorized",
      401,
      correlationId,
    );
  }
  try {
    let body: unknown;
    try {
      body = await readBoundedJsonRequest(request, {
        maximumBytes: 512,
        deadlineMs: 10_000,
        rejectDuplicateObjectKeys: true,
      });
    } catch (error) {
      const failure = error instanceof BoundedJsonRequestError ? error : null;
      return createPartnerPortalV2ErrorResponse(
        "invalid_body",
        failure?.status ?? 400,
        correlationId,
      );
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0
    ) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    const fingerprint = createHash("sha256")
      .update(token, "utf8")
      .digest("hex");
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_activation",
      request,
      identity: { kind: "token", value: fingerprint },
    });
    if (rateLimit.limited) {
      const response = createPartnerPortalV2ErrorResponse(
        "rate_limited",
        429,
        correlationId,
      );
      response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return response;
    }
    const result = await startPartnerActivationMfa({
      transactionToken: token,
      request,
      correlationId,
    });
    if (result.kind === "invalid_transaction") {
      return createPartnerPortalV2ErrorResponse(
        "unauthorized",
        401,
        correlationId,
      );
    }
    if (result.kind === "expired") {
      return createPartnerPortalV2ErrorResponse(
        "session_expired",
        410,
        correlationId,
      );
    }
    if (result.kind === "verification_required") {
      return createPartnerPortalV2SuccessResponse(
        {
          ok: true,
          mode: "verify",
          expiresAt: result.expiresAt.toISOString(),
          methods: ["totp", "recovery_code"],
        },
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        mode: "enroll",
        enrollment: {
          challengeId: result.challengeId,
          secret: result.secret,
          otpauthUri: result.otpauthUri,
          expiresAt: result.expiresAt.toISOString(),
        },
      },
      correlationId,
      201,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
