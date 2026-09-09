import type { NextRequest } from "next/server";
import {
  hasPartnerCapability,
  requirePartnerCapability,
} from "@/lib/partner-account-authorization";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerAdditionalServiceDraft,
  PartnerPortalSchedulingError,
  requirePartnerSchedulingActor,
  requirePortalUuid,
} from "@/lib/partner-portal-v2-scheduling";
import {
  portalAuthorizationFailureResponse,
  portalContractFailureResponse,
  portalSchedulingExceptionResponse,
  portalSchedulingSuccessResponse,
} from "@/lib/partner-portal-v2-scheduling/route-utils";

export { getPartnerAdditionalServiceLinks as GET } from "@/lib/partner-additional-service";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    if (!isAllowedPartnerPortalMutationOrigin(request)) {
      throw new PartnerPortalSchedulingError(
        "forbidden",
        "The request origin could not be verified.",
        { status: 403 },
      );
    }
    const authorization = await requirePartnerCapability(
      request,
      "bookings.create",
    );
    if (!authorization.ok)
      return portalAuthorizationFailureResponse(authorization, correlationId);
    if (!hasPartnerCapability(authorization.principal, "jobs.read")) {
      throw new PartnerPortalSchedulingError(
        "not_found",
        "The job was not found.",
        { status: 404 },
      );
    }
    const actor = requirePartnerSchedulingActor(
      authorization.principal,
      "write",
    );
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok)
      return portalContractFailureResponse(
        createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
      );
    if (!idempotency.keyHash)
      throw new TypeError("Missing required operation key.");
    const body = await readBoundedJsonRequest(request, {
      maximumBytes: 256,
      rejectDuplicateObjectKeys: true,
    });
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0
    ) {
      throw new PartnerPortalSchedulingError(
        "invalid_body",
        "Start the new request without copying job or payment fields.",
        { status: 400 },
      );
    }
    const { jobId } = await context.params;
    const result = await createPartnerAdditionalServiceDraft({
      actor,
      jobId: requirePortalUuid(jobId, "jobId"),
      idempotencyKeyHash: idempotency.keyHash,
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, ...result },
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
