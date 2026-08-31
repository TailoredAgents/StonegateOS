import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerRescheduleDraft,
  PartnerPortalSchedulingError,
  requirePartnerSchedulingActor,
  requirePortalUuid,
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
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    if (!isAllowedPartnerPortalMutationOrigin(request)) {
      throw new PartnerPortalSchedulingError(
        "forbidden",
        "This request origin is not allowed.",
        { status: 403 },
      );
    }
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
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok) {
      return portalContractFailureResponse(
        createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
      );
    }
    if (!idempotency.keyHash) {
      throw new TypeError("Required Idempotency-Key did not produce a hash.");
    }
    const { jobId: rawJobId } = await context.params;
    const jobId = requirePortalUuid(rawJobId, "jobId");
    const result = await createPartnerRescheduleDraft({
      actor,
      jobId,
      idempotencyKeyHash: idempotency.keyHash,
      ifMatch: requestIfMatch(request),
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, draft: result.draft, replayed: result.replayed },
      correlationId,
      {
        status: result.replayed ? 200 : 201,
        headers: {
          ETag: result.draft.etag,
          Location: `/api/portal/v2/booking-drafts/${result.draft.id}`,
        },
      },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
