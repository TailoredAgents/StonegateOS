import type { NextRequest } from "next/server";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import { updatePartnerServiceTemplate } from "@/lib/partner-repeat-work";
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

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ templateId: string }> },
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
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok)
      return portalContractFailureResponse(
        createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
      );
    const body = await readBoundedJsonRequest(request, {
      maximumBytes: 2048,
      rejectDuplicateObjectKeys: true,
    });
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Provide template changes.",
        { status: 422 },
      );
    const value = body as Record<string, unknown>;
    if (
      !Object.keys(value).length ||
      Object.keys(value).some(
        (key) => !["name", "draftId", "active"].includes(key),
      ) ||
      (value["name"] !== undefined && typeof value["name"] !== "string") ||
      (value["active"] !== undefined && typeof value["active"] !== "boolean")
    )
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Review the template changes.",
        { status: 422 },
      );
    const result = await updatePartnerServiceTemplate({
      actor: requirePartnerSchedulingActor(authorization.principal, "write"),
      templateId: requirePortalUuid(
        (await context.params).templateId,
        "templateId",
      ),
      ...(value["name"] !== undefined ? { name: value["name"] } : {}),
      ...(value["active"] !== undefined
        ? { active: value["active"] }
        : {}),
      ...(value["draftId"] !== undefined
        ? { draftId: requirePortalUuid(value["draftId"], "draftId") }
        : {}),
      ifMatch: request.headers.get("If-Match"),
      idempotencyKeyHash: idempotency.keyHash!,
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, ...result },
      correlationId,
      { headers: { ETag: result.template.etag } },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
