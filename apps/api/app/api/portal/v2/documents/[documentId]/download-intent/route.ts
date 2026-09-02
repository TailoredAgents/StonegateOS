import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import { createPartnerDocumentDownloadIntent } from "@/lib/partner-portal-v2-documents";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import {
  isAllowedPartnerPortalMutationOrigin,
  isPortalV2Uuid,
} from "@/lib/partner-portal-v2-security";
import { consumeTeamAuthRateLimit } from "@/lib/team-auth-rate-limit";
import {
  createPortalV2ErrorResponse,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "documents.financial.read",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { documentId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(documentId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    const rateLimit = await consumeTeamAuthRateLimit({
      action: "partner_document_download",
      request,
      identity: {
        kind: "partner_user",
        value: principal.partnerUserId,
      },
    });
    if (rateLimit.limited) {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse("rate_limited", correlationId, {
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        }),
      );
    }
    const result = await createPartnerDocumentDownloadIntent({
      accountId: principal.accountId,
      documentId,
      membershipId: principal.membershipId,
      partnerUserId: principal.partnerUserId,
      email: principal.email,
      roleKey: principal.roleKey,
      accessLevel: principal.accessLevel,
      accessScope: principal.accessScope,
      sessionId: principal.session.id,
      correlationId,
    });
    if (!result.ok) {
      return createPartnerPortalV2ErrorResponse(
        result.error,
        result.status,
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      { ok: true, download: result.download },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
