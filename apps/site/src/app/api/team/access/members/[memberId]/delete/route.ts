import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";

export const dynamic = "force-dynamic";

function buildRedirect(request: NextRequest): URL {
  return getSafeRedirectUrl(request, "/team?tab=access");
}

function setFlash(
  response: NextResponse,
  kind: "ok" | "error",
  message: string,
) {
  response.cookies.set({
    name: kind === "ok" ? "myst-flash" : "myst-flash-error",
    value: message,
    path: "/",
  });
}

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> },
): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "access.manage",
    redirectTo: new URL("/team?tab=access", request.url),
  });
  if (!auth.ok) return auth.response;

  const redirectTo = buildRedirect(request);
  const { memberId } = await context.params;
  if (!memberId) {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Member ID missing");
    return response;
  }

  const formData = await request.formData();
  const confirm = readFormString(formData, "confirm").toUpperCase();
  if (confirm !== "DELETE") {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", 'Type "DELETE" to confirm');
    return response;
  }

  const apiResponse = await callAdminApiAs(
    auth.principal,
    `/api/admin/team/members/${encodeURIComponent(memberId)}`,
    {
      method: "DELETE",
    },
  );

  if (!apiResponse.ok) {
    let message = "Unable to delete member";
    try {
      const data = (await apiResponse.json()) as {
        message?: string;
        error?: string;
      };
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
  setFlash(response, "ok", "Team member deleted");
  return response;
}
