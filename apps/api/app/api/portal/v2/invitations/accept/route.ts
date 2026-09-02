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
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import {
  createPortalV2ErrorResponse,
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
    if (!payload.success || !/^[A-Za-z0-9_-]{32,256}$/u.test(payload.data.token)) {
      return createPartnerPortalV2ErrorResponse("invalid_fields", 422, correlationId);
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
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-invitation:${tokenFingerprint}`,
      action: "partner.account_invitation.accept",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/invitations/accept:${tokenFingerprint}`,
      payload: { tokenFingerprint },
      correlationId,
      execute: async () => {
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_invitation_accept",
          request,
          identity: { kind: "token", value: tokenFingerprint },
        });
        if (rateLimit.limited) {
          return {
            status: 429,
            body: { ok: false, error: "rate_limited" },
            headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
          };
        }
        const accepted = await acceptPartnerAccountInvitation({
          token: payload.data.token,
          correlationId,
        });
        if (!accepted) {
          return { status: 401, body: { ok: false, error: "unauthorized" } };
        }
        return {
          status: 202,
          body: {
            ok: true,
            activationRequired: accepted.activationRequired,
            deliveryStatus: accepted.deliveryStatus,
          },
        };
      },
    });
    if (run.kind === "conflict") {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse(
          run.reason === "different_request"
            ? "idempotency_conflict"
            : "conflict",
          correlationId,
        ),
      );
    }
    return createPartnerPortalV2StoredResponse(run.result, correlationId);
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
