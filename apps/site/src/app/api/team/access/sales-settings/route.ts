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

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "access.manage",
    redirectTo: new URL("/team?tab=access", request.url),
  });
  if (!auth.ok) return auth.response;

  const redirectTo = buildRedirect(request);
  const formData = await request.formData();
  const memberIdRaw = formData.get("defaultAssigneeMemberId");
  if (memberIdRaw !== null && typeof memberIdRaw !== "string") {
    const response = NextResponse.redirect(redirectTo, 303);
    setFlash(response, "error", "Invalid selection");
    return response;
  }

  const memberId = typeof memberIdRaw === "string" ? memberIdRaw.trim() : "";

  const apiResponse = await callAdminApiAs(
    auth.principal,
    "/api/admin/sales/settings",
    {
      method: "PATCH",
      body: JSON.stringify({
        defaultAssigneeMemberId: memberId.length ? memberId : null,
      }),
    },
  );

  if (!apiResponse.ok) {
    let message = "Unable to update default salesperson";
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
  setFlash(response, "ok", "Default salesperson updated");
  return response;
}
