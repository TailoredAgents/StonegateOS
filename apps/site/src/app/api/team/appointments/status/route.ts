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

function parseUsdToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[$,\s]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function parsePercentToBps(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 100);
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
  const status = formData.get("status");

  if (typeof appointmentId !== "string" || appointmentId.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Appointment ID missing", path: "/" });
    return response;
  }

  if (typeof status !== "string" || status.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Status missing", path: "/" });
    return response;
  }

  const statusValue = status.trim();
  const payload: Record<string, unknown> = { status: statusValue };

  if (statusValue === "completed") {
    const cents = parseUsdToCents(formData.get("finalTotal"));
    if (cents === null) {
      const response = NextResponse.redirect(redirectTo, 303);
      response.cookies.set({
        name: "myst-flash-error",
        value: "Amount collected is required to mark complete.",
        path: "/"
      });
      return response;
    }
    payload["finalTotalCents"] = cents;

    const crewIds = formData.getAll("crewMemberId").filter((value): value is string => typeof value === "string");
    if (crewIds.length > 0) {
      const crewMembers: Array<{ memberId: string; splitBps: number }> = [];
      let totalBps = 0;
      for (const id of crewIds) {
        const percentRaw = formData.get(`crewSplitPercent_${id}`);
        const bps = parsePercentToBps(percentRaw);
        if (bps === null) {
          const response = NextResponse.redirect(redirectTo, 303);
          response.cookies.set({
            name: "myst-flash-error",
            value: "Crew split % is required for each selected crew member.",
            path: "/"
          });
          return response;
        }
        totalBps += bps;
        crewMembers.push({ memberId: id, splitBps: bps });
      }

      if (totalBps !== 10000) {
        const response = NextResponse.redirect(redirectTo, 303);
        response.cookies.set({
          name: "myst-flash-error",
          value: "Crew split % must add up to 100.",
          path: "/"
        });
        return response;
      }

      payload["crewMembers"] = crewMembers;
    }
  }

  const apiResponse = await callAdminApi(`/api/appointments/${appointmentId.trim()}/status`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!apiResponse.ok) {
    let message = "Unable to update appointment";
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
  response.cookies.set({ name: "myst-flash", value: "Appointment updated", path: "/" });
  return response;
}
