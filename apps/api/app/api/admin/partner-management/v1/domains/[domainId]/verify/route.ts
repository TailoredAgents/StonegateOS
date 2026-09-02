import type { NextRequest } from "next/server";
import { handleStaffPartnerAccountDomainLifecycle } from "@/lib/partner-account-domain-mutation-route";
import { beginTeamMutation } from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ domainId?: string }> };

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.domains.verify"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_account_domain.verified",
  });
  if (!boundary.ok) return boundary.response;
  return handleStaffPartnerAccountDomainLifecycle({
    request,
    context,
    mutation: boundary.mutation,
    action: "verify",
  });
}
