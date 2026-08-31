import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";
import { callPartnerPublicApi } from "../lib/api";
import { resolvePublicOrigin } from "../lib/origin";

export async function POST(request: NextRequest): Promise<Response> {
  const origin = resolvePublicOrigin(request);
  const requestOrigin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    (requestOrigin && requestOrigin !== request.nextUrl.origin) ||
    (!requestOrigin &&
      fetchSite &&
      !["same-origin", "none"].includes(fetchSite))
  ) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const token = request.cookies.get(PARTNER_SESSION_COOKIE)?.value ?? "";
  if (token) {
    const revoked = await callPartnerPublicApi("/api/portal/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!revoked?.ok) {
      return NextResponse.redirect(
        new URL("/partners/settings?error=logout_failed", origin),
        303,
      );
    }
  }

  const response = NextResponse.redirect(
    new URL("/partners/login", origin),
    303,
  );
  response.cookies.set({
    name: PARTNER_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
