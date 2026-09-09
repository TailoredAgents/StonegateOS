import type { NextRequest } from "next/server";
import {
  getPartnerRelationshipContext,
  handlePartnerRelationshipWrite,
} from "@/lib/partner-relationship-management-route";

type Context = { params: Promise<{ accountId: string }> };
export async function GET(
  request: NextRequest,
  context: Context,
): Promise<Response> {
  return getPartnerRelationshipContext(
    request,
    (await context.params).accountId,
  );
}
export async function POST(
  request: NextRequest,
  context: Context,
): Promise<Response> {
  return handlePartnerRelationshipWrite(
    request,
    "workflow",
    (await context.params).accountId,
  );
}
