import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  createVerifiedDomainJoinRequest,
  listPartnerJoinRequests,
  parsePartnerJoinRequest,
} from "@/lib/partner-portal-onboarding";
import {
  createPortalV2ErrorResponse,
  createPortalV2IdempotencyErrorResponse,
  createPortalV2StrongEtag,
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

function serializeJoin(
  row: Awaited<ReturnType<typeof listPartnerJoinRequests>>[number],
) {
  return {
    id: row.id,
    account: { id: row.accountId, name: row.accountName },
    requestedRoleKey: row.requestedRoleKey,
    message: row.message,
    status: row.status,
    version: row.version,
    requestedAt: row.requestedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    etag: createPortalV2StrongEtag(`${row.id}:${row.version}`),
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
    const requests = await listPartnerJoinRequests(
      authorization.principal.partnerUserId,
    );
    return createPartnerPortalV2SuccessResponse(
      { ok: true, joinRequests: requests.map(serializeJoin) },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
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
    const payload = parsePartnerJoinRequest(raw);
    if (!payload) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_join_request",
      request,
      identity: {
        kind: "partner_user",
        value: authorization.principal.partnerUserId,
      },
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
      principal: `partner-user:${authorization.principal.partnerUserId}`,
      action: "partner.company_join_request.create",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/company-join-requests:${payload.accountId}`,
      payload,
      correlationId,
      execute: async () => {
        const created = await createVerifiedDomainJoinRequest({
          partnerUserId: authorization.principal.partnerUserId,
          email: authorization.principal.email,
          accountId: payload.accountId,
          requestedRoleKey: payload.requestedRoleKey,
          message: payload.message,
          sessionId: authorization.principal.session.id,
          correlationId,
          idempotencyKeyHash: idempotency.keyHash!,
        });
        if (created === "domain_mismatch") {
          return { status: 403, body: { ok: false, error: "forbidden" } };
        }
        if (created === "already_member") {
          return { status: 409, body: { ok: false, error: "conflict" } };
        }
        if (!created) {
          return {
            status: 503,
            body: { ok: false, error: "service_unavailable" },
          };
        }
        return {
          status: 202,
          body: { ok: true, joinRequest: serializeJoin(created) },
          headers: {
            ETag: createPortalV2StrongEtag(`${created.id}:${created.version}`),
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
