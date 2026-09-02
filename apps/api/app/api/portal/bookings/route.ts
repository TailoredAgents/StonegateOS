import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { GET as getPartnerJobs } from "../v2/jobs/route";

/**
 * Read-only compatibility adapter. Portal V1 no longer owns booking state;
 * the account-scoped V2 job projection is the only supported read model.
 */
export async function GET(request: NextRequest): Promise<Response> {
  return getPartnerJobs(request);
}

/**
 * Contact-scoped V1 booking writes are permanently retired. New jobs must be
 * created from a revisioned V2 booking draft and an optional schedule hold.
 */
export function POST(): Response {
  return NextResponse.json(
    {
      ok: false,
      error: "legacy_route_retired",
      recoveryAction:
        "Use /api/portal/v2/booking-drafts and submit the validated draft.",
    },
    {
      status: 410,
      headers: {
        "Cache-Control": "private, no-store",
        Link: '</api/portal/v2/booking-drafts>; rel="successor-version"',
      },
    },
  );
}
