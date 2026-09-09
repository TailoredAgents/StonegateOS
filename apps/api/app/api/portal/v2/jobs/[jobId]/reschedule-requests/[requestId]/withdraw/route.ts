import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  PartnerPortalSchedulingError,
  requirePartnerSchedulingActor,
  requirePortalUuid,
  withdrawPartnerRescheduleRequest,
} from "@/lib/partner-portal-v2-scheduling";
import {
  portalAuthorizationFailureResponse,
  portalContractFailureResponse,
  portalSchedulingExceptionResponse,
  portalSchedulingSuccessResponse,
  requestIfMatch,
} from "@/lib/partner-portal-v2-scheduling/route-utils";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string; requestId: string }> },
) {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    if (!isAllowedPartnerPortalMutationOrigin(request))
      throw new PartnerPortalSchedulingError(
        "forbidden",
        "This request origin is not allowed.",
        { status: 403 },
      );
    const authorization = await requirePartnerCapability(
      request,
      "bookings.update",
    );
    if (!authorization.ok)
      return portalAuthorizationFailureResponse(authorization, correlationId);
    const actor = requirePartnerSchedulingActor(
      authorization.principal,
      "write",
    );
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok)
      return portalContractFailureResponse(
        createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
      );
    if (!idempotency.keyHash) throw new Error("required_idempotency_missing");
    const params = await context.params;
    const result = await withdrawPartnerRescheduleRequest({
      actor,
      jobId: requirePortalUuid(params.jobId, "jobId"),
      requestId: requirePortalUuid(params.requestId, "requestId"),
      ifMatch: requestIfMatch(request),
      idempotencyKeyHash: idempotency.keyHash,
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, ...result },
      correlationId,
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
