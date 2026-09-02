import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  createPartnerJobChangeRequest,
  partnerJobChangeRequestEtag,
  PartnerJobChangeRequestError,
} from "@/lib/partner-job-change-request-lifecycle";
import { PartnerJobChangeRequestBodySchema } from "@/lib/partner-job-change-requests";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function publicChangeRequestConsequence(state: string): string {
  if (state === "approved") {
    return "Stonegate approved the public job-detail changes. Price, proof requirements, and schedule were not changed.";
  }
  if (state === "declined") {
    return "Stonegate declined the request. The current job remains unchanged.";
  }
  if (state === "change_order_required") {
    return "Stonegate requires change-order review before this request can affect the job. The current job remains unchanged.";
  }
  if (state === "superseded") {
    return "The job was canceled, so this change request was closed without being applied.";
  }
  return "The current job, price, proof requirements, and schedule remain unchanged until Stonegate reviews this request.";
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId?: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "jobs.change_request",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const jobId = (await context.params).jobId?.trim().toLowerCase() ?? "";
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !UUID_PATTERN.test(jobId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2ErrorResponse(
      idempotency.reason === "required"
        ? "idempotency_key_required"
        : "invalid_idempotency_key",
      400,
      correlationId,
    );
  }
  if (!idempotency.keyHash) {
    return createPartnerPortalV2ErrorResponse(
      "idempotency_key_required",
      400,
      correlationId,
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 16 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = PartnerJobChangeRequestBodySchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        jobId,
        reason: parsed.data.reason,
        proposedChanges: parsed.data.proposedChanges,
      }),
      "utf8",
    )
    .digest("hex");

  try {
    const result = await getDb().transaction((tx) =>
      createPartnerJobChangeRequest(tx, {
        principal,
        jobId,
        payload: parsed.data,
        operationKeyHash: idempotency.keyHash!,
        requestHash,
        ifMatch: request.headers.get("if-match"),
        correlationId,
      }),
    );
    return NextResponse.json(
      {
        ok: true,
        correlationId,
        job: {
          id: jobId,
          revision: result.bookingRevision,
          updatedAt: result.bookingUpdatedAt.toISOString(),
        },
        changeRequest: {
          id: result.requestId,
          state: result.state,
          revision: result.requestRevision,
          createdAt: result.createdAt.toISOString(),
          resolution: result.resolution
            ? {
                outcome: result.resolution.outcome,
                resolvedAt: result.resolution.resolvedAt.toISOString(),
              }
            : null,
          replayed: result.replayed,
          consequence: publicChangeRequestConsequence(result.state),
        },
      },
      {
        status: result.replayed ? 200 : 201,
        headers: {
          "Cache-Control": "no-store",
          "x-correlation-id": correlationId,
          ETag: partnerJobChangeRequestEtag({
            jobId,
            revision: result.bookingRevision,
            updatedAt: result.bookingUpdatedAt,
          }),
          ...(result.replayed ? { "idempotency-replayed": "true" } : {}),
          Vary: "Authorization",
        },
      },
    );
  } catch (error) {
    if (error instanceof PartnerJobChangeRequestError) {
      return createPartnerPortalV2ErrorResponse(
        error.code,
        error.status,
        correlationId,
      );
    }
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
