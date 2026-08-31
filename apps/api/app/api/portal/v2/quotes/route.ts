import type { NextRequest } from "next/server";
import { listPartnerQuotes } from "@/lib/partner-portal-v2-commercial";
import { handlePartnerCommercialList } from "@/lib/partner-portal-v2-commercial-route";

export async function GET(request: NextRequest): Promise<Response> {
  return handlePartnerCommercialList({
    request,
    capability: "rates.read",
    loader: listPartnerQuotes,
    csvFilename: "quotes.csv",
  });
}
