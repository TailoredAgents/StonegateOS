import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  findPartnerJoinRequest,
  withdrawPartnerJoinRequest,
} from "@/lib/partner-portal-onboarding";
import {
  createPortalV2ErrorResponse,
  createPortalV2IdempotencyErrorResponse,
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
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
import {
  isAllowedPartnerPortalMutationOrigin,
  isPortalV2Uuid,
} from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

type RouteContext = { params: Promise<{ requestId?: string }> };

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
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
    const requestId = (await context.params).requestId?.trim();
    if (!isPortalV2Uuid(requestId)) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const current = await findPartnerJoinRequest(
      authorization.principal.partnerUserId,
      requestId,
    );
    if (!current) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    if (current.status === "withdrawn") {
      return createPartnerPortalV2StoredResponse(
        {
          status: 200,
          body: {
            ok: true,
            joinRequest: {
              id: current.id,
              status: current.status,
              version: current.version,
            },
          },
          headers: {
            ETag: createPortalV2StrongEtag(`${current.id}:${current.version}`),
          },
        },
        correlationId,
      );
    }
    if (
      !["submitted", "under_review", "needs_information"].includes(
        current.status,
      )
    ) {
      return createPartnerPortalV2ErrorResponse("conflict", 409, correlationId);
    }
    const precondition = evaluatePortalV2RevisionPrecondition({
      ifMatch: request.headers.get("if-match"),
      currentRevision: `${current.id}:${current.version}`,
      correlationId,
    });
    if (!precondition.ok) {
      return createPartnerPortalV2DescriptorResponse(precondition.response);
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
      action: "partner.company_join_request.withdraw",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/company-join-requests/${requestId}/withdraw`,
      payload: { version: current.version },
      correlationId,
      execute: async () => {
        const updated = await withdrawPartnerJoinRequest({
          partnerUserId: authorization.principal.partnerUserId,
          requestId,
          expectedVersion: current.version,
          sessionId: authorization.principal.session.id,
          correlationId,
          idempotencyKeyHash: idempotency.keyHash!,
        });
        if (!updated)
          return {
            status: 412,
            body: { ok: false, error: "revision_mismatch" },
          };
        return {
          status: 200,
          body: {
            ok: true,
            joinRequest: {
              id: updated.id,
              status: updated.status,
              version: updated.version,
            },
          },
          headers: {
            ETag: createPortalV2StrongEtag(`${updated.id}:${updated.version}`),
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
