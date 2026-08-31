import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  listPartnerSelfSessions,
  partnerSelfSessionVersion,
  revokePartnerSelfSession,
} from "@/lib/partner-portal-session-management";
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
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import {
  isAllowedPartnerPortalMutationOrigin,
  isPortalV2SessionHandle,
  portalV2SessionHandle,
  sessionHandlesEqual,
} from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";

type RouteContext = { params: Promise<{ sessionHandle?: string }> };

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
    const handle = (await context.params).sessionHandle?.trim();
    if (!isPortalV2SessionHandle(handle)) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const ifMatch = request.headers.get("if-match");
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${authorization.principal.partnerUserId}`,
      action: "partner.session.revoke",
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/sessions/${handle}/revoke`,
      payload: { ifMatch },
      correlationId,
      execute: async (): Promise<PortalV2StoredResult> => {
        const sessions = await listPartnerSelfSessions(
          authorization.principal.partnerUserId,
        );
        const target = sessions.find((session) =>
          sessionHandlesEqual(portalV2SessionHandle(session.id), handle),
        );
        if (!target) {
          return { status: 404, body: { ok: false, error: "not_found" } };
        }
        const version = partnerSelfSessionVersion(sessions);
        const precondition = evaluatePortalV2RevisionPrecondition({
          ifMatch,
          currentRevision: version,
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
          action: "partner_session_revoke",
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
        const revoked = target.revokedAt
          ? true
          : await revokePartnerSelfSession({
              partnerUserId: authorization.principal.partnerUserId,
              targetSessionId: target.id,
              actorSessionId: authorization.principal.session.id,
              correlationId,
              idempotencyKeyHash: idempotency.keyHash!,
            });
        if (!revoked) {
          return { status: 409, body: { ok: false, error: "conflict" } };
        }
        const nextSessions = await listPartnerSelfSessions(
          authorization.principal.partnerUserId,
        );
        return {
          status: 200,
          body: {
            ok: true,
            revoked: true,
            current: target.id === authorization.principal.session.id,
          },
          headers: {
            ETag: createPortalV2StrongEtag(
              partnerSelfSessionVersion(nextSessions),
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
