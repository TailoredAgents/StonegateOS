import type { NextRequest } from "next/server";
import { partnerManagementListResponse } from "@/lib/partner-management-route";
import { requirePermission } from "@/lib/permissions";
import { handlePartnerRelationshipWrite } from "@/lib/partner-relationship-management-route";

export async function POST(request: NextRequest): Promise<Response> {
  return handlePartnerRelationshipWrite(request, "invite");
}

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "partners.invitations.read",
  );
  if (permissionError) return permissionError;
  return partnerManagementListResponse(
    request,
    "invitations",
    "partners.invitations.read",
    true,
  );
}
