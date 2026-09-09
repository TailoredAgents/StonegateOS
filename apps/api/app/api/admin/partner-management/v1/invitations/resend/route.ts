import type { NextRequest } from "next/server";
import { handlePartnerRelationshipWrite } from "@/lib/partner-relationship-management-route";
export async function POST(request: NextRequest): Promise<Response> {
  return handlePartnerRelationshipWrite(request, "resend");
}
