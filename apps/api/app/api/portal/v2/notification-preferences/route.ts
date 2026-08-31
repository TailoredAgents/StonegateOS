import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  listPartnerNotificationPreferences,
  parsePartnerNotificationPreference,
  partnerNotificationPreferenceRevision,
  savePartnerNotificationPreference,
  type PartnerNotificationPreference,
} from "@/lib/partner-notification-preferences";
import {
  createPortalV2ErrorResponse,
  createPortalV2IdempotencyErrorResponse,
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  runPortalV2IdempotentMutation,
  type PortalV2StoredResult,
} from "@/lib/partner-portal-v2-idempotency";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

function serialize(
  preference: PartnerNotificationPreference,
  membershipId: string,
) {
  return {
    eventKey: preference.eventKey,
    inAppEnabled: preference.inAppEnabled,
    emailEnabled: preference.emailEnabled,
    smsEnabled: preference.smsEnabled,
    smsOptInVerified: Boolean(preference.smsVerifiedOptInAt),
    quietHoursStart: preference.quietHoursStart,
    quietHoursEnd: preference.quietHoursEnd,
    timezone: preference.timezone,
    etag: createPortalV2StrongEtag(
      partnerNotificationPreferenceRevision({ preference, membershipId }),
    ),
  };
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
    const { accountId, membershipId } = authorization.principal;
    if (!accountId || !membershipId) {
      return createPartnerPortalV2ErrorResponse(
        "legacy_scope_unavailable",
        409,
        correlationId,
      );
    }
    const preferences = await listPartnerNotificationPreferences({
      accountId,
      membershipId,
    });
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        preferences: preferences.map((preference) =>
          serialize(preference, membershipId),
        ),
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
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
    if (!isAllowedPartnerPortalMutationOrigin(request)) {
      return createPartnerPortalV2ErrorResponse(
        "forbidden",
        403,
        correlationId,
      );
    }
    const { accountId, membershipId } = authorization.principal;
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
        maximumBytes: 2_048,
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
    const payload = parsePartnerNotificationPreference(raw);
    if (!payload) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    const ifMatch = request.headers.get("if-match");
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${authorization.principal.partnerUserId}`,
      action: "partner.notification_preference.update",
      keyHash: idempotency.keyHash!,
      scope: `PUT:/api/portal/v2/notification-preferences:${membershipId}:${payload.eventKey}`,
      payload: { preference: payload, ifMatch },
      correlationId,
      execute: async (): Promise<PortalV2StoredResult> => {
        const preferences = await listPartnerNotificationPreferences({
          accountId,
          membershipId,
        });
        const current = preferences.find(
          (preference) => preference.eventKey === payload.eventKey,
        );
        if (!current) {
          return { status: 404, body: { ok: false, error: "not_found" } };
        }
        const precondition = evaluatePortalV2RevisionPrecondition({
          ifMatch,
          currentRevision: partnerNotificationPreferenceRevision({
            preference: current,
            membershipId,
          }),
          correlationId,
        });
        if (!precondition.ok) {
          return {
            status: precondition.response.status,
            body: { ok: false, error: precondition.response.body.error },
            headers: { ETag: precondition.currentEtag },
          };
        }
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_notification_preferences",
          request,
          identity: {
            kind: "partner_user",
            value: authorization.principal.partnerUserId,
          },
        });
        if (rateLimit.limited) {
          return {
            status: 429,
            body: { ok: false, error: "rate_limited" },
            headers: {
              "Retry-After": String(rateLimit.retryAfterSeconds),
            },
          };
        }
        const saved = await savePartnerNotificationPreference({
          accountId,
          membershipId,
          partnerUserId: authorization.principal.partnerUserId,
          sessionId: authorization.principal.session.id,
          preference: payload,
          existing: current,
          correlationId,
          idempotencyKeyHash: idempotency.keyHash!,
        });
        if (saved === "sms_opt_in_required") {
          return { status: 422, body: { ok: false, error: "invalid_fields" } };
        }
        return {
          status: 200,
          body: { ok: true, preference: serialize(saved, membershipId) },
          headers: {
            ETag: createPortalV2StrongEtag(
              partnerNotificationPreferenceRevision({
                preference: saved,
                membershipId,
              }),
            ),
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
