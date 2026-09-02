import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import { getCanonicalPartnerQuote } from "@/lib/partner-portal-v2-quotes";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isPortalV2Uuid } from "@/lib/partner-portal-v2-security";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ partnerQuoteId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(request, "quotes.read");
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { partnerQuoteId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(partnerQuoteId)
  ) {
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
    const result = await getCanonicalPartnerQuote({
      principal,
      partnerQuoteId,
    });
    if (!result) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const response = createPartnerPortalV2SuccessResponse(
      { ok: true, data: result.quote, quote: result.quote },
      correlationId,
    );
    response.headers.set("ETag", result.etag);
    return response;
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
