"use server";

import type { Route } from "next";
import { cookies } from "next/headers";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";
import { callPartnerApi, callPartnerPublicApi } from "./lib/api";
import { normalizePartnerReturnTo } from "./lib/safe-return";

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as {
        error?: string;
        detail?: string;
        message?: string;
      };
      return json.error ?? json.detail ?? json.message ?? fallback;
    } catch {
      return text || fallback;
    }
  } catch {
    return fallback;
  }
}

function validHttpOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

async function partnerAuthForwardHeaders(): Promise<Headers> {
  const incoming = await headers();
  const result = new Headers();
  const configuredOrigin = validHttpOrigin(
    process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? null,
  );
  const forwardedHost =
    incoming.get("x-forwarded-host") ?? incoming.get("host");
  const forwardedProtocol =
    incoming.get("x-forwarded-proto") ??
    (process.env["NODE_ENV"] === "production" ? "https" : "http");
  const requestOrigin =
    validHttpOrigin(incoming.get("origin")) ??
    (forwardedHost
      ? validHttpOrigin(`${forwardedProtocol}://${forwardedHost}`)
      : null) ??
    configuredOrigin;
  if (requestOrigin) result.set("Origin", requestOrigin);
  const forwardedIp =
    incoming.get("cf-connecting-ip") ??
    incoming.get("x-real-ip") ??
    incoming.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  if (forwardedIp) result.set("X-Forwarded-For", forwardedIp.slice(0, 128));
  const userAgent = incoming.get("user-agent")?.trim();
  if (userAgent) result.set("User-Agent", userAgent.slice(0, 512));
  const correlationId = incoming.get("x-correlation-id")?.trim();
  if (correlationId) result.set("x-correlation-id", correlationId);
  return result;
}

export async function partnerPasswordLoginAction(formData: FormData) {
  const emailRaw = formData.get("email");
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!email || !password) {
    redirect("/partners/login?error=missing_credentials");
  }

  const rememberMe = formData.get("rememberMe") === "on";
  const returnTo = normalizePartnerReturnTo(formData.get("returnTo"));
  const jar = await cookies();

  const res = await callPartnerPublicApi(
    "/api/public/partners/login-password",
    {
      method: "POST",
      headers: await partnerAuthForwardHeaders(),
      body: JSON.stringify({ email, password, rememberMe }),
    },
  );

  if (!res.ok) {
    const msg = await readErrorMessage(res, "login_failed");
    const query = new URLSearchParams({ error: msg });
    if (returnTo !== "/partners/overview") query.set("returnTo", returnTo);
    redirect(`/partners/login?${query.toString()}`);
  }

  const payload = (await res.json().catch(() => ({}))) as {
    status?: string;
    sessionToken?: string;
    expiresAt?: string;
  };
  const token =
    typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (!token) {
    redirect("/partners/login?error=login_failed");
  }
  const expiresAt = new Date(payload.expiresAt ?? "");
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now()
  ) {
    redirect("/partners/login?error=login_failed");
  }

  jar.set({
    name: PARTNER_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });

  redirect(returnTo as Route);
}

export async function partnerSetPasswordAction(formData: FormData) {
  const currentPasswordRaw = formData.get("currentPassword");
  const currentPassword =
    typeof currentPasswordRaw === "string" ? currentPasswordRaw : "";
  const newPasswordRaw = formData.get("newPassword");
  const newPassword = typeof newPasswordRaw === "string" ? newPasswordRaw : "";
  const confirmPasswordRaw = formData.get("confirmPassword");
  const confirmPassword =
    typeof confirmPasswordRaw === "string" ? confirmPasswordRaw : "";
  if (newPassword.length < 15 || newPassword.length > 128) {
    redirect("/partners/settings?error=password_too_short");
  }
  if (newPassword !== confirmPassword) {
    redirect("/partners/settings?error=password_confirmation_mismatch");
  }

  const res = await callPartnerApi("/api/portal/v2/security/password", {
    method: "POST",
    body: JSON.stringify({
      ...(currentPassword ? { currentPassword } : {}),
      newPassword,
      confirmPassword,
    }),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      error?: string;
      fieldErrors?: Record<string, string>;
    } | null;
    const code = payload?.fieldErrors?.["currentPassword"]
      ? payload.fieldErrors["currentPassword"]
          .toLowerCase()
          .includes("incorrect")
        ? "current_password_incorrect"
        : "current_password_required"
      : payload?.fieldErrors?.["confirmPassword"]
        ? "password_confirmation_mismatch"
        : payload?.fieldErrors?.["newPassword"]
          ? payload.fieldErrors["newPassword"].toLowerCase().includes("already")
            ? "password_reused"
            : "password_too_short"
          : payload?.error === "recent_authentication_required"
            ? "recent_authentication_required"
            : payload?.error === "rate_limited"
              ? "rate_limited"
              : "save_failed";
    redirect(`/partners/settings?error=${encodeURIComponent(code)}`);
  }

  const saved = (await res.json().catch(() => null)) as {
    otherSessionsRevoked?: number;
  } | null;
  const query = new URLSearchParams({ saved: "1" });
  if (
    typeof saved?.otherSessionsRevoked === "number" &&
    Number.isInteger(saved.otherSessionsRevoked) &&
    saved.otherSessionsRevoked > 0
  ) {
    query.set("sessionsRevoked", String(saved.otherSessionsRevoked));
  }
  redirect(`/partners/settings?${query.toString()}`);
}
