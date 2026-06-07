import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { requireTeamRole } from "@/app/api/team/auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=calendar");
  const auth = await requireTeamRole(request, {
    redirectTo,
    roles: ["owner", "office", "crew"],
  });

  if (!auth.ok) return auth.response;

  const formData = await request.formData();
  const appointmentId = formData.get("appointmentId");
  const body = formData.get("body");

  if (typeof appointmentId !== "string" || appointmentId.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Appointment ID missing",
      path: "/",
    });
    return response;
  }

  if (typeof body !== "string" || body.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Note body required",
      path: "/",
    });
    return response;
  }

  const apiResponse = await callAdminApi(
    `/api/appointments/${appointmentId.trim()}/notes`,
    {
      method: "POST",
      body: JSON.stringify({ body: body.trim() }),
    },
  );

  if (!apiResponse.ok) {
    let message = "Unable to add note";
    try {
      const data = (await apiResponse.json()) as {
        error?: string;
        message?: string;
      };
      const candidate = data.message ?? data.error;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        message = candidate.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: message,
      path: "/",
    });
    return response;
  }

  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({ name: "myst-flash", value: "Note added", path: "/" });
  return response;
}
