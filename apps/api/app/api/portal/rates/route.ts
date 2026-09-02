import type { NextRequest } from "next/server";
import { GET as getPartnerServiceCatalog } from "../v2/service-catalog/route";

/**
 * Read-only compatibility adapter. V2 applies selected-account authorization
 * and hides negotiated money unless the membership may read it.
 */
export async function GET(request: NextRequest): Promise<Response> {
  return getPartnerServiceCatalog(request);
}
