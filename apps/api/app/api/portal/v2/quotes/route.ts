import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import { listCanonicalPartnerQuotes } from "@/lib/partner-portal-v2-quotes";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import {
  createPortalV2ErrorResponse,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";

export async function GET(request: NextRequest): Promise<Response> {
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
  if (!principal.accountId || !principal.membershipId) {
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
    const result = await listCanonicalPartnerQuotes({
      principal,
      params: request.nextUrl.searchParams,
    });
    if (!result.ok) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse(result.error, correlationId, {
          status: result.status,
          fieldErrors: result.fieldErrors,
        }),
      );
    }
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        data: result.items,
        quotes: result.items,
        page: {
          limit: result.limit,
          nextCursor: result.nextCursor,
          hasMore: Boolean(result.nextCursor),
        },
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
