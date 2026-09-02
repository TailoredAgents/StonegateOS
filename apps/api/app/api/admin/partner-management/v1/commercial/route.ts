import type { NextRequest } from "next/server";
import { partnerManagementListResponse } from "@/lib/partner-management-route";
import { requirePermission } from "@/lib/permissions";

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "partners.commercial.read",
  );
  if (permissionError) return permissionError;
  return partnerManagementListResponse(
    request,
    "commercial",
    "partners.commercial.read",
    true,
  );
}
