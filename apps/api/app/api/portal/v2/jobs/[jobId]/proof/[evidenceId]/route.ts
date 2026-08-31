import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { hasPartnerJobAccess } from "@/lib/partner-portal-v2-resource-authorization";
import {
  PartnerPortalMediaError,
  softDeletePartnerMedia,
} from "@/lib/partner-portal-v2-media";
import {
  isAllowedPartnerPortalMutationOrigin,
  isPortalV2Uuid,
} from "@/lib/partner-portal-v2-security";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ jobId: string; evidenceId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(request, "media.upload");
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { jobId, evidenceId } = await context.params;
  if (
    !principal.accountId ||
    !isPortalV2Uuid(jobId) ||
    !isPortalV2Uuid(evidenceId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    if (!(await hasPartnerJobAccess(principal, jobId))) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const deleted = await softDeletePartnerMedia({
      parentKind: "job",
      parentId: jobId,
      associationId: evidenceId,
      principal,
    });
    return createPartnerPortalV2SuccessResponse(
      { ok: true, deleted },
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
