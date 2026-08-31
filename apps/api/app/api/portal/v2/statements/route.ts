import type { NextRequest } from "next/server";
import { listPartnerStatements } from "@/lib/partner-portal-v2-commercial";
import { handlePartnerCommercialList } from "@/lib/partner-portal-v2-commercial-route";

export async function GET(request: NextRequest): Promise<Response> {
  return handlePartnerCommercialList({
    request,
    capability: "invoices.read",
    loader: listPartnerStatements,
    csvFilename: "statements.csv",
  });
}
