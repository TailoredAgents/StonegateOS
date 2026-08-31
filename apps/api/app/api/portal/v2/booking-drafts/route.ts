import type { NextRequest } from "next/server";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerBookingDraft,
  parsePartnerDraftMutation,
  requirePartnerSchedulingActor,
} from "@/lib/partner-portal-v2-scheduling";
import {
  portalAuthorizationFailureResponse,
  portalContractFailureResponse,
  portalSchedulingExceptionResponse,
  portalSchedulingSuccessResponse,
} from "@/lib/partner-portal-v2-scheduling/route-utils";

export async function POST(request: NextRequest): Promise<Response> {
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
      maximumBytes: 64 * 1024,
      rejectDuplicateObjectKeys: true,
    });
    const mutation = parsePartnerDraftMutation(body, {
      requireAtLeastOne: false,
    });
    const result = await createPartnerBookingDraft({
      actor,
      mutation,
      idempotencyKeyHash: idempotency.keyHash,
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
