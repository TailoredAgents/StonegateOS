import { createHash, createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  PARTNER_PASSWORD_MAX_LENGTH,
  PARTNER_PASSWORD_MIN_LENGTH,
} from "@/lib/partner-password-management";
import { arePartnerPurposeAuthTokensEnabled } from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { completePartnerPasswordReset } from "@/lib/partner-purpose-auth";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
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
        ["token", "newPassword", "confirmPassword"].includes(key),
      )
        ? (raw as Record<string, unknown>)
        : null;
    const token =
      typeof record?.["token"] === "string" ? record["token"].trim() : "";
    const password =
      typeof record?.["newPassword"] === "string" ? record["newPassword"] : "";
    const confirmation =
      typeof record?.["confirmPassword"] === "string"
        ? record["confirmPassword"]
        : "";
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
      password.length < PARTNER_PASSWORD_MIN_LENGTH ||
      password.length > PARTNER_PASSWORD_MAX_LENGTH ||
      password !== confirmation
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
      action: "partner_password_reset",
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
    const run = await runPortalV2IdempotentMutation({
      principal: `password-reset-token:${fingerprint}`,
      action: "partner.auth.password_reset.complete",
      keyHash: idempotency.keyHash!,
      scope: "POST:/api/portal/v2/onboarding/password-recovery/complete",
      payload: {
        tokenFingerprint: fingerprint,
        passwordRequestFingerprint: createHmac("sha256", token)
          .update(password, "utf8")
          .digest("hex"),
      },
      correlationId,
      execute: async () => {
        const result = await completePartnerPasswordReset({
          rawToken: token,
          password,
          request,
          correlationId,
        });
        return result.kind === "success"
          ? { status: 200, body: { ok: true } }
          : { status: 401, body: { ok: false, error: "unauthorized" } };
      },
    });
    if (run.kind === "conflict") {
      return createPartnerPortalV2ErrorResponse(
        run.reason === "different_request"
          ? "idempotency_conflict"
          : "conflict",
        409,
        correlationId,
      );
    }
    return createPartnerPortalV2StoredResponse(run.result, correlationId);
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
