import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { requireTeamRole } from "@/app/api/team/auth";
import { parseAppointmentBookingFormData } from "@/app/team/lib/booking-details";
import { resolveLockedCrewPayout } from "@/app/team/lib/locked-crew-payout";

export const dynamic = "force-dynamic";

function isQuoteOnlyAppointmentType(value: FormDataEntryValue | null): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "in_person_quote" || normalized === "in_person_estimate"
  );
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

function hasEnteredValue(value: FormDataEntryValue | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function wantsBookingDetailsUpdate(formData: FormData): boolean {
  const value = formData.get("updateBookingDetails");
  return typeof value === "string" && value.trim().length > 0;
}

function redirectWithFlash(
  redirectTo: URL,
  name: "myst-flash" | "myst-flash-error",
  value: string,
): NextResponse {
  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({ name, value, path: "/" });
  return response;
}

export async function POST(request: NextRequest): Promise<Response> {
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=calendar");
  const auth = await requireTeamRole(request, {
    redirectTo,
    roles: ["owner", "office", "crew"],
  });

  if (!auth.ok) return auth.response;

  const formData = await request.formData();
  const appointmentId = formData.get("appointmentId");
  const status = formData.get("status");
  const appointmentType = formData.get("appointmentType");

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
  const isQuoteOnly = isQuoteOnlyAppointmentType(appointmentType);
  const shouldUpdateBookingDetails =
    statusValue === "completed" &&
    !isQuoteOnly &&
    wantsBookingDetailsUpdate(formData);

  if (statusValue === "completed" && !isQuoteOnly) {
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
    if (crewIds.length === 0) {
      const response = NextResponse.redirect(redirectTo, 303);
      response.cookies.set({
        name: "myst-flash-error",
        value: "Select at least one crew member before marking complete.",
        path: "/",
      });
      return response;
    }

    const resolvedCrewPayout = resolveLockedCrewPayout(crewIds);
    if (!resolvedCrewPayout.ok) {
      const response = NextResponse.redirect(redirectTo, 303);
      response.cookies.set({
        name: "myst-flash-error",
        value: "Invalid crew payout split for that crew combination.",
        path: "/",
      });
      return response;
    }
    payload["crewMembers"] = resolvedCrewPayout.splits;
  }

  if (shouldUpdateBookingDetails) {
    const bookingDetailsResult = parseAppointmentBookingFormData(formData);
    if (!bookingDetailsResult.ok) {
      return redirectWithFlash(
        redirectTo,
        "myst-flash-error",
        bookingDetailsResult.error,
      );
    }

    const bookingUpdateResponse = await callAdminApi(
      `/api/appointments/${appointmentId.trim()}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          quotedTotalCents: bookingDetailsResult.quotedTotalCents,
          bookingDetails: bookingDetailsResult.bookingDetails,
        }),
      },
    );

    if (!bookingUpdateResponse.ok) {
      let message = "Unable to update quote and job size";
      try {
        const data = (await bookingUpdateResponse.json()) as {
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
      return redirectWithFlash(redirectTo, "myst-flash-error", message);
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
    value:
      statusValue === "completed" && isQuoteOnly
        ? "Quote marked done"
        : statusValue === "completed"
          ? "Job completed"
          : statusValue === "canceled"
            ? "Appointment canceled"
            : "Appointment updated",
    path: "/",
  });
  return response;
}
