import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { callPartnerPublicApi } from "../lib/api";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";
import { resolvePublicOrigin } from "../lib/origin";
import { normalizePartnerReturnTo } from "../lib/safe-return";

export async function GET(request: NextRequest): Promise<Response> {
  const origin = resolvePublicOrigin(request);
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim() ?? "";
  const rememberMe = url.searchParams.get("remember") === "1";
  const returnTo = normalizePartnerReturnTo(url.searchParams.get("returnTo"));
  if (!token) {
    return NextResponse.redirect(
      new URL("/partners/login?error=missing_token", origin),
    );
  }

  const res = await callPartnerPublicApi(
    "/api/portal/v2/auth/magic-link/consume",
    {
      method: "POST",
      headers: { Origin: origin },
      body: JSON.stringify({ token, rememberMe }),
    },
  );

  if (!res.ok) {
    return NextResponse.redirect(
      new URL("/partners/login?error=expired_or_invalid", origin),
    );
  }

  const payload = (await res.json().catch(() => ({}))) as {
    sessionToken?: string;
    needsPasswordSetup?: boolean;
    expiresAt?: string;
  };
  const sessionToken =
    typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (!sessionToken) {
    return NextResponse.redirect(
      new URL("/partners/login?error=auth_failed", origin),
    );
  }

  const expiresAt = new Date(payload.expiresAt ?? "");
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now()
  ) {
    return NextResponse.redirect(
      new URL("/partners/login?error=auth_failed", origin),
    );
  }

  const redirectUrl = new URL(returnTo, origin);
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
    path: "/",
    expires: expiresAt,
  });
  return response;
}
