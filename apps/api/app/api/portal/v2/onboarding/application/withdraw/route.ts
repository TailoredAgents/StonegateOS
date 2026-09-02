import type { NextRequest } from "next/server";
import { arePartnerPurposeAuthTokensEnabled } from "@/lib/partner-portal-feature-flags";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { requirePartnerApplicantSession } from "@/lib/partner-purpose-auth";
import { withdrawPartnerApplicantApplication } from "@/lib/partner-verification-onboarding";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!arePartnerPurposeAuthTokensEnabled()) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
    );
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
    const run = await runPortalV2IdempotentMutation({
      principal: `applicant:${authorization.principal.sessionId}`,
      action: "partner.access_application.withdraw",
      keyHash: idempotency.keyHash!,
      scope: "POST:/api/portal/v2/onboarding/application/withdraw",
      payload: { ifMatch: request.headers.get("if-match") },
      correlationId,
      execute: async () => {
        const result = await withdrawPartnerApplicantApplication({
          principal: authorization.principal,
          ifMatch: request.headers.get("if-match"),
          correlationId,
        });
        if (result.kind === "success") {
          return {
            status: 200,
            body: { ok: true, ...result.view },
            headers: { ETag: result.view.etag },
          };
        }
        if (result.kind === "precondition") {
          return {
            status: result.response.status,
            body: { ...result.response.body },
            headers: { ...result.response.headers },
          };
        }
        return {
          status: result.kind === "not_found" ? 404 : 409,
          body: {
            ok: false,
            error: result.kind === "not_found" ? "not_found" : "conflict",
          },
        };
      },
    });
    if (run.kind === "conflict") {
      return createPartnerPortalV2ErrorResponse(
        run.reason === "different_request"
          ? "idempotency_conflict"
          : "conflict",
        409,
        correlationId,
      );
    }
    return createPartnerPortalV2StoredResponse(run.result, correlationId);
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
