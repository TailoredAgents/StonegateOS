"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TEAM_SESSION_COOKIE, teamSessionCookieOptions } from "@/lib/team-session";
import { callTeamApi, callTeamPublicApi } from "./lib/api";

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

export async function requestTeamMagicLinkAction(formData: FormData) {
  const identifierRaw = formData.get("identifier");
  const identifier = typeof identifierRaw === "string" ? identifierRaw.trim() : "";
  if (!identifier) {
    redirect("/team/login?error=email_or_phone_required");
  }

  const isEmail = identifier.includes("@");
  await callTeamPublicApi("/api/public/team/request-link", {
    method: "POST",
    body: JSON.stringify(isEmail ? { email: identifier } : { phone: identifier })
  });

  redirect("/team/login?sent=1");
}

export async function teamPasswordLoginAction(formData: FormData) {
  const emailRaw = formData.get("email");
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!email || !password) {
    redirect("/team/login?error=missing_credentials");
  }

  const res = await callTeamPublicApi("/api/public/team/login-password", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  if (!res.ok) {
    const msg = await readErrorMessage(res, "login_failed");
    redirect(`/team/login?error=${encodeURIComponent(msg)}`);
  }

  const payload = (await res.json().catch(() => ({}))) as { sessionToken?: string };
  const token = typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (!token) {
    redirect("/team/login?error=login_failed");
  }

  (await cookies()).set(TEAM_SESSION_COOKIE, token, teamSessionCookieOptions());
  redirect("/team");
}

export async function teamLogoutAction() {
  const jar = await cookies();
  const token = jar.get(TEAM_SESSION_COOKIE)?.value ?? "";
  if (token) {
    await callTeamApi("/api/team/logout", { method: "POST" }).catch(() => null);
  }
  jar.delete(TEAM_SESSION_COOKIE);
  redirect("/team/login");
}

export async function teamSetPasswordAction(formData: FormData) {
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!password || password.length < 10) {
    redirect("/team?tab=settings&error=password_too_short");
  }

  const res = await callTeamApi("/api/team/password", {
    method: "POST",
    body: JSON.stringify({ password })
  });
  if (!res.ok) {
    const msg = await readErrorMessage(res, "save_failed");
    redirect(`/team?tab=settings&error=${encodeURIComponent(msg)}`);
  }

  redirect("/team?tab=settings&saved=1");
}
