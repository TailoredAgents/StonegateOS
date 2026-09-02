import { NextResponse } from "next/server";

/**
 * Raw appointment identifiers are not a partner contract. Cancellation is
 * revisioned and account-authorized through the opaque V2 partner job ID.
 */
export function POST(): Response {
  return NextResponse.json(
    {
      ok: false,
      error: "legacy_route_retired",
      recoveryAction: "Use /api/portal/v2/jobs/{jobId}/cancel.",
    },
    {
      status: 410,
      headers: {
        "Cache-Control": "private, no-store",
        Link: '</api/portal/v2/jobs/{jobId}/cancel>; rel="successor-version"',
      },
    },
  );
}
