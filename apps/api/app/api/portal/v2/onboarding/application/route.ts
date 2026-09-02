import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { arePartnerPurposeAuthTokensEnabled } from "@/lib/partner-portal-feature-flags";
import { requirePartnerApplicantSession } from "@/lib/partner-purpose-auth";
import {
  getPartnerApplicantApplication,
  parsePartnerApplicationDraftPatch,
  savePartnerApplicantDraft,
} from "@/lib/partner-verification-onboarding";
import {
  createPortalV2ErrorResponse,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";

function unavailable(correlationId: string): Response {
  return createPartnerPortalV2ErrorResponse(
    "service_unavailable",
    503,
    correlationId,
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!arePartnerPurposeAuthTokensEnabled()) return unavailable(correlationId);
  try {
    const authorization = await requirePartnerApplicantSession(request);
    if (!authorization.ok) {
      return createPartnerPortalV2ErrorResponse(
        authorization.error,
        authorization.status,
        correlationId,
      );
    }
    const view = await getPartnerApplicantApplication(authorization.principal);
    return createPartnerPortalV2SuccessResponse(
      { ok: true, ...view },
      correlationId,
      200,
      { ETag: view.etag },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!arePartnerPurposeAuthTokensEnabled()) return unavailable(correlationId);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  try {
    const authorization = await requirePartnerApplicantSession(request);
    if (!authorization.ok) {
      return createPartnerPortalV2ErrorResponse(
        authorization.error,
        authorization.status,
        correlationId,
      );
    }
    let raw: unknown;
    try {
      raw = await readBoundedJsonRequest(request, {
        maximumBytes: 16_384,
        deadlineMs: 10_000,
        rejectDuplicateObjectKeys: true,
      });
    } catch (error) {
      const failure = error instanceof BoundedJsonRequestError ? error : null;
      return createPartnerPortalV2ErrorResponse(
        failure?.code === "invalid_body" ? "invalid_body" : "invalid_request",
        failure?.status ?? 400,
        correlationId,
      );
    }
    const patch = parsePartnerApplicationDraftPatch(raw);
    if (!patch) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    const result = await savePartnerApplicantDraft({
      principal: authorization.principal,
      patch,
      ifMatch: request.headers.get("if-match"),
      correlationId,
    });
    if (result.kind === "precondition") {
      return createPartnerPortalV2DescriptorResponse(result.response);
    }
    if (result.kind === "invalid_candidate") {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse("invalid_fields", correlationId, {
          fieldErrors: {
            companyCandidateId:
              "Refresh the verified company match before selecting it.",
          },
        }),
      );
    }
    if (result.kind !== "success") {
      return createPartnerPortalV2ErrorResponse(
        result.kind === "not_found" ? "not_found" : "conflict",
        result.kind === "not_found" ? 404 : 409,
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      { ok: true, ...result.view },
      correlationId,
      200,
      { ETag: result.view.etag },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
