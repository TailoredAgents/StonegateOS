import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { confirmPartnerEmailChange } from "@/lib/partner-email-change";
import { arePartnerPurposeAuthTokensEnabled } from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
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
        maximumBytes: 1_024,
        deadlineMs: 10_000,
        rejectDuplicateObjectKeys: true,
      });
    } catch (error) {
      const bounded = error instanceof BoundedJsonRequestError ? error : null;
      return createPartnerPortalV2ErrorResponse(
        bounded?.code === "invalid_body" ? "invalid_body" : "invalid_request",
        bounded?.status ?? 400,
        correlationId,
      );
    }
    const record =
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Object.keys(raw).every((key) => key === "token")
        ? (raw as Record<string, unknown>)
        : null;
    const token =
      typeof record?.["token"] === "string" ? record["token"].trim() : "";
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
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
      action: "partner_email_change_confirm",
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
      principal: `email-change-token:${fingerprint}`,
      action: "partner.auth.email_change.confirm",
      keyHash: idempotency.keyHash!,
      scope: "POST:/api/portal/v2/onboarding/email-change/confirm",
      payload: { tokenFingerprint: fingerprint },
      correlationId,
      execute: async () => {
        const result = await confirmPartnerEmailChange({
          rawToken: token,
          request,
          correlationId,
        });
        if (result.kind === "success") {
          return {
            status: 200,
            body: {
              ok: true,
              emailChanged: true,
              changedAt: result.changedAt.toISOString(),
              sessionsRevoked: result.sessionsRevoked,
              autoLogin: false,
            },
          };
        }
        if (result.kind === "reconciliation_required") {
          return {
            status: 409,
            body: {
              ok: false,
              error: "change_unavailable",
              message:
                "This email change could not be completed safely. Contact Stonegate support.",
            },
          };
        }
        return {
          status: result.kind === "expired" ? 410 : 401,
          body: {
            ok: false,
            error: "invalid_or_expired",
            message:
              "This confirmation link is invalid or expired. Request a new change from account settings.",
          },
        };
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
