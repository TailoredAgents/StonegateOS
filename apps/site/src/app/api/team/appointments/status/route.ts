import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { requireTeamRole } from "@/app/api/team/auth";
import { resolveLockedCrewPayout } from "@/app/team/lib/locked-crew-payout";

export const dynamic = "force-dynamic";

function parseUsdToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[$,\s]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function hasEnteredValue(value: FormDataEntryValue | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function POST(request: NextRequest): Promise<Response> {
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=myday");
  const auth = await requireTeamRole(request, {
    redirectTo,
    roles: ["owner", "office", "crew"],
  });

  if (!auth.ok) return auth.response;

  const formData = await request.formData();
  const appointmentId = formData.get("appointmentId");
  const status = formData.get("status");

  if (typeof appointmentId !== "string" || appointmentId.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Appointment ID missing",
      path: "/",
    });
    return response;
  }

  if (typeof status !== "string" || status.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Status missing",
      path: "/",
    });
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
        path: "/",
      });
      return response;
    }
    payload["finalTotalCents"] = cents;

    const cardTipRaw = formData.get("cardTip");
    const cardTipCents = parseUsdToCents(cardTipRaw);
    if (hasEnteredValue(cardTipRaw) && cardTipCents === null) {
      const response = NextResponse.redirect(redirectTo, 303);
      response.cookies.set({
        name: "myst-flash-error",
        value: "Card tips must be 0 or more.",
        path: "/",
      });
      return response;
    }
    if (cardTipCents !== null) {
      payload["cardTipCents"] = cardTipCents;
    }

    const crewIds = formData
      .getAll("crewMemberId")
      .filter((value): value is string => typeof value === "string");
    if (crewIds.length > 0) {
      const resolvedCrewPayout = resolveLockedCrewPayout(crewIds);
      if (!resolvedCrewPayout.ok) {
        const response = NextResponse.redirect(redirectTo, 303);
        response.cookies.set({
          name: "myst-flash-error",
          value:
            "No locked crew payout rule exists for that crew combination yet.",
          path: "/",
        });
        return response;
      }
      payload["crewMembers"] = resolvedCrewPayout.splits;
    } else {
      payload["crewMembers"] = [];
    }
  }

  const apiResponse = await callAdminApi(
    `/api/appointments/${appointmentId.trim()}/status`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  if (!apiResponse.ok) {
    let message = "Unable to update appointment";
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
  response.cookies.set({
    name: "myst-flash",
    value: "Appointment updated",
    path: "/",
  });
  return response;
}
