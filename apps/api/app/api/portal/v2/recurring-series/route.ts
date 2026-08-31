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
  createPartnerRecurringSeries,
  listPartnerRecurringSeries,
  parseRecurrenceInput,
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
} from "@/lib/partner-portal-v2-scheduling/route-utils";

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await requirePartnerCapability(
      request,
      "bookings.read",
    );
    if (!authorization.ok)
      return portalAuthorizationFailureResponse(authorization, correlationId);
    const actor = requirePartnerSchedulingActor(
      authorization.principal,
      "read",
    );
    const series = await listPartnerRecurringSeries({ actor });
    return portalSchedulingSuccessResponse({ ok: true, series }, correlationId);
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
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
      throw new TypeError("Required Idempotency-Key did not produce a hash.");
    const recurrence = parseRecurrenceInput(
      await readBoundedJsonRequest(request, {
        maximumBytes: 8 * 1024,
        rejectDuplicateObjectKeys: true,
      }),
    );
    const result = await createPartnerRecurringSeries({
      actor,
      principal: authorization.principal,
      recurrence,
      idempotencyKeyHash: idempotency.keyHash,
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, ...result },
      correlationId,
      {
        status: result.replayed ? 200 : 201,
        headers: {
          Location: `/api/portal/v2/recurring-series/${result.series.id}`,
        },
      },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
