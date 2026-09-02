import type { NextRequest } from "next/server";
import { listPartnerDocuments } from "@/lib/partner-portal-v2-commercial";
import { handlePartnerCommercialList } from "@/lib/partner-portal-v2-commercial-route";

export async function GET(request: NextRequest): Promise<Response> {
  return handlePartnerCommercialList({
    request,
    capability: "documents.financial.read",
    loader: listPartnerDocuments,
    csvFilename: "documents.csv",
  });
}
