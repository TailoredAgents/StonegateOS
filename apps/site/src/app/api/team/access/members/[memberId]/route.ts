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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> }
): Promise<Response> {
  const redirectTo = buildRedirect(request);
  if (!(await isOwnerRequest(request))) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Please sign in again and retry.");
    return response;
  }

  const { memberId } = await context.params;
  if (!memberId) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Member ID missing");
    return response;
  }

  const formData = await request.formData();
  const name = typeof formData.get("name") === "string" ? String(formData.get("name")).trim() : "";
  const email = typeof formData.get("email") === "string" ? String(formData.get("email")).trim() : "";
  const roleId = typeof formData.get("roleId") === "string" ? String(formData.get("roleId")).trim() : "";
  const phone = typeof formData.get("phone") === "string" ? String(formData.get("phone")).trim() : "";
  const active = formData.get("active") === "on";
  const defaultCrewSplitPercent =
    typeof formData.get("defaultCrewSplitPercent") === "string"
      ? String(formData.get("defaultCrewSplitPercent")).trim()
      : "";

  if (!name) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Name is required");
    return response;
  }

  const payload: Record<string, unknown> = {
    name,
    active
  };

  payload["email"] = email.length > 0 ? email : null;
  payload["roleId"] = roleId.length > 0 ? roleId : null;
  payload["phone"] = phone.length > 0 ? phone : null;

  if (defaultCrewSplitPercent.length === 0) {
    payload["defaultCrewSplitBps"] = null;
  } else {
    const parsed = Number(defaultCrewSplitPercent);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      const response = NextResponse.redirect(redirectTo, 303);
      setFlash(response, "error", "Crew split % must be between 0 and 100");
      return response;
    }
    payload["defaultCrewSplitBps"] = Math.round(parsed * 100);
  }

  const apiResponse = await callAdminApi(`/api/admin/team/members/${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

  if (!apiResponse.ok) {
    let message = "Unable to update member";
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
  setFlash(response, "ok", "Member updated");
  return response;
}

