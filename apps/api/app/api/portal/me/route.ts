import type { NextRequest } from "next/server";
import { GET as getPartnerSession } from "../v2/session/route";

/** Canonical membership/session projection for the retired V1 path. */
export async function GET(request: NextRequest): Promise<Response> {
  return getPartnerSession(request);
}
