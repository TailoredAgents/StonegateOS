import type { NextRequest } from "next/server";
import { partnerManagementListResponse } from "@/lib/partner-management-route";
import { requirePermission } from "@/lib/permissions";

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    "partners.accounts.read",
  );
  if (permissionError) return permissionError;
  return partnerManagementListResponse(
    request,
    "account-merges",
    "partners.accounts.read",
    true,
  );
}
