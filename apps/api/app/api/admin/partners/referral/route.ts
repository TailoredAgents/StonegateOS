import type { NextRequest } from "next/server";
import { handlePartnerOperation } from "@/lib/partner-operations";
import { beginTeamMutation } from "@/lib/team-mutation";

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "partner.referral_logged",
  });
  if (!boundary.ok) return boundary.response;
  return handlePartnerOperation(request, "referral", boundary.mutation);
}
