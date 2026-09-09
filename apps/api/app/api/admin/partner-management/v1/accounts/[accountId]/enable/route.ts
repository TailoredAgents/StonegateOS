import type { NextRequest } from "next/server";
import { handlePartnerRelationshipWrite } from "@/lib/partner-relationship-management-route";
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ accountId: string }> },
): Promise<Response> {
  return handlePartnerRelationshipWrite(
    request,
    "enable",
    (await context.params).accountId,
  );
}
