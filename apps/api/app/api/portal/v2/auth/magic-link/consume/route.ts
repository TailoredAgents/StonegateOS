import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { markPartnerEmailVerified } from "@/lib/partner-portal-onboarding";
import { exchangePartnerLoginToken } from "@/lib/partner-portal-auth";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  try {
    let payload: unknown;
    try {
      payload = await readBoundedJsonRequest(request, {
        maximumBytes: 1_024,
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
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      Object.keys(payload).every((key) => ["token", "rememberMe"].includes(key))
        ? (payload as Record<string, unknown>)
        : null;
    const token =
      typeof record?.["token"] === "string" ? record["token"].trim() : "";
    const rememberMe = record?.["rememberMe"] === true;
    if (
      record?.["rememberMe"] !== undefined &&
      typeof record["rememberMe"] !== "boolean"
    ) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    const tokenFingerprint = createHash("sha256")
      .update(token, "utf8")
      .digest("hex");
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_magic_link_exchange",
      request,
      identity: { kind: "token", value: tokenFingerprint },
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
    const result = await exchangePartnerLoginToken(
      token,
      request,
      rememberMe ? 30 : 0.5,
    );
    if (!result) {
      return createPartnerPortalV2ErrorResponse(
        "unauthorized",
        401,
        correlationId,
      );
    }
    // Never strand a consumed one-use token if this ancillary verification
    // projection is temporarily unavailable; the session itself proves the
    // mailbox challenge and a later successful login can repair the marker.
    await markPartnerEmailVerified(result.partnerUserId).catch(() => undefined);
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        sessionToken: result.sessionToken,
        needsPasswordSetup: result.needsPasswordSetup,
        expiresAt: result.expiresAt.toISOString(),
        persistent: rememberMe,
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
