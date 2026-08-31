import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import { hasPartnerDraftAccess } from "@/lib/partner-portal-v2-resource-authorization";
import {
  listPartnerMedia,
  PartnerPortalMediaError,
} from "@/lib/partner-portal-v2-media";
import { isPortalV2Uuid } from "@/lib/partner-portal-v2-security";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(request, "media.read");
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { draftId } = await context.params;
  if (!principal.accountId || !isPortalV2Uuid(draftId)) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    if (!(await hasPartnerDraftAccess(principal, draftId))) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const media = await listPartnerMedia({
      parentKind: "draft",
      parentId: draftId,
      principal,
    });
    return createPartnerPortalV2SuccessResponse(
      { ok: true, media },
      correlationId,
    );
  } catch (error) {
    if (error instanceof PartnerPortalMediaError) {
      return createPartnerPortalV2ErrorResponse(
        error.code,
        error.status,
        correlationId,
      );
    }
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
