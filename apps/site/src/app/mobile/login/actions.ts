"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TEAM_SESSION_COOKIE, teamSessionCookieOptions } from "@/lib/team-session";
import { callTeamPublicApi } from "../../team/login/lib/api";

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

export async function requestMobileMagicLinkAction(formData: FormData) {
  const identifierRaw = formData.get("identifier");
  const identifier = typeof identifierRaw === "string" ? identifierRaw.trim() : "";
  if (!identifier) {
    redirect("/mobile/login?error=email_or_phone_required");
  }

  const isEmail = identifier.includes("@");
  await callTeamPublicApi("/api/public/team/request-link", {
    method: "POST",
    body: JSON.stringify({
      ...(isEmail ? { email: identifier } : { phone: identifier }),
      redirectPath: "/mobile/auth"
    })
  });

  redirect("/mobile/login?sent=1");
}

export async function mobilePasswordLoginAction(formData: FormData) {
  const emailRaw = formData.get("email");
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!email || !password) {
    redirect("/mobile/login?error=missing_credentials");
  }

  const res = await callTeamPublicApi("/api/public/team/login-password", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  if (!res.ok) {
    const msg = await readErrorMessage(res, "login_failed");
    redirect(`/mobile/login?error=${encodeURIComponent(msg)}`);
  }

  const payload = (await res.json().catch(() => ({}))) as { sessionToken?: string };
  const token = typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (!token) {
    redirect("/mobile/login?error=login_failed");
  }

  (await cookies()).set(TEAM_SESSION_COOKIE, token, teamSessionCookieOptions());
  redirect("/mobile");
}
