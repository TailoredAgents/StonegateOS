import type { NextRequest } from "next/server";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import { createPartnerBulkImport } from "@/lib/partner-repeat-work";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      // JSON escaping can expand an otherwise valid 256 KB CSV. The parser
      // separately enforces the actual decoded CSV limit.
      maximumBytes: 600 * 1024,
      rejectDuplicateObjectKeys: true,
    });
    if (!isRecord(body))
      throw new PartnerPortalSchedulingError(
        "invalid_body",
        "A JSON object is required.",
        { status: 400 },
      );
    const unknown = Object.keys(body).find(
      (key) => !["filename", "csv", "dryRun"].includes(key),
    );
    if (
      unknown ||
      typeof body["filename"] !== "string" ||
      typeof body["csv"] !== "string" ||
      typeof body["dryRun"] !== "boolean"
    ) {
      throw new PartnerPortalSchedulingError(
        "invalid_fields",
        "Provide a CSV filename, CSV content, and dry-run choice.",
        { status: 422 },
      );
    }
    const result = await createPartnerBulkImport({
      actor,
      principal: authorization.principal,
      sourceFilename: body["filename"],
      csv: body["csv"],
      dryRun: body["dryRun"],
      idempotencyKeyHash: idempotency.keyHash,
      correlationId,
    });
    return portalSchedulingSuccessResponse(
      { ok: true, ...result },
      correlationId,
      {
        status: result.replayed ? 200 : 201,
        headers: {
          Location: `/api/portal/v2/bulk-imports/${result.import.id}`,
        },
      },
    );
  } catch (error) {
    return portalSchedulingExceptionResponse(error, correlationId);
  }
}
