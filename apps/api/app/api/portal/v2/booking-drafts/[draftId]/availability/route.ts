import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  parsePortalV2Rfc3339,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  getPartnerDraftAvailability,
  PartnerPortalSchedulingError,
  requirePartnerSchedulingActor,
  requirePortalUuid,
} from "@/lib/partner-portal-v2-scheduling";
import {
  portalAuthorizationFailureResponse,
  portalSchedulingExceptionResponse,
  portalSchedulingSuccessResponse,
} from "@/lib/partner-portal-v2-scheduling/route-utils";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await requirePartnerCapability(
      request,
      "bookings.read",
    );
    if (!authorization.ok) {
      return portalAuthorizationFailureResponse(authorization, correlationId);
    }
    const actor = requirePartnerSchedulingActor(
      authorization.principal,
      "read",
    );
    const { draftId: rawDraftId } = await context.params;
    const draftId = requirePortalUuid(rawDraftId, "draftId");
    const now = new Date();
    const fromParam = request.nextUrl.searchParams.get("from");
    const toParam = request.nextUrl.searchParams.get("to");
    const rangeStartAt = fromParam ? parsePortalV2Rfc3339(fromParam) : now;
    const rangeEndAt = toParam
      ? parsePortalV2Rfc3339(toParam)
      : new Date(now.getTime() + 14 * 86_400_000);
    if (!rangeStartAt || !rangeEndAt) {
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Use RFC3339 timestamps for the availability range.",
        {
          status: 422,
          fieldErrors: {
            ...(!rangeStartAt
              ? { from: "Use a valid RFC3339 timestamp." }
              : {}),
            ...(!rangeEndAt ? { to: "Use a valid RFC3339 timestamp." } : {}),
          },
        },
      );
    }
    const availability = await getPartnerDraftAvailability({
      actor,
      draftId,
      rangeStartAt,
      rangeEndAt,
      now,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, availability },
      correlationId,
      { headers: { ETag: availability.draft.etag } },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
