import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";

const ADMIN_COOKIE = "myst-admin-session";
const CREW_COOKIE = "myst-crew-session";

export const dynamic = "force-dynamic";

function getSafeRedirectUrl(request: NextRequest): URL {
  const fallback = new URL("/team?tab=myday", request.url);
  const referer = request.headers.get("referer");
  if (!referer) return fallback;
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== fallback.origin) return fallback;
    return refererUrl;
  } catch {
    return fallback;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const jar = request.cookies;
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const hasCrew = Boolean(jar.get(CREW_COOKIE)?.value);
  const redirectTo = getSafeRedirectUrl(request);

  if (!hasOwner && !hasCrew) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Please sign in again and retry.",
      path: "/"
    });
    return response;
  }

  const formData = await request.formData();
  const appointmentId = formData.get("appointmentId");
  const body = formData.get("body");

  if (typeof appointmentId !== "string" || appointmentId.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Appointment ID missing", path: "/" });
    return response;
  }

  if (typeof body !== "string" || body.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Note body required", path: "/" });
    return response;
  }

  const apiResponse = await callAdminApi(`/api/appointments/${appointmentId.trim()}/notes`, {
    method: "POST",
    body: JSON.stringify({ body: body.trim() })
  });

  if (!apiResponse.ok) {
    let message = "Unable to add note";
    try {
      const data = (await apiResponse.json()) as { error?: string; message?: string };
      const candidate = data.message ?? data.error;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        message = candidate.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: message, path: "/" });
    return response;
  }

  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({ name: "myst-flash", value: "Note added", path: "/" });
  return response;
}

