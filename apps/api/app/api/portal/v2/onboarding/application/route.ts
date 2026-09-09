import type { NextRequest } from "next/server";
import { arePartnerPurposeAuthTokensEnabled } from "@/lib/partner-portal-feature-flags";
import { requirePartnerApplicantSession } from "@/lib/partner-purpose-auth";
import { getPartnerApplicantApplication } from "@/lib/partner-verification-onboarding";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { partnerAccessWorkflowRetired } from "@/lib/partner-access-retirement";
function unavailable(correlationId: string) {
  return createPartnerPortalV2ErrorResponse(
    "service_unavailable",
    503,
    correlationId,
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!arePartnerPurposeAuthTokensEnabled()) return unavailable(correlationId);
  try {
    const authorization = await requirePartnerApplicantSession(request);
    if (!authorization.ok) {
      return createPartnerPortalV2ErrorResponse(
        authorization.error,
        authorization.status,
        correlationId,
      );
    }
    const view = await getPartnerApplicantApplication(authorization.principal);
    return createPartnerPortalV2SuccessResponse(
      { ok: true, ...view },
      correlationId,
      200,
      { ETag: view.etag },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export function PATCH(request: NextRequest): Response {
  return partnerAccessWorkflowRetired(request);
}
