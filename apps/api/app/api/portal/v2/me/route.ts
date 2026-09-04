import type { NextRequest } from "next/server";
import { resolvePartnerPrincipal } from "@/lib/partner-account-authorization";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    const result = await resolvePartnerPrincipal(request);
    if (!result.ok) {
      return createPartnerPortalV2ErrorResponse(
        result.error,
        result.status,
        correlationId,
      );
    }

    const { principal } = result;
    const currentAccess = principal.availableAccounts.find(
      (access) =>
        access.accountId === principal.accountId &&
        access.membershipId === principal.membershipId,
    );
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        partnerUser: {
          id: principal.partnerUserId,
          email: principal.email,
          name: principal.name,
          passwordSet: principal.passwordSet,
        },
        account: {
          id: principal.accountId,
          name: principal.accountName,
          status: currentAccess?.accountStatus ?? "legacy",
          accessSource: principal.accessSource,
        },
        membership: {
          id: principal.membershipId,
          roleKey: principal.roleKey,
          persona: principal.persona,
          accessLevel: principal.accessLevel,
          preferences: principal.preferences,
          capabilities: principal.capabilities,
        },
        accounts: principal.availableAccounts.map((access) => ({
          id: access.accountId,
          name: access.accountName,
          status: access.accountStatus,
          membershipId: access.membershipId,
          roleKey: access.roleKey,
          persona: access.persona,
          accessLevel: access.accessLevel,
          preferences: access.preferences,
          capabilities: access.capabilities,
          current:
            access.accountId === principal.accountId &&
            access.membershipId === principal.membershipId,
          defaultAccount: access.isDefault,
        })),
      },
      correlationId,
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
