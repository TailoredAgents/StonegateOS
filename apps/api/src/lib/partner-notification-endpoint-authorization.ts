import type { NextRequest } from "next/server";
import {
  requirePartnerCapability,
  type PartnerPrincipalResult,
} from "@/lib/partner-account-authorization";
import { hasRecentPartnerMfa } from "@/lib/partner-recent-mfa";

export const hasRecentPartnerNotificationEndpointMfa = hasRecentPartnerMfa;

export async function requirePartnerNotificationEndpointMutationAccess(
  request: NextRequest,
): Promise<PartnerPrincipalResult> {
  const authorization = await requirePartnerCapability(
    request,
    "account.security.manage",
  );
  if (!authorization.ok) return authorization;
  if (!hasRecentPartnerMfa(authorization.principal)) {
    return { ok: false, status: 403, error: "mfa_step_up_required" };
  }
  return authorization;
}
