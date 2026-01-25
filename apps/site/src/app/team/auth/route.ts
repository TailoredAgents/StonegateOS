import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { TEAM_SESSION_COOKIE, teamSessionCookieOptions } from "@/lib/team-session";
import { callTeamPublicApi } from "../login/lib/api";

function resolveOrigin(request: NextRequest): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function GET(request: NextRequest): Promise<Response> {
  const origin = resolveOrigin(request);
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!token) {
    return NextResponse.redirect(new URL("/team/login?error=missing_token", origin));
  }

  const res = await callTeamPublicApi("/api/public/team/exchange", {
    method: "POST",
    body: JSON.stringify({ token })
  });

  if (!res.ok) {
    return NextResponse.redirect(new URL("/team/login?error=expired_or_invalid", origin));
  }

  const payload = (await res.json().catch(() => ({}))) as { sessionToken?: string; needsPasswordSetup?: boolean };
  const sessionToken = typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (!sessionToken) {
    return NextResponse.redirect(new URL("/team/login?error=auth_failed", origin));
  }

  const redirectUrl = new URL("/team", origin);
  if (payload.needsPasswordSetup) {
    redirectUrl.searchParams.set("setup", "1");
  }

  const response = NextResponse.redirect(redirectUrl);
  response.cookies.set({
    name: TEAM_SESSION_COOKIE,
    value: sessionToken,
    ...teamSessionCookieOptions()
  });
  return response;
}
