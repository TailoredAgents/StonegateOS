"use server";

import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  ADMIN_SESSION_COOKIE,
  getAdminSessionSecret,
} from "@/lib/admin-session";
import { CREW_SESSION_COOKIE, getCrewKey } from "@/lib/crew-session";
import { legacySessionSecretMatches } from "@/lib/legacy-session-secret";
import {
  breakGlassTeamSessionCookieOptions,
  TEAM_SESSION_COOKIE,
  teamSessionCookieOptions,
} from "@/lib/team-session";
import {
  callTeamApi,
  callTeamBreakGlassExchange,
  callTeamPublicApi,
  type LegacyRecoveryType,
} from "./lib/api";

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

function firstSafeHeaderValue(
  value: string | null,
  maxLength: number,
): string | null {
  const normalized = value?.split(",", 1)[0]?.trim() ?? "";
  const hasControlCharacters = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!normalized || hasControlCharacters) return null;
  return normalized.slice(0, maxLength);
}

export async function exchangeLegacyTeamSessionAction() {
  const jar = await cookies();
  const ownerCookie = jar.get(ADMIN_SESSION_COOKIE)?.value ?? null;
  const crewCookie = jar.get(CREW_SESSION_COOKIE)?.value ?? null;

  // Always execute both fixed-length comparisons so the branch does not leak
  // which legacy credential is configured or where a mismatch occurred.
  const ownerMatches = legacySessionSecretMatches(
    ownerCookie,
    getAdminSessionSecret(),
  );
  const crewMatches = legacySessionSecretMatches(crewCookie, getCrewKey());
  const legacyType: LegacyRecoveryType =
    ownerMatches !== crewMatches
      ? ownerMatches
        ? "owner"
        : "crew"
      : "invalid";

  const requestHeaders = await headers();
  const clientIp = firstSafeHeaderValue(
    requestHeaders.get("cf-connecting-ip") ??
      requestHeaders.get("x-real-ip") ??
      requestHeaders.get("x-forwarded-for"),
    128,
  );
  const userAgent = firstSafeHeaderValue(requestHeaders.get("user-agent"), 512);

  let response: Response;
  try {
    // Invalid attempts still reach the narrow service so the durable limiter
    // covers arbitrary/stale cookies without transmitting either secret.
    response = await callTeamBreakGlassExchange({
      legacyType,
      clientIp,
      userAgent,
    });
  } catch {
    redirect("/team/login?error=recovery_failed");
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after")?.trim();
    const retryQuery =
      retryAfter && /^\d{1,5}$/u.test(retryAfter)
        ? `&retryAfter=${encodeURIComponent(retryAfter)}`
        : "";
    redirect(`/team/login?error=recovery_failed${retryQuery}`);
  }

  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    data?: { sessionToken?: unknown; expiresAt?: unknown };
  } | null;
  const sessionToken =
    typeof payload?.data?.sessionToken === "string"
      ? payload.data.sessionToken.trim()
      : "";
  const expiresAt =
    typeof payload?.data?.expiresAt === "string"
      ? Date.parse(payload.data.expiresAt)
      : Number.NaN;
  if (
    payload?.ok !== true ||
    !sessionToken ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    redirect("/team/login?error=recovery_failed");
  }

  jar.set(
    TEAM_SESSION_COOKIE,
    sessionToken,
    breakGlassTeamSessionCookieOptions(),
  );
  jar.delete(ADMIN_SESSION_COOKIE);
  jar.delete(CREW_SESSION_COOKIE);
  redirect("/team");
}

export async function requestTeamMagicLinkAction(formData: FormData) {
  const identifierRaw = formData.get("identifier");
  const identifier =
    typeof identifierRaw === "string" ? identifierRaw.trim() : "";
  if (!identifier) {
    redirect("/team/login?error=email_or_phone_required");
  }

  const isEmail = identifier.includes("@");
  let response: Response;
  try {
    response = await callTeamPublicApi("/api/public/team/request-link", {
      method: "POST",
      body: JSON.stringify(
        isEmail ? { email: identifier } : { phone: identifier },
      ),
    });
  } catch {
    redirect("/team/login?error=login_service_unavailable");
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after")?.trim() ?? "60";
    redirect(
      `/team/login?error=too_many_login_requests&retryAfter=${encodeURIComponent(retryAfter)}`,
    );
  }
  if (!response.ok) {
    redirect("/team/login?error=login_service_unavailable");
  }

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

  let res: Response;
  try {
    res = await callTeamPublicApi("/api/public/team/login-password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  } catch {
    redirect("/team/login?error=login_service_unavailable");
  }

  if (!res.ok) {
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after")?.trim() ?? "60";
      redirect(
        `/team/login?error=too_many_login_requests&retryAfter=${encodeURIComponent(retryAfter)}`,
      );
    }
    const msg = await readErrorMessage(res, "login_failed");
    redirect(`/team/login?error=${encodeURIComponent(msg)}`);
  }

  const payload = (await res.json().catch(() => ({}))) as {
    sessionToken?: string;
  };
  const token =
    typeof payload.sessionToken === "string" ? payload.sessionToken : "";
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
    redirect("/team/settings?error=password_too_short" as Route);
  }

  const res = await callTeamApi("/api/team/password", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const msg = await readErrorMessage(res, "save_failed");
    redirect(`/team/settings?error=${encodeURIComponent(msg)}` as Route);
  }

  redirect("/team/settings?saved=1" as Route);
}
