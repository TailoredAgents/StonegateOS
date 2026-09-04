import type { NextRequest } from "next/server";
import {
  requirePartnerCapability,
  type PartnerPrincipalResult,
} from "@/lib/partner-account-authorization";

export async function requirePartnerNotificationEndpointMutationAccess(
  request: NextRequest,
): Promise<PartnerPrincipalResult> {
  const authorization = await requirePartnerCapability(
    request,
    "account.security.manage",
  );
  if (!authorization.ok) return authorization;
  return authorization;
}
