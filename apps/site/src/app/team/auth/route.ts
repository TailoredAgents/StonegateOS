import type { NextRequest } from "next/server";
import {
  TEAM_SESSION_COOKIE,
  teamSessionCookieOptions,
} from "@/lib/team-session";
import { callTeamPublicApi } from "../login/lib/api";
import { createTeamAuthRedirect } from "./redirect";

function failedAuthRedirect(error: string): Response {
  const response = createTeamAuthRedirect(
    `/team/login?error=${encodeURIComponent(error)}`,
  );
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
  if (!token) {
    return failedAuthRedirect("missing_token");
  }

  let res: Response;
  try {
    res = await callTeamPublicApi("/api/public/team/exchange", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  } catch {
    return failedAuthRedirect("login_service_unavailable");
  }

  if (!res.ok) {
    return failedAuthRedirect(
      res.status >= 500 ? "login_service_unavailable" : "expired_or_invalid",
    );
  }

  const payload = (await res.json().catch(() => ({}))) as {
    sessionToken?: string;
    needsPasswordSetup?: boolean;
  };
  const sessionToken =
    typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (!sessionToken) {
    return failedAuthRedirect("auth_failed");
  }

  const response = createTeamAuthRedirect(
    payload.needsPasswordSetup ? "/team/settings?setup=1" : "/team",
  );
  response.cookies.set({
    name: TEAM_SESSION_COOKIE,
    value: sessionToken,
    ...teamSessionCookieOptions(),
  });
  return response;
}
