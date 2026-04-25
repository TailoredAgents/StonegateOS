import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { TEAM_SESSION_COOKIE, teamSessionCookieOptions } from "@/lib/team-session";
import { callTeamPublicApi } from "../../../team/login/lib/api";
import { mobileLoginRedirectUrl } from "../lib/redirect";

export const dynamic = "force-dynamic";

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: string; detail?: string; message?: string };
      return json.error ?? json.detail ?? json.message ?? fallback;
    } catch {
      return text || fallback;
    }
  } catch {
    return fallback;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const formData = await request.formData();
  const emailRaw = formData.get("email");
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";

  if (!email || !password) {
    return NextResponse.redirect(mobileLoginRedirectUrl(request, "/mobile/login?error=missing_credentials"), 303);
  }

  const res = await callTeamPublicApi("/api/public/team/login-password", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  if (!res.ok) {
    const message = await readErrorMessage(res, "login_failed");
    return NextResponse.redirect(
      mobileLoginRedirectUrl(request, `/mobile/login?error=${encodeURIComponent(message)}`),
      303
    );
  }

  const payload = (await res.json().catch(() => ({}))) as { sessionToken?: string };
  const token = typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (!token) {
    return NextResponse.redirect(mobileLoginRedirectUrl(request, "/mobile/login?error=login_failed"), 303);
  }

  const response = NextResponse.redirect(mobileLoginRedirectUrl(request, "/mobile"), 303);
  response.cookies.set({
    name: TEAM_SESSION_COOKIE,
    value: token,
    ...teamSessionCookieOptions()
  });
  return response;
}
