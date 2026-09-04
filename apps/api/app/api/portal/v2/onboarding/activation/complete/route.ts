import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { PARTNER_PASSWORD_MAX_LENGTH } from "@/lib/partner-password-management";
import { arePartnerPurposeAuthTokensEnabled } from "@/lib/partner-portal-feature-flags";
import { completePartnerActivation } from "@/lib/partner-purpose-auth";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

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
  // Validate the protocol key without persisting the returned bearer token in
  // the generic idempotency response store.
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
    );
  }
  try {
    let raw: unknown;
    try {
      raw = await readBoundedJsonRequest(request, {
        maximumBytes: 4_096,
        deadlineMs: 10_000,
        rejectDuplicateObjectKeys: true,
      });
    } catch (error) {
      const failure = error instanceof BoundedJsonRequestError ? error : null;
      return createPartnerPortalV2ErrorResponse(
        failure?.code === "invalid_body" ? "invalid_body" : "invalid_request",
        failure?.status ?? 400,
        correlationId,
      );
    }
    const record =
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Object.keys(raw).every((key) =>
        ["token", "password", "confirmPassword", "rememberMe"].includes(key),
      )
        ? (raw as Record<string, unknown>)
        : null;
    const token =
      typeof record?.["token"] === "string" ? record["token"].trim() : "";
    const password =
      typeof record?.["password"] === "string" ? record["password"] : "";
    const confirmPassword =
      typeof record?.["confirmPassword"] === "string"
        ? record["confirmPassword"]
        : "";
    const rememberMe = record?.["rememberMe"] === true;
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
      password.length < 1 ||
      password.length > PARTNER_PASSWORD_MAX_LENGTH ||
      password !== confirmPassword ||
      (record?.["rememberMe"] !== undefined &&
        typeof record["rememberMe"] !== "boolean")
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
    const result = await completePartnerActivation({
      rawToken: token,
      password,
      rememberMe,
      request,
      correlationId,
    });
    if (result.kind !== "success") {
      return createPartnerPortalV2ErrorResponse(
        result.kind === "invalid"
          ? "unauthorized"
          : result.kind === "password_policy"
            ? "invalid_fields"
            : "service_unavailable",
        result.kind === "invalid"
          ? 401
          : result.kind === "password_policy"
            ? 422
            : 503,
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt.toISOString(),
        nextAction: "portal_ready",
        authority: "portal",
        persistent: rememberMe,
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
