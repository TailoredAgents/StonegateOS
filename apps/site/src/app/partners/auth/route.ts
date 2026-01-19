import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { callPartnerPublicApi } from "../lib/api";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!token) {
    return NextResponse.redirect(new URL("/partners/login?error=missing_token", request.url));
  }

  const res = await callPartnerPublicApi("/api/public/partners/exchange", {
    method: "POST",
    body: JSON.stringify({ token })
  });

  if (!res.ok) {
    return NextResponse.redirect(new URL("/partners/login?error=expired_or_invalid", request.url));
  }

  const payload = (await res.json().catch(() => ({}))) as { sessionToken?: string; needsPasswordSetup?: boolean };
  const sessionToken = typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (!sessionToken) {
    return NextResponse.redirect(new URL("/partners/login?error=auth_failed", request.url));
  }

  const redirectUrl = new URL("/partners", request.url);
  if (payload.needsPasswordSetup) {
    redirectUrl.searchParams.set("setup", "1");
  }

  const response = NextResponse.redirect(redirectUrl);
  response.cookies.set({
    name: PARTNER_SESSION_COOKIE,
    value: sessionToken,
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/"
  });
  return response;
}

