import type { NextRequest } from "next/server";
import { withPartnerBillingNoStore } from "@/lib/partner-billing-route-response";
import { partnerManagementListResponse } from "@/lib/partner-management-route";
import { requirePermission } from "@/lib/permissions";

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "partners.billing_disputes.read",
  );
  if (permissionError) return withPartnerBillingNoStore(permissionError);
  return partnerManagementListResponse(
    request,
    "billing-disputes",
    "partners.billing_disputes.read",
    true,
  );
}
