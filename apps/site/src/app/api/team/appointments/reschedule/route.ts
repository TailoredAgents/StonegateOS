import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { requireTeamPrincipal } from "@/app/api/team/auth";

export const dynamic = "force-dynamic";

function wantsJson(request: NextRequest): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

function respondFailure(
  returnJson: boolean,
  redirectTo: URL,
  message: string,
  status = 422,
): NextResponse {
  if (returnJson) {
    return NextResponse.json(
      { ok: false, error: "invalid", message, retryable: status >= 500 },
      { status },
    );
  }
  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({ name: "myst-flash-error", value: message, path: "/" });
  return response;
}

export async function POST(request: NextRequest): Promise<Response> {
  const returnJson = wantsJson(request);
  const redirectTo = getSafeRedirectUrl(request, "/team/calendar");
  const auth = await requireTeamPrincipal(request, {
    permissions: "appointments.update",
    returnJson,
    redirectTo,
  });
  if (!auth.ok) return auth.response;

  const formData = await request.formData();
  const appointmentId = formData.get("appointmentId");
  const preferredDate = formData.get("preferredDate");
  const startTime = formData.get("startTime");
  const expectedVersion = formData.get("expectedVersion");
  const conflictOverrideReason = formData.get("conflictOverrideReason");
  const conflictAcknowledgement = formData.get("conflictAcknowledgement");
  const conflictFingerprint = formData.get("conflictFingerprint");

  if (typeof appointmentId !== "string" || !appointmentId.trim()) {
    return respondFailure(returnJson, redirectTo, "Appointment ID missing");
  }
  if (
    typeof preferredDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(preferredDate.trim())
  ) {
    return respondFailure(returnJson, redirectTo, "Choose a valid new date");
  }
  if (
    typeof startTime !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(startTime.trim())
  ) {
    return respondFailure(
      returnJson,
      redirectTo,
      "Choose a valid Eastern start time",
    );
  }

  const version =
    typeof expectedVersion === "string" && expectedVersion.trim()
      ? expectedVersion.trim()
      : null;
  const idempotencyKey = request.headers.get("idempotency-key");

  try {
    const apiResponse = await callAdminApiAs(
      auth.principal,
      `/api/web/appointments/${encodeURIComponent(appointmentId.trim())}/reschedule`,
      {
        method: "POST",
        headers: {
          ...(version ? { "If-Match": `"${version}"` } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({
          preferredDate: preferredDate.trim(),
          startTime: startTime.trim(),
          ...(version ? { expectedVersion: version } : {}),
          ...(typeof conflictOverrideReason === "string" &&
          conflictOverrideReason.trim()
            ? { conflictOverrideReason: conflictOverrideReason.trim() }
            : {}),
          ...(typeof conflictAcknowledgement === "string" &&
          conflictAcknowledgement.trim()
            ? { conflictAcknowledgement: conflictAcknowledgement.trim() }
            : {}),
          ...(typeof conflictFingerprint === "string" &&
          /^[0-9a-f]{64}$/u.test(conflictFingerprint.trim())
            ? { conflictFingerprint: conflictFingerprint.trim() }
            : {}),
        }),
      },
    );

    const result = (await apiResponse.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!apiResponse.ok) {
      if (returnJson && result) {
        return NextResponse.json(result, { status: apiResponse.status });
      }
      const message =
        typeof result?.["message"] === "string"
          ? result["message"]
          : typeof result?.["error"] === "string"
            ? result["error"].replace(/_/gu, " ")
            : "Unable to reschedule appointment";
      return respondFailure(
        returnJson,
        redirectTo,
        message,
        apiResponse.status,
      );
    }
    if (!result || result["ok"] !== true) {
      return respondFailure(
        returnJson,
        redirectTo,
        "The API response did not confirm the reschedule",
        502,
      );
    }

    if (returnJson) return NextResponse.json(result);
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name:
        result["calendarSync"] === "reconciliation_required"
          ? "myst-flash-error"
          : "myst-flash",
      value:
        result["calendarSync"] === "reconciliation_required"
          ? "Appointment rescheduled in the CRM, but Google Calendar needs reconciliation."
          : "Appointment rescheduled",
      path: "/",
    });
    return response;
  } catch {
    return respondFailure(
      returnJson,
      redirectTo,
      "The reschedule could not be confirmed. Keep your date and time, then refresh before retrying.",
      502,
    );
  }
}
