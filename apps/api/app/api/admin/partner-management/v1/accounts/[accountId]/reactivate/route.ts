import type { NextRequest } from "next/server";
import { handlePartnerAccountLifecycleMutation } from "@/lib/partner-account-lifecycle-mutation-route";
import { beginTeamMutation } from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ accountId?: string }> };

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.accounts.lifecycle"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_account.reactivated",
  });
  if (!boundary.ok) return boundary.response;
  return handlePartnerAccountLifecycleMutation({
    request,
    context,
    mutation: boundary.mutation,
    action: "reactivate",
  });
}
