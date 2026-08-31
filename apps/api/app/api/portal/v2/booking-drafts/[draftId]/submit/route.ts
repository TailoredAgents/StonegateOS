import type { NextRequest } from "next/server";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  PartnerPortalSchedulingError,
  requirePartnerSchedulingActor,
  requirePortalUuid,
  submitPartnerBookingDraft,
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
  context: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await requirePartnerCapability(
      request,
      "bookings.create",
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
    const allowedKeys = new Set(["holdId", "submissionMode"]);
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => !allowedKeys.has(key))
    ) {
      throw new PartnerPortalSchedulingError(
        "invalid_body",
        "Choose a held arrival window or explicitly submit a review request.",
        { status: 400 },
      );
    }
    const reviewOnly = body["submissionMode"] === "review";
    const holdId =
      body["holdId"] === undefined
        ? null
        : requirePortalUuid(body["holdId"], "holdId");
    if (
      Boolean(holdId) === reviewOnly ||
      (body["submissionMode"] !== undefined && !reviewOnly)
    ) {
      throw new PartnerPortalSchedulingError(
        "invalid_body",
        "Choose either a held arrival window or review-request submission.",
        { status: 400 },
      );
    }
    const { draftId: rawDraftId } = await context.params;
    const draftId = requirePortalUuid(rawDraftId, "draftId");
    const result = await submitPartnerBookingDraft({
      actor,
      draftId,
      holdId,
      idempotencyKeyHash: idempotency.keyHash,
      ifMatch: requestIfMatch(request),
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, booking: result.booking, replayed: result.replayed },
      correlationId,
      {
        status: result.replayed ? 200 : 201,
        headers: {
          Location: `/api/portal/v2/jobs/${result.booking.id}`,
        },
      },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
