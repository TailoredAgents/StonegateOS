import type { NextRequest } from "next/server";
import {
  safeTeamReturnPath,
  teamLoginHref,
  teamPasswordSetupHref,
} from "@myst-os/sdk";
import {
  TEAM_SESSION_COOKIE,
  teamSessionCookieOptions,
} from "@/lib/team-session";
import { callTeamPublicApi } from "../login/lib/api";
import { createTeamAuthRedirect } from "./redirect";

function failedAuthRedirect(error: string, returnTo?: string | null): Response {
  const response = createTeamAuthRedirect(teamLoginHref(returnTo, { error }));
  response.cookies.set({
    name: TEAM_SESSION_COOKIE,
    value: "",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim() ?? "";
  const returnTo = safeTeamReturnPath(url.searchParams.get("returnTo"));
  if (!token) {
    return failedAuthRedirect("missing_token", returnTo);
  }

  let res: Response;
  try {
    res = await callTeamPublicApi("/api/public/team/exchange", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  } catch {
    return failedAuthRedirect("login_service_unavailable", returnTo);
  }

  if (!res.ok) {
    return failedAuthRedirect(
      res.status >= 500 ? "login_service_unavailable" : "expired_or_invalid",
      returnTo,
    );
  }

  const payload = (await res.json().catch(() => ({}))) as {
    sessionToken?: string;
    needsPasswordSetup?: boolean;
  } | null;
  const sessionToken =
    typeof payload?.sessionToken === "string"
      ? payload.sessionToken.trim()
      : "";
  if (!sessionToken) {
    return failedAuthRedirect("auth_failed", returnTo);
  }

  const response = createTeamAuthRedirect(
    payload?.needsPasswordSetup === true
      ? teamPasswordSetupHref(returnTo)
      : (returnTo ?? "/team"),
  );
  response.cookies.set({
    name: TEAM_SESSION_COOKIE,
    value: sessionToken,
    ...teamSessionCookieOptions(),
  });
  return response;
}
