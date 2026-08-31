import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { findPartnerAccessApplication } from "@/lib/partner-portal-onboarding";
import {
  createPortalV2StrongEtag,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isPortalV2Uuid } from "@/lib/partner-portal-v2-security";

type RouteContext = { params: Promise<{ applicationId?: string }> };

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const authorization = await requirePartnerCapability(
      request,
      "portal.session.read",
    );
    if (!authorization.ok) {
      return createPartnerPortalV2ErrorResponse(
        authorization.error,
        authorization.status,
        correlationId,
      );
    }
    const applicationId = (await context.params).applicationId?.trim();
    if (!isPortalV2Uuid(applicationId)) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const application = await findPartnerAccessApplication(
      authorization.principal.partnerUserId,
      applicationId,
    );
    if (!application) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const etag = createPortalV2StrongEtag(
      `${application.id}:${application.version}`,
    );
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        application: {
          id: application.id,
          status: application.status,
          version: application.version,
          informationRequest:
            application.status === "needs_information"
              ? application.informationRequest
              : null,
          emailVerified: Boolean(application.emailVerifiedAt),
          submittedAt: application.submittedAt.toISOString(),
          updatedAt: application.updatedAt.toISOString(),
        },
      },
      correlationId,
      200,
      { ETag: etag },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
