import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerNotificationEndpointMutationAccess } from "@/lib/partner-notification-endpoint-authorization";
import {
  completePartnerNotificationEndpointVerification,
  PartnerNotificationEndpointConfigurationError,
  partnerNotificationSensitiveFingerprint,
  PARTNER_SMS_CONSENT_VERSION,
} from "@/lib/partner-notification-endpoints";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPortalV2ErrorResponse,
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

type RouteContext = { params: Promise<{ endpointId?: string }> };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseRequest(value: unknown): {
  code: string;
  consentAccepted: true;
  consentVersion: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
      ["code", "consentAccepted", "consentVersion"].sort().join("\0") ||
    typeof record["code"] !== "string" ||
    !/^\d{6}$/u.test(record["code"]) ||
    record["consentAccepted"] !== true ||
    record["consentVersion"] !== PARTNER_SMS_CONSENT_VERSION
  ) {
    return null;
  }
  return {
    code: record["code"],
    consentAccepted: true,
    consentVersion: record["consentVersion"],
  };
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization =
      await requirePartnerNotificationEndpointMutationAccess(request);
    if (!authorization.ok) {
      return createPartnerPortalV2ErrorResponse(
        authorization.error,
        authorization.status,
        correlationId,
      );
    }
    if (!isAllowedPartnerPortalMutationOrigin(request)) {
      return createPartnerPortalV2ErrorResponse(
        "forbidden",
        403,
        correlationId,
      );
    }
    const endpointId = (await context.params).endpointId?.trim().toLowerCase();
    if (!endpointId || !UUID_PATTERN.test(endpointId)) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const { accountId, membershipId, partnerUserId, session } =
      authorization.principal;
    if (!accountId || !membershipId) {
      return createPartnerPortalV2ErrorResponse(
        "legacy_scope_unavailable",
        409,
        correlationId,
      );
    }
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
      );
    }
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
    const payload = parseRequest(raw);
    if (!payload) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${partnerUserId}:membership:${membershipId}`,
      action: "partner.notification_endpoint.verify",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/notification-endpoints/${accountId}:${membershipId}:${endpointId}/verify`,
      payload: {
        consentVersion: payload.consentVersion,
        codeFingerprint: partnerNotificationSensitiveFingerprint(payload.code),
      },
      correlationId,
      execute: async () => {
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_notification_endpoint_verify",
          request,
          identity: { kind: "partner_user", value: partnerUserId },
        });
        if (rateLimit.limited) {
          return {
            status: 429,
            body: { ok: false, error: "rate_limited" },
            headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
          };
        }
        if (!arePartnerPortalV2WritesEnabled(accountId)) {
          return {
            status: 503,
            body: { ok: false, error: "service_unavailable" },
          };
        }
        const result = await completePartnerNotificationEndpointVerification({
          actor: {
            partnerUserId,
            accountId,
            membershipId,
            sessionId: session.id,
            correlationId,
            idempotencyKeyHash: idempotency.keyHash!,
          },
          endpointId,
          code: payload.code,
          consentAccepted: payload.consentAccepted,
          consentVersion: payload.consentVersion,
        });
        return result.kind === "verified"
          ? { status: 200, body: { ok: true, endpoint: result.endpoint } }
          : { status: 422, body: { ok: false, error: "invalid_fields" } };
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
    if (error instanceof PartnerNotificationEndpointConfigurationError) {
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
