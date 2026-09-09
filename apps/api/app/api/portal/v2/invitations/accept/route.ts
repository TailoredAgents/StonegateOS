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
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { derivePartnerInvitationActivationToken } from "@/lib/partner-invitation-handoff";
import { inspectPartnerActivationToken } from "@/lib/partner-purpose-auth";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";

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
    if (!payload.success || !/^[A-Za-z0-9_-]{43}$/u.test(payload.data.token)) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
      );
    }
    const tokenFingerprint = createHash("sha256")
      .update(payload.data.token, "utf8")
      .digest("hex");
    // The invitation transaction is intrinsically one-use. Do not persist a
    // generic response replay: a cached rate limit/provider failure would
    // strand this same-token retry, and credential handoffs must be revalidated.
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_invitation_accept",
      request,
      identity: { kind: "token", value: tokenFingerprint },
    });
    if (rateLimit.limited) {
      return createPartnerPortalV2StoredResponse(
        {
          status: 429,
          body: { ok: false, error: "rate_limited" },
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
        correlationId,
      );
    }
    const accepted = await acceptPartnerAccountInvitation({
      token: payload.data.token,
      correlationId,
    });
    // A lost first response may safely resume the already-created handoff,
    // but only while its current issuer/account/scopes/security still permit it.
    const retry = accepted
      ? null
      : await inspectPartnerActivationToken(
          derivePartnerInvitationActivationToken(payload.data.token),
        );
    const activationExpiresAt =
      accepted?.activationExpiresAt ??
      (retry?.kind === "success" ? retry.expiresAt.toISOString() : null);
    if (!activationExpiresAt) {
      return createPartnerPortalV2ErrorResponse(
        "unauthorized",
        401,
        correlationId,
      );
    }
    return createPartnerPortalV2StoredResponse(
      {
        status: 202,
        body: {
          ok: true,
          activationRequired: true,
          deliveryStatus: "ready",
          activationExpiresAt,
        },
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
