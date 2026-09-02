import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { requirePartnerNotificationEndpointMutationAccess } from "@/lib/partner-notification-endpoint-authorization";
import {
  listPartnerNotificationEndpoints,
  normalizePartnerSmsDestination,
  PartnerNotificationEndpointConfigurationError,
  partnerNotificationSensitiveFingerprint,
  requestPartnerNotificationEndpointVerification,
} from "@/lib/partner-notification-endpoints";
import { arePartnerPortalOutboundNotificationsEnabled } from "@/lib/partner-portal-feature-flags";
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
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

function parseRequest(
  value: unknown,
): { channel: "sms"; phone: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== ["channel", "phone"].join("\0") ||
    record["channel"] !== "sms" ||
    !Object.prototype.hasOwnProperty.call(record, "phone") ||
    typeof record["phone"] !== "string"
  ) {
    return null;
  }
  const phone = normalizePartnerSmsDestination(record["phone"]);
  return phone ? { channel: "sms", phone } : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await requirePartnerCapability(
      request,
      "portal.session.read",
    );
    if (!authorization.ok) {
      return createPartnerPortalV2ErrorResponse(
        authorization.error,
        authorization.status,
        correlationId,
      );
    }
    const { accountId, membershipId, partnerUserId } = authorization.principal;
    if (!accountId || !membershipId) {
      return createPartnerPortalV2ErrorResponse(
        "legacy_scope_unavailable",
        409,
        correlationId,
      );
    }
    const endpoints = await listPartnerNotificationEndpoints({ partnerUserId });
    return createPartnerPortalV2SuccessResponse(
      { ok: true, endpoints },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
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
    const destinationFingerprint = partnerNotificationSensitiveFingerprint(
      payload.phone,
    );
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${partnerUserId}:membership:${membershipId}`,
      action: "partner.notification_endpoint.verification_request",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/notification-endpoints:${accountId}:${membershipId}`,
      payload: { channel: payload.channel, destinationFingerprint },
      correlationId,
      execute: async () => {
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_notification_endpoint_request",
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
        if (!arePartnerPortalOutboundNotificationsEnabled(accountId)) {
          return {
            status: 503,
            body: { ok: false, error: "service_unavailable" },
          };
        }
        const result = await requestPartnerNotificationEndpointVerification({
          actor: {
            partnerUserId,
            accountId,
            membershipId,
            sessionId: session.id,
            correlationId,
            idempotencyKeyHash: idempotency.keyHash!,
          },
          normalizedDestination: payload.phone,
        });
        if (result.kind === "binding_unavailable") {
          return { status: 404, body: { ok: false, error: "not_found" } };
        }
        if (result.kind === "cooldown") {
          return {
            status: 429,
            body: { ok: false, error: "rate_limited" },
            headers: {
              "Retry-After": String(result.retryAfterSeconds),
            },
          };
        }
        if (result.kind === "already_verified") {
          return {
            status: 200,
            body: { ok: true, endpoint: result.endpoint },
          };
        }
        return {
          status: 202,
          body: {
            ok: true,
            endpoint: result.endpoint,
            challenge: result.challenge,
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
