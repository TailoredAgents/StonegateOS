import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  requirePartnerSchedulingActor,
  requirePortalUuid,
  validateAndSavePartnerBookingDraft,
} from "@/lib/partner-portal-v2-scheduling";
import {
  portalAuthorizationFailureResponse,
  portalSchedulingExceptionResponse,
  portalSchedulingSuccessResponse,
  requestIfMatch,
} from "@/lib/partner-portal-v2-scheduling/route-utils";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await requirePartnerCapability(
      request,
      "bookings.update",
    );
    if (!authorization.ok) {
      return portalAuthorizationFailureResponse(authorization, correlationId);
    }
    const actor = requirePartnerSchedulingActor(
      authorization.principal,
      "write",
    );
    const { draftId: rawDraftId } = await context.params;
    const draftId = requirePortalUuid(rawDraftId, "draftId");
    const result = await validateAndSavePartnerBookingDraft({
      actor,
      draftId,
      ifMatch: requestIfMatch(request),
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, draft: result.draft, validation: result.validation },
      correlationId,
      { headers: { ETag: result.draft.etag } },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
