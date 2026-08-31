import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  acceptPartnerAccountInvitation,
  PartnerInvitationAcceptanceSchema,
} from "@/lib/partner-account-invitations";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  try {
    let raw: unknown;
    try {
      raw = await readBoundedJsonRequest(request, {
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
    const payload = PartnerInvitationAcceptanceSchema.safeParse(raw);
    if (!payload.success || !/^[A-Za-z0-9_-]{32,256}$/u.test(payload.data.token)) {
      return createPartnerPortalV2ErrorResponse("invalid_fields", 422, correlationId);
    }
    const tokenFingerprint = createHash("sha256")
      .update(payload.data.token, "utf8")
      .digest("hex");
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_invitation_accept",
      request,
      identity: { kind: "token", value: tokenFingerprint },
    });
    if (rateLimit.limited) {
      const response = createPartnerPortalV2ErrorResponse("rate_limited", 429, correlationId);
      response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return response;
    }
    const accepted = await acceptPartnerAccountInvitation({
      token: payload.data.token,
      request,
      correlationId,
      sessionDays: payload.data.rememberMe ? 30 : 0.5,
    });
    if (!accepted) {
      return createPartnerPortalV2ErrorResponse("unauthorized", 401, correlationId);
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        sessionToken: accepted.sessionToken,
        needsPasswordSetup: accepted.needsPasswordSetup,
        expiresAt: accepted.expiresAt.toISOString(),
        persistent: payload.data.rememberMe === true,
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
