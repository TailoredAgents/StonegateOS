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
    "portal.session.read",
  );
  if (!authorization.ok) return authorization;
  return authorization;
}
