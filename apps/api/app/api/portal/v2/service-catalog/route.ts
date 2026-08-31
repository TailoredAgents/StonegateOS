import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { listPartnerServiceCatalog } from "@/lib/partner-portal-v2-service-catalog";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";

/**
 * Returns scheduling-safe service and quantity add-on choices. Negotiated
 * amounts remain conditional on rates.read; limited applicants receive the
 * same configurable scope choices but pricing is hidden and review-based.
 */
export async function GET(request: NextRequest): Promise<Response> {
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
    const canSchedule =
      authorization.principal.capabilities.includes("bookings.create");
    const canReadRates =
      authorization.principal.capabilities.includes("rates.read");
    if (!canSchedule && !canReadRates) {
      return createPartnerPortalV2ErrorResponse(
        "forbidden",
        403,
        correlationId,
      );
    }
    const accountId = authorization.principal.accountId;
    if (!accountId) {
      return createPartnerPortalV2ErrorResponse(
        "legacy_scope_unavailable",
        409,
        correlationId,
      );
    }
    if (!arePartnerPortalV2ReadsEnabled(accountId)) {
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }

    const services = await listPartnerServiceCatalog({
      accountId,
      revealPrices: canReadRates,
    });

    return createPartnerPortalV2SuccessResponse(
      { ok: true, services },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
