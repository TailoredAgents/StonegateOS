import { NextResponse, type NextRequest } from "next/server";
import { resolvePublicOrigin } from "../lib/origin";
import { normalizePartnerReturnTo } from "../lib/safe-return";

/** Old magic links never create a session or serve as a login fallback. */
export function GET(request: NextRequest): Response {
  const destination = new URL("/partners/login", resolvePublicOrigin(request));
  const returnTo = normalizePartnerReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
  );
  if (returnTo !== "/partners/overview")
    destination.searchParams.set("returnTo", returnTo);
  destination.searchParams.set("error", "security_setup_updated");
  return NextResponse.redirect(destination, {
    status: 303,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
