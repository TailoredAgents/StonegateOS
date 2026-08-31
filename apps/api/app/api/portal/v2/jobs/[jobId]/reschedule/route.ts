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
  reschedulePartnerBooking,
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
    const body = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1024,
      rejectDuplicateObjectKeys: true,
    });
    const allowedKeys = new Set(["draftId", "holdId", "draftEtag"]);
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => !allowedKeys.has(key)) ||
      typeof body["draftEtag"] !== "string"
    ) {
      throw new PartnerPortalSchedulingError(
        "invalid_body",
        "A schedule-change draft, hold, and draft revision are required.",
        { status: 400 },
      );
    }
    const { jobId: rawJobId } = await context.params;
    const jobId = requirePortalUuid(rawJobId, "jobId");
    const draftId = requirePortalUuid(body["draftId"], "draftId");
    const holdId = requirePortalUuid(body["holdId"], "holdId");
    const result = await reschedulePartnerBooking({
      actor,
      jobId,
      draftId,
      holdId,
      idempotencyKeyHash: idempotency.keyHash,
      jobIfMatch: requestIfMatch(request),
      draftIfMatch: body["draftEtag"],
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
          Location:
            result.result.mode === "instant"
              ? `/api/portal/v2/jobs/${result.result.jobId}`
              : `/api/portal/v2/jobs/${result.result.jobId}#schedule-change`,
        },
      },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
