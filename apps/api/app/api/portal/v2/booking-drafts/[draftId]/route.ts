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
  getPartnerBookingDraft,
  abandonPartnerBookingDraft,
  parsePartnerDraftMutation,
  requirePartnerSchedulingActor,
  requirePortalUuid,
  updatePartnerBookingDraft,
  PartnerPortalSchedulingError,
} from "@/lib/partner-portal-v2-scheduling";
import {
  portalAuthorizationFailureResponse,
  portalContractFailureResponse,
  portalSchedulingExceptionResponse,
  portalSchedulingSuccessResponse,
  requestIfMatch,
} from "@/lib/partner-portal-v2-scheduling/route-utils";

type RouteContext = { params: Promise<{ draftId: string }> };

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    if (!isAllowedPartnerPortalMutationOrigin(request))
      throw new PartnerPortalSchedulingError(
        "forbidden",
        "The request origin could not be verified.",
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
    const result = await abandonPartnerBookingDraft({
      actor,
      draftId: requirePortalUuid((await context.params).draftId, "draftId"),
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

async function authorize(
  request: NextRequest,
  correlationId: string,
  capability: "bookings.read" | "bookings.update",
) {
  const authorization = await requirePartnerCapability(request, capability);
  if (authorization.ok) return authorization;
  return portalAuthorizationFailureResponse(authorization, correlationId);
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await authorize(
      request,
      correlationId,
      "bookings.read",
    );
    if (authorization instanceof Response) return authorization;
    const actor = requirePartnerSchedulingActor(
      authorization.principal,
      "read",
    );
    const { draftId: rawDraftId } = await context.params;
    const draftId = requirePortalUuid(rawDraftId, "draftId");
    const draft = await getPartnerBookingDraft({ actor, draftId });
    return portalSchedulingSuccessResponse({ ok: true, draft }, correlationId, {
      headers: { ETag: draft.etag },
    });
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await authorize(
      request,
      correlationId,
      "bookings.update",
    );
    if (authorization instanceof Response) return authorization;
    const actor = requirePartnerSchedulingActor(
      authorization.principal,
      "write",
    );
    const { draftId: rawDraftId } = await context.params;
    const draftId = requirePortalUuid(rawDraftId, "draftId");
    const body = await readBoundedJsonRequest(request, {
      maximumBytes: 64 * 1024,
      rejectDuplicateObjectKeys: true,
    });
    const mutation = parsePartnerDraftMutation(body);
    const draft = await updatePartnerBookingDraft({
      actor,
      draftId,
      mutation,
      ifMatch: requestIfMatch(request),
      correlationId,
    });
    return portalSchedulingSuccessResponse({ ok: true, draft }, correlationId, {
      headers: { ETag: draft.etag },
    });
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
