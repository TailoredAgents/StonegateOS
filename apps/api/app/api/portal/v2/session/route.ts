import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const result = await requirePartnerCapability(
      request,
      "portal.session.read",
    );
    if (!result.ok) {
      return createPartnerPortalV2ErrorResponse(
        result.error,
        result.status,
        correlationId,
      );
    }

    const { principal } = result;
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        session: {
          current: true,
          authMethod: principal.session.authMethod,
          assuranceLevel: principal.session.assuranceLevel,
          mfaVerifiedAt: principal.session.mfaVerifiedAt?.toISOString() ?? null,
          deviceName: principal.session.deviceName,
          createdAt: principal.session.createdAt.toISOString(),
          lastSeenAt: principal.session.lastSeenAt.toISOString(),
          expiresAt: principal.session.expiresAt.toISOString(),
        },
        currentAccountId: principal.accountId,
        currentMembershipId: principal.membershipId,
        accounts: principal.availableAccounts.map((access) => ({
          id: access.accountId,
          name: access.accountName,
          membershipId: access.membershipId,
          roleKey: access.roleKey,
          persona: access.persona,
          accessLevel: access.accessLevel,
          current:
            access.accountId === principal.accountId &&
            access.membershipId === principal.membershipId,
        })),
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
