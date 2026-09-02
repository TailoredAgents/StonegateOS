import type { NextRequest } from "next/server";
import { handleStaffPartnerMemberUpdate } from "@/lib/partner-management-member-mutation-route";
import { beginTeamMutation } from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ membershipId?: string }> };

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.memberships.manage"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_membership.role_updated",
  });
  if (!boundary.ok) return boundary.response;
  return handleStaffPartnerMemberUpdate({
    request,
    context,
    mutation: boundary.mutation,
    action: "role_update",
    route:
      "PATCH /api/admin/partner-management/v1/memberships/:membershipId/role",
  });
}
