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
  getPartnerRecurringSeries,
  mutatePartnerRecurringSeriesLifecycle,
  parseRecurringSeriesLifecycleMutation,
} from "@/lib/partner-repeat-work";
import {
  PartnerPortalSchedulingError,
  requirePartnerSchedulingActor,
} from "@/lib/partner-portal-v2-scheduling";
import {
  portalAuthorizationFailureResponse,
  portalContractFailureResponse,
  portalSchedulingExceptionResponse,
  portalSchedulingSuccessResponse,
  requestIfMatch,
} from "@/lib/partner-portal-v2-scheduling/route-utils";

type RouteContext = { params: Promise<{ seriesId: string }> };

export async function GET(
  request: NextRequest,
  context: RouteContext,
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
    const { seriesId } = await context.params;
    const series = await getPartnerRecurringSeries({ actor, seriesId });
    if (!series) {
      throw new PartnerPortalSchedulingError(
        "not_found",
        "The recurring schedule was not found.",
        { status: 404 },
      );
    }
    return portalSchedulingSuccessResponse(
      { ok: true, series },
      correlationId,
      { headers: { ETag: series.etag } },
    );
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
    if (!isAllowedPartnerPortalMutationOrigin(request)) {
      throw new PartnerPortalSchedulingError(
        "forbidden",
        "The request origin could not be verified.",
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
    const mutation = parseRecurringSeriesLifecycleMutation(
      await readBoundedJsonRequest(request, {
        maximumBytes: 4 * 1024,
        rejectDuplicateObjectKeys: true,
      }),
    );
    const { seriesId } = await context.params;
    const result = await mutatePartnerRecurringSeriesLifecycle({
      actor,
      principal: authorization.principal,
      seriesId,
      mutation,
      idempotencyKeyHash: idempotency.keyHash,
      ifMatch: requestIfMatch(request),
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, series: result.series, transition: result.transition },
      correlationId,
      {
        headers: {
          ETag: result.series.etag,
          ...(result.replayed ? { "idempotency-replayed": "true" } : {}),
        },
      },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
