import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-session";
import { CREW_SESSION_COOKIE } from "@/lib/crew-session";
import { TEAM_SESSION_COOKIE } from "@/lib/team-session";

type TeamRole = "owner" | "office" | "crew";

type TeamSessionResponse = {
  ok?: boolean;
  teamMember?: { roleSlug?: string | null };
};

function resolveApiBase(): string {
  return (process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "").replace(/\/$/, "");
}

export async function resolveTeamRoleFromRequest(request: NextRequest): Promise<TeamRole | null> {
  if (request.cookies.get(ADMIN_SESSION_COOKIE)?.value) return "owner";
  if (request.cookies.get(CREW_SESSION_COOKIE)?.value) return "crew";

  const token = request.cookies.get(TEAM_SESSION_COOKIE)?.value ?? "";
  if (!token) return null;

  const base = resolveApiBase();
  if (!base) return null;

  const res = await fetch(`${base}/api/public/team/session`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });

  if (!res.ok) return null;
  const payload = (await res.json().catch(() => null)) as TeamSessionResponse | null;
  if (!payload?.ok) return null;
  const roleSlug = payload.teamMember?.roleSlug;
  if (roleSlug === "owner") return "owner";
  if (roleSlug === "crew") return "crew";
  return "office";
}

export async function requireTeamRole(
  request: NextRequest,
  options: {
    roles?: TeamRole[];
    redirectTo?: URL;
    returnJson?: boolean;
    flashError?: string;
  } = {}
): Promise<{ ok: true; role: TeamRole } | { ok: false; response: Response }> {
  const allowed = options.roles ?? ["owner", "office", "crew"];
  const role = await resolveTeamRoleFromRequest(request);
  const flashError = options.flashError ?? "Please sign in again and retry.";

  if (!role || !allowed.includes(role)) {
    if (options.returnJson) {
      const response = NextResponse.json({ error: "unauthorized" }, { status: 401 });
      response.cookies.set({ name: "myst-flash-error", value: flashError, path: "/" });
      return { ok: false, response };
    }

    const redirectTo = options.redirectTo ?? new URL("/team", request.url);
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: flashError, path: "/" });
    return { ok: false, response };
  }

  return { ok: true, role };
}

