import type { NextRequest } from "next/server";
import {
  PARTNER_PRIVACY_VERSION,
  PARTNER_TERMS_VERSION,
} from "@/lib/partner-portal-onboarding";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import { createPartnerPortalV2SuccessResponse } from "@/lib/partner-portal-v2-response";

export function GET(request: NextRequest): Response {
  const correlationId = readPortalV2CorrelationId(request.headers);
  return createPartnerPortalV2SuccessResponse(
    {
      ok: true,
      termsVersion: PARTNER_TERMS_VERSION,
      privacyVersion: PARTNER_PRIVACY_VERSION,
      partnerTypes: [
        "contractor",
        "real_estate_agent",
        "property_manager",
        "commercial_client",
        "other",
      ],
      limits: {
        serviceAreas: 20,
        requestedNeeds: 20,
        uploadBytes: 0,
      },
    },
    correlationId,
  );
}
