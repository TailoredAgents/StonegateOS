import type { NextRequest } from "next/server";
import { POST as submitVerifiedPartnerApplication } from "../onboarding/application/submit/route";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { listPartnerAccessApplications } from "@/lib/partner-portal-onboarding";
import {
  createPortalV2StrongEtag,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

function serializeApplication(
  row: Awaited<ReturnType<typeof listPartnerAccessApplications>>[number],
) {
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    informationRequest:
      row.status === "needs_information" ? row.informationRequest : null,
    emailVerified: Boolean(row.emailVerifiedAt),
    submittedAt: row.submittedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    etag: createPortalV2StrongEtag(`${row.id}:${row.version}`),
  };
}

export async function GET(request: NextRequest): Promise<Response> {
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
    const applications = await listPartnerAccessApplications(
      authorization.principal.partnerUserId,
    );
    return createPartnerPortalV2SuccessResponse(
      { ok: true, applications: applications.map(serializeApplication) },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  return submitVerifiedPartnerApplication(request);
}
