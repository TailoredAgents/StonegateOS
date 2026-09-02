import { NextResponse } from "next/server";

/**
 * The contact-authorized V1 password writer is permanently retired. Password
 * changes use the revision-safe V2 security route, which requires canonical
 * membership authority, current-password/recent-auth proof, bounded input,
 * session revocation, and an audit receipt.
 */
export function POST(): Response {
  return NextResponse.json(
    {
      ok: false,
      error: "legacy_route_retired",
      replacement: "/api/portal/v2/security/password",
    },
    {
      status: 410,
      headers: {
        "Cache-Control": "no-store",
        Deprecation: "true",
        Link: '</api/portal/v2/security/password>; rel="successor-version"',
      },
    },
  );
}
