import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { listPartnerJoinRequests } from "@/lib/partner-portal-onboarding";
import {
  createPortalV2StrongEtag,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { partnerAccessWorkflowRetired } from "@/lib/partner-access-retirement";

function serializeJoin(
  row: Awaited<ReturnType<typeof listPartnerJoinRequests>>[number],
) {
  return {
    id: row.id,
    account: { id: row.accountId, name: row.accountName },
    requestedRoleKey: row.requestedRoleKey,
    message: row.message,
    status: row.status,
    version: row.version,
    requestedAt: row.requestedAt.toISOString(),
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
    const requests = await listPartnerJoinRequests(
      authorization.principal.partnerUserId,
    );
    return createPartnerPortalV2SuccessResponse(
      { ok: true, joinRequests: requests.map(serializeJoin) },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export function POST(request: NextRequest): Response {
  return partnerAccessWorkflowRetired(request);
}
