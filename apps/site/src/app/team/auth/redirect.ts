import { NextResponse } from "next/server";

const INTERNAL_ORIGIN = "https://team-redirect.invalid";

/**
 * Build an HTTP redirect that stays on the authority which received the
 * request. A relative Location header is deliberate: auth callbacks must not
 * infer a scheme from proxy headers or accept an untrusted Host as an absolute
 * redirect destination.
 */
export function createTeamAuthRedirect(pathAndQuery: string): NextResponse {
  const target = new URL(pathAndQuery, INTERNAL_ORIGIN);
  if (
    target.origin !== INTERNAL_ORIGIN ||
    (target.pathname !== "/team" && !target.pathname.startsWith("/team/"))
  ) {
    throw new Error("Team authentication redirects must stay under /team");
  }

  return new NextResponse(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: `${target.pathname}${target.search}`,
    },
  });
}
