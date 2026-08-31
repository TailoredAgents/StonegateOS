import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  hasPartnerAccountInvitation,
  mutatePartnerAccountInvitation,
  PartnerInvitationActionSchema,
} from "@/lib/partner-account-invitations";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin, isPortalV2Uuid } from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import {
  createPortalV2ErrorResponse,
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";

type RouteContext = { params: Promise<{ invitationId?: string }> };

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await requirePartnerCapability(request, "account.members.manage");
    if (!authorization.ok) return createPartnerPortalV2ErrorResponse(authorization.error, authorization.status, correlationId);
    if (!isAllowedPartnerPortalMutationOrigin(request)) return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
    const { principal } = authorization;
    if (!principal.accountId || !principal.membershipId) return createPartnerPortalV2ErrorResponse("legacy_scope_unavailable", 409, correlationId);
    if (principal.accessLevel !== "account") return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
    if (!arePartnerPortalV2WritesEnabled(principal.accountId)) return createPartnerPortalV2ErrorResponse("service_unavailable", 503, correlationId);
    if (request.nextUrl.search.length > 0) return createPartnerPortalV2ErrorResponse("invalid_request", 400, correlationId);
    const invitationId = (await context.params).invitationId?.trim();
    if (!isPortalV2Uuid(invitationId)) return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
    if (!(await hasPartnerAccountInvitation(principal.accountId, invitationId))) {
      return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
    }
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok) return createPartnerPortalV2DescriptorResponse(createPortalV2IdempotencyErrorResponse(idempotency, correlationId));
    let raw: unknown;
    try {
      raw = await readBoundedJsonRequest(request, { maximumBytes: 512, deadlineMs: 10_000, rejectDuplicateObjectKeys: true });
    } catch (error) {
      const failure = error instanceof BoundedJsonRequestError ? error : null;
      return createPartnerPortalV2ErrorResponse(failure?.code === "invalid_body" ? "invalid_body" : "invalid_request", failure?.status ?? 400, correlationId);
    }
    const payload = PartnerInvitationActionSchema.safeParse(raw);
    if (!payload.success) return createPartnerPortalV2ErrorResponse("invalid_fields", 422, correlationId);
    const ifMatch = request.headers.get("if-match");
    const run = await runPortalV2IdempotentMutation({
      principal: `partner-user:${principal.partnerUserId}:membership:${principal.membershipId}`,
      action: `partner.account_invitation.${payload.data.action}`,
      keyHash: idempotency.keyHash!,
      scope: `POST:/api/portal/v2/invitations/${invitationId}:${principal.accountId}`,
      payload: { action: payload.data.action, ifMatch },
      correlationId,
      execute: async () => {
        const rateLimit = await consumeTeamAuthRateLimit({
          action: "partner_invitation_management",
          request,
          identity: { kind: "partner_user", value: principal.partnerUserId },
        });
        if (rateLimit.limited) return { status: 429, body: { ok: false, error: "rate_limited" }, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } };
        return mutatePartnerAccountInvitation({
          principal,
          invitationId,
          action: payload.data.action,
          ifMatch,
          correlationId,
          idempotencyKeyHash: idempotency.keyHash!,
        });
      },
    });
    if (run.kind === "conflict") return createPartnerPortalV2DescriptorResponse(createPortalV2ErrorResponse(run.reason === "different_request" ? "idempotency_conflict" : "conflict", correlationId));
    return createPartnerPortalV2StoredResponse(run.result, correlationId);
  } catch (error) {
    console.error("[partner-portal-v2] invitation mutation failed", { correlationId, error: error instanceof Error ? error.name : "unknown" });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

