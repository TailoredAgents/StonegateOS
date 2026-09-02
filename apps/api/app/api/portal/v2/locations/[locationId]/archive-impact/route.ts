import type { NextRequest } from "next/server";
import { getDb, partnerAccountLocations } from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  getPartnerLocationArchiveImpact,
  lockPartnerLocationDirectory,
  partnerLocationDirectoryEtag,
} from "@/lib/partner-location-portfolio";
import { partnerLocationEtag } from "@/lib/partner-portal-v2-locations";
import { createPartnerLocationAccessCondition } from "@/lib/partner-portal-v2-resource-authorization";
import { isPortalV2Uuid } from "@/lib/partner-portal-v2-security";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

type RouteContext = { params: Promise<{ locationId: string }> };

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(
    request,
    "properties.manage",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { locationId } = await context.params;
  if (!principal.accountId || !isPortalV2Uuid(locationId)) {
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
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const account = await lockPartnerLocationDirectory(
        tx,
        principal.accountId!,
      );
      if (!account) return null;
      const [location] = await tx
        .select()
        .from(partnerAccountLocations)
        .where(createPartnerLocationAccessCondition(principal, locationId))
        .limit(1);
      if (!location || !location.active) return null;
      const impact = await getPartnerLocationArchiveImpact(tx, {
        accountId: principal.accountId!,
        location,
        defaultLocationId: account.defaultLocationId,
      });
      return { account, location, impact };
    });
    if (!result) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      { ok: true, impact: result.impact },
      correlationId,
      200,
      {
        ETag: partnerLocationEtag(result.location),
        "X-Location-Directory-ETag": partnerLocationDirectoryEtag({
          accountId: principal.accountId,
          version: result.account.version,
        }),
      },
    );
  } catch (error) {
    console.error("[partner-portal-v2] location archive impact failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
