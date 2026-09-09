import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
  createPortalV2IdempotencyErrorResponse,
} from "@/lib/portal-v2-contract";
import { commitPartnerBulkImport } from "@/lib/partner-repeat-work";
import {
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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ importId: string }> },
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
      "bookings.create",
    );
    if (!authorization.ok)
      return portalAuthorizationFailureResponse(authorization, correlationId);
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok)
      return portalContractFailureResponse(
        createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
      );
    const result = await commitPartnerBulkImport({
      actor: requirePartnerSchedulingActor(authorization.principal, "write"),
      principal: authorization.principal,
      importId: requirePortalUuid((await context.params).importId, "importId"),
      ifMatch: request.headers.get("If-Match"),
      idempotencyKeyHash: idempotency.keyHash!,
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, import: result },
      correlationId,
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
