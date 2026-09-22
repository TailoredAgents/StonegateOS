import type { NextRequest } from "next/server";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
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
  requestPartnerVisitReschedule,
  parsePartnerDraftMutation,
} from "@/lib/partner-portal-v2-scheduling";
import {
  portalAuthorizationFailureResponse,
  portalContractFailureResponse,
  portalSchedulingExceptionResponse,
  portalSchedulingSuccessResponse,
  requestIfMatch,
} from "@/lib/partner-portal-v2-scheduling/route-utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string; visitId: string }> },
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
    const body = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1024,
      rejectDuplicateObjectKeys: true,
    });
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "preferredWindows")
    )
      throw new PartnerPortalSchedulingError(
        "invalid_body",
        "Provide preferred dates for this visit.",
        { status: 400 },
      );
    const parsed = parsePartnerDraftMutation(body);
    if (!parsed.preferredWindows)
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Choose one to three preferred dates.",
        { status: 422 },
      );
    const { jobId: rawJobId, visitId: rawVisitId } = await context.params;
    const jobId = requirePortalUuid(rawJobId, "jobId"),
      visitId = requirePortalUuid(rawVisitId, "visitId");
    const result = await requestPartnerVisitReschedule({
      actor,
      jobId,
      visitId,
      preferredWindows: parsed.preferredWindows,
      ifMatch: requestIfMatch(request),
      idempotencyKeyHash: idempotency.keyHash,
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      {
        ok: true,
        reschedule: result.result,
        replayed: result.replayed,
      },
      correlationId,
      {
        headers: {
          ETag: result.result.etag,
          Location: `/api/portal/v2/jobs/${result.result.jobId}#schedule-change`,
        },
      },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
