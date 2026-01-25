import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-session";
import { TEAM_SESSION_COOKIE } from "@/lib/team-session";

export const dynamic = "force-dynamic";

function buildRedirect(request: NextRequest): URL {
  return getSafeRedirectUrl(request, "/team?tab=access");
}

async function isOwnerRequest(request: NextRequest): Promise<boolean> {
  if (request.cookies.get(ADMIN_SESSION_COOKIE)?.value) return true;

  const token = request.cookies.get(TEAM_SESSION_COOKIE)?.value ?? "";
  if (!token) return false;

  const base = (process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "").replace(/\/$/, "");
  if (!base) return false;

  const res = await fetch(`${base}/api/public/team/session`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!res.ok) return false;

  const payload = (await res.json().catch(() => null)) as {
    ok?: boolean;
    teamMember?: { roleSlug?: string | null };
  } | null;
  return Boolean(payload?.ok && payload?.teamMember?.roleSlug === "owner");
}

function setFlash(response: NextResponse, kind: "ok" | "error", message: string) {
  response.cookies.set({
    name: kind === "ok" ? "myst-flash" : "myst-flash-error",
    value: message,
    path: "/"
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const redirectTo = buildRedirect(request);
  if (!(await isOwnerRequest(request))) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Please sign in again and retry.");
    return response;
  }

  const formData = await request.formData();
  const name = typeof formData.get("name") === "string" ? String(formData.get("name")).trim() : "";
  const slug = typeof formData.get("slug") === "string" ? String(formData.get("slug")).trim() : "";
  const permissionsRaw = typeof formData.get("permissions") === "string" ? String(formData.get("permissions")).trim() : "";

  if (!name) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Role name required");
    return response;
  }
  if (!slug) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Role slug required");
    return response;
  }

  const permissions =
    permissionsRaw.length > 0
      ? permissionsRaw
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];

  const apiResponse = await callAdminApi("/api/admin/roles", {
    method: "POST",
    body: JSON.stringify({ name, slug, permissions })
  });

  if (!apiResponse.ok) {
    let message = "Unable to create role";
    try {
      const data = (await apiResponse.json()) as { message?: string; error?: string };
      const extracted = data.message ?? data.error;
      if (typeof extracted === "string" && extracted.trim().length > 0) {
        message = extracted.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }

    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", message);
    return response;
  }

  const response = NextResponse.redirect(redirectTo, 303);
  setFlash(response, "ok", "Role created");
  return response;
}

