import type { NextRequest } from "next/server";
import { resolvePartnerPrincipal } from "@/lib/partner-account-authorization";
import { getPartnerMfaStatus } from "@/lib/partner-mfa-service";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const result = await resolvePartnerPrincipal(request);
  if (!result.ok) {
    return createPartnerPortalV2ErrorResponse(
      result.error,
      result.status,
      correlationId,
    );
  }
  if (
    result.principal.accountId &&
    !arePartnerPortalV2ReadsEnabled(result.principal.accountId)
  ) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    const status = await getPartnerMfaStatus(result.principal.partnerUserId);
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        security: {
          required: result.principal.security.mfaRequired,
          enrolled: status.enrolled,
          satisfied: result.principal.security.mfaSatisfied,
          assuranceLevel: result.principal.session.assuranceLevel,
          verifiedAt:
            result.principal.session.mfaVerifiedAt?.toISOString() ?? null,
        },
        methods: status.methods,
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
