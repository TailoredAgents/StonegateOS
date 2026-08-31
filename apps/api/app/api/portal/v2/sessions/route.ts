import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  listPartnerSelfSessions,
  partnerSelfSessionVersion,
  serializePartnerSelfSession,
} from "@/lib/partner-portal-session-management";
import {
  createPortalV2StrongEtag,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

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
    const sessions = await listPartnerSelfSessions(
      authorization.principal.partnerUserId,
    );
    const version = partnerSelfSessionVersion(sessions);
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        sessions: sessions.map((session) =>
          serializePartnerSelfSession(
            session,
            authorization.principal.session.id,
          ),
        ),
      },
      correlationId,
      200,
      { ETag: createPortalV2StrongEtag(version) },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
