import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { GET as getPartnerLocations } from "../v2/locations/route";

/** Account-scoped, read-only compatibility projection. */
export async function GET(request: NextRequest): Promise<Response> {
  return getPartnerLocations(request);
}

/** Contact/property-association writes are retired in favor of V2 locations. */
export function POST(): Response {
  return NextResponse.json(
    {
      ok: false,
      error: "legacy_route_retired",
      recoveryAction: "Use /api/portal/v2/locations.",
    },
    {
      status: 410,
      headers: {
        "Cache-Control": "private, no-store",
        Link: '</api/portal/v2/locations>; rel="successor-version"',
      },
    },
  );
}
