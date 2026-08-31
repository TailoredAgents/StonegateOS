import type { NextRequest } from "next/server";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import {
  hasPartnerCapability,
  requirePartnerCapability,
} from "@/lib/partner-account-authorization";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerServiceTemplate,
  listPartnerServiceTemplates,
} from "@/lib/partner-repeat-work";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    const templates = await listPartnerServiceTemplates({ actor });
    return portalSchedulingSuccessResponse(
      { ok: true, templates },
      correlationId,
    );
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
    const body = await readBoundedJsonRequest(request, {
      maximumBytes: 8 * 1024,
      rejectDuplicateObjectKeys: true,
    });
    if (!isRecord(body))
      throw new PartnerPortalSchedulingError(
        "invalid_body",
        "A JSON object is required.",
        { status: 400 },
      );
    const unknown = Object.keys(body).find(
      (key) => !["name", "draftId", "jobId"].includes(key),
    );
    if (unknown)
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Review the template fields.",
        {
          status: 422,
          fieldErrors: { [unknown]: "This field is not supported." },
        },
      );
    if (
      body["jobId"] &&
      !hasPartnerCapability(authorization.principal, "jobs.read")
    ) {
      throw new PartnerPortalSchedulingError(
        "not_found",
        "The job was not found.",
        { status: 404 },
      );
    }
    const result = await createPartnerServiceTemplate({
      actor,
      principal: authorization.principal,
      name: typeof body["name"] === "string" ? body["name"] : "",
      ...(body["draftId"]
        ? { draftId: requirePortalUuid(body["draftId"], "draftId") }
        : {}),
      ...(body["jobId"]
        ? { jobId: requirePortalUuid(body["jobId"], "jobId") }
        : {}),
      idempotencyKeyHash: idempotency.keyHash,
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, ...result },
      correlationId,
      {
        status: result.replayed ? 200 : 201,
        headers: {
          ETag: result.template.etag,
          Location: `/api/portal/v2/service-templates/${result.template.id}`,
        },
      },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
