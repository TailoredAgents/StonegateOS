import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { TEAM_SESSION_COOKIE, teamSessionCookieOptions } from "@/lib/team-session";
import { callTeamPublicApi } from "../../team/login/lib/api";

function resolveOrigin(request: NextRequest): string {
  const normalize = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(withScheme);
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") {
        return null;
      }
      return url.origin;
    } catch {
      return null;
    }
  };

  const configured = normalize(process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "");
  if (configured) return configured;

  const forwardedProto = (request.headers.get("x-forwarded-proto") ?? "")
    .split(",")[0]
    ?.trim()
    ?.toLowerCase();
  const forwardedHost = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
    .split(",")[0]
    ?.trim();

  const forwarded = normalize(`${forwardedProto === "http" ? "http" : "https"}://${forwardedHost}`);
  if (forwarded) return forwarded;

  const fallback = normalize(request.nextUrl.origin);
  return fallback ?? "https://stonegatejunkremoval.com";
}

export async function GET(request: NextRequest): Promise<Response> {
  const origin = resolveOrigin(request);
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!token) {
    return NextResponse.redirect(new URL("/mobile/login?error=missing_token", origin));
  }

  const res = await callTeamPublicApi("/api/public/team/exchange", {
    method: "POST",
    body: JSON.stringify({ token })
  });

  if (!res.ok) {
    return NextResponse.redirect(new URL("/mobile/login?error=expired_or_invalid", origin));
  }

  const payload = (await res.json().catch(() => ({}))) as { sessionToken?: string; needsPasswordSetup?: boolean };
  const sessionToken = typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (!sessionToken) {
    return NextResponse.redirect(new URL("/mobile/login?error=auth_failed", origin));
  }

  const redirectUrl = new URL("/mobile", origin);
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
