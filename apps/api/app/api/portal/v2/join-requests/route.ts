import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { listAccountJoinRequests } from "@/lib/partner-company-join-administration";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await requirePartnerCapability(request, "account.members.manage");
    if (!authorization.ok) return createPartnerPortalV2ErrorResponse(authorization.error, authorization.status, correlationId);
    const { principal } = authorization;
    if (!principal.accountId || !principal.membershipId) return createPartnerPortalV2ErrorResponse("legacy_scope_unavailable", 409, correlationId);
    if (principal.accessLevel !== "account") return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
    if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) return createPartnerPortalV2ErrorResponse("service_unavailable", 503, correlationId);
    const keys = [...request.nextUrl.searchParams.keys()];
    const rawLimit = request.nextUrl.searchParams.get("limit") ?? "50";
    if (keys.some((key) => key !== "limit") || request.nextUrl.searchParams.getAll("limit").length > 1) return createPartnerPortalV2ErrorResponse("invalid_request", 400, correlationId);
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return createPartnerPortalV2ErrorResponse("invalid_fields", 422, correlationId);
    const joinRequests = await listAccountJoinRequests({ principal, limit });
    return createPartnerPortalV2SuccessResponse({ ok: true, joinRequests }, correlationId);
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

