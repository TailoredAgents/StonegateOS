import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { normalizeEmail } from "@/lib/partner-portal-auth";
import { arePartnerPurposeAuthTokensEnabled } from "@/lib/partner-portal-feature-flags";
import { requestPartnerEmailVerification } from "@/lib/partner-purpose-auth";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
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
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Object.keys(raw).length === 1
        ? (raw as Record<string, unknown>)
        : null;
    const email = normalizeEmail(record?.["email"]);
    if (
      !email ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
    ) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_email_verification_request",
      request,
      identity: { kind: "email", value: email },
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
      principal: `public-email-verification:${email}`,
      action: "partner.auth.email_verification.request",
      keyHash: idempotency.keyHash!,
      scope: "POST:/api/portal/v2/onboarding/email-challenges",
      payload: { email },
      correlationId,
      execute: async () => {
        await requestPartnerEmailVerification({
          email,
          request,
          correlationId,
        });
        return {
          status: 202,
          body: {
            ok: true,
            message:
              "If the address can receive mail, a 30-minute verification link will be sent.",
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
