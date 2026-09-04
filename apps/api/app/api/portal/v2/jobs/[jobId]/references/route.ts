import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  partnerJobChangeRequestEtag,
  PartnerJobChangeRequestError,
  updatePartnerJobReferences,
} from "@/lib/partner-job-change-request-lifecycle";
import { PartnerJobReferencesBodySchema } from "@/lib/partner-job-change-requests";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
} from "@/lib/partner-portal-v2-response";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ jobId?: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "commercial.edit",
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
      maximumBytes: 2 * 1_024,
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
  const parsed = PartnerJobReferencesBodySchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  const run = await runPortalV2IdempotentMutation({
    principal: `${principal.partnerUserId}:${principal.membershipId}`,
    action: "partner.job.references.update",
    keyHash: idempotency.keyHash,
    scope: `${principal.accountId}:${jobId}`,
    payload: parsed.data,
    correlationId,
    execute: async () => {
      try {
        const result = await getDb().transaction((tx) =>
          updatePartnerJobReferences(tx, {
            principal,
            jobId,
            payload: parsed.data,
            operationKeyHash: idempotency.keyHash!,
            ifMatch: request.headers.get("if-match"),
            correlationId,
          }),
        );
        return {
          status: 200,
          body: {
            ok: true,
            job: {
              id: result.jobId,
              revision: result.revision,
              updatedAt: result.updatedAt.toISOString(),
              references: result.references,
            },
          },
          headers: {
            ETag: partnerJobChangeRequestEtag({
              jobId: result.jobId,
              revision: result.revision,
              updatedAt: result.updatedAt,
            }),
          },
        };
      } catch (error) {
        if (error instanceof PartnerJobChangeRequestError) {
          return {
            status: error.status,
            body: { ok: false, error: error.code },
          };
        }
        throw error;
      }
    },
  });
  if (run.kind === "conflict") {
    return createPartnerPortalV2ErrorResponse(
      run.reason === "different_request" ? "idempotency_conflict" : "conflict",
      409,
      correlationId,
    );
  }
  return createPartnerPortalV2StoredResponse(run.result, correlationId);
}
