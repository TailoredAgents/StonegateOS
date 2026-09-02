import type { NextRequest } from "next/server";
import { handleTeamOwnerPartnerIdentitySecurityMutation } from "@/lib/partner-identity-security-mutation-route";
import { beginTeamMutation } from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ userId?: string }> };

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.security.mfa.reset"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_identity.mfa_reset_by_owner",
  });
  if (!boundary.ok) return boundary.response;
  return handleTeamOwnerPartnerIdentitySecurityMutation({
    request,
    context,
    mutation: boundary.mutation,
    action: "mfa_reset",
  });
}
