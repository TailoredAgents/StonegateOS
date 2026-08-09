import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { parseAppointmentBookingFormData } from "@/app/team/lib/booking-details";
import { isTeamMutationSuccessEnvelope } from "@/app/team/lib/mutation-feedback";
import { hasTeamPermission } from "@/lib/team-principal";

export const dynamic = "force-dynamic";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

function wantsJson(request: NextRequest): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

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

function readOptionalCheckbox(
  formData: FormData,
  name: "sendCustomerNotification" | "sendReviewRequest",
): { ok: true; value: boolean } | { ok: false } {
  const values = formData.getAll(name);
  if (values.length === 0) return { ok: true, value: false };
  if (values.length !== 1 || values[0] !== "on") return { ok: false };
  return { ok: true, value: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isExactAppointmentStatusReceipt(
  value: unknown,
  expected: {
    appointmentId: string;
    status: string;
    customerNotification: "requested" | "not_requested";
    reviewRequest: "requested" | "not_requested";
  },
): value is {
  data: {
    calendarSync: "requested" | "not_required";
    version: string;
  };
} {
  if (!isTeamMutationSuccessEnvelope(value) || !isRecord(value)) return false;
  const data = isRecord(value["data"]) ? value["data"] : null;
  const receipt = isRecord(value["receipt"]) ? value["receipt"] : null;
  return Boolean(
    data &&
      receipt &&
      data["appointmentId"] === expected.appointmentId &&
      data["status"] === expected.status &&
      typeof data["version"] === "string" &&
      data["version"].length > 0 &&
      (data["calendarSync"] === "requested" ||
        data["calendarSync"] === "not_required") &&
      data["customerNotification"] === expected.customerNotification &&
      data["reviewRequest"] === expected.reviewRequest &&
      receipt["entityType"] === "appointment" &&
      receipt["entityId"] === expected.appointmentId &&
      receipt["version"] === data["version"],
  );
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

function failureResponse(
  returnJson: boolean,
  redirectTo: URL,
  message: string,
  status = 422,
): NextResponse {
  return returnJson
    ? NextResponse.json(
        {
          ok: false,
          error: status === 403 ? "forbidden" : "invalid",
          message,
          retryable: status >= 500,
        },
        { status },
      )
    : redirectWithFlash(redirectTo, "myst-flash-error", message);
}

export async function POST(request: NextRequest): Promise<Response> {
  const returnJson = wantsJson(request);
  const redirectTo = getSafeRedirectUrl(request, "/team/calendar");
  const auth = await requireTeamPrincipal(request, {
    redirectTo,
    permissions: "appointments.update",
    returnJson,
  });

  if (!auth.ok) return auth.response;

  const formData = await request.formData();
  const appointmentId = formData.get("appointmentId");
  const status = formData.get("status");
  const appointmentType = formData.get("appointmentType");
  const expectedVersion = formData.get("expectedVersion");
  const submittedIdempotencyKey = formData.get("idempotencyKey");
  const idempotencyKey =
    request.headers.get("idempotency-key")?.trim() ||
    (typeof submittedIdempotencyKey === "string"
      ? submittedIdempotencyKey.trim()
      : "");

  if (typeof appointmentId !== "string" || appointmentId.trim().length === 0) {
    return failureResponse(returnJson, redirectTo, "Appointment ID missing");
  }

  if (typeof status !== "string" || status.trim().length === 0) {
    return failureResponse(returnJson, redirectTo, "Status missing");
  }
  if (
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0
  ) {
    return failureResponse(
      returnJson,
      redirectTo,
      "Refresh this appointment before changing its status.",
      409,
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return failureResponse(
      returnJson,
      redirectTo,
      "The status request is missing its retry key. Refresh and submit it again.",
    );
  }

  const statusValue = status.trim();
  if (
    !["requested", "confirmed", "completed", "no_show", "canceled"].includes(
      statusValue,
    )
  ) {
    return failureResponse(returnJson, redirectTo, "Choose a valid status.");
  }
  const customerNotificationIntent = readOptionalCheckbox(
    formData,
    "sendCustomerNotification",
  );
  const reviewRequestIntent = readOptionalCheckbox(
    formData,
    "sendReviewRequest",
  );
  if (!customerNotificationIntent.ok || !reviewRequestIntent.ok) {
    return failureResponse(
      returnJson,
      redirectTo,
      "The customer-message choices are invalid. Review the checkboxes and submit again.",
    );
  }
  if (
    (customerNotificationIntent.value || reviewRequestIntent.value) &&
    !hasTeamPermission(auth.principal, "messages.send")
  ) {
    return failureResponse(
      returnJson,
      redirectTo,
      "You can update the appointment, but you do not have permission to message the customer.",
      403,
    );
  }
  const payload: Record<string, unknown> = {
    status: statusValue,
    sendCustomerNotification: customerNotificationIntent.value,
    sendReviewRequest: reviewRequestIntent.value,
  };
  if (typeof expectedVersion === "string" && expectedVersion.trim()) {
    payload["expectedVersion"] = expectedVersion.trim();
  }
  const isQuoteOnly = isQuoteOnlyAppointmentType(appointmentType);
  const shouldUpdateBookingDetails =
    statusValue === "completed" &&
    !isQuoteOnly &&
    wantsBookingDetailsUpdate(formData);

  if (statusValue === "completed" && !isQuoteOnly) {
    const cents = parseUsdToCents(formData.get("finalTotal"));
    if (cents === null) {
      return failureResponse(
        returnJson,
        redirectTo,
        "Final job total is required to mark complete.",
      );
    }
    payload["finalTotalCents"] = cents;

    const expectedFinalTotalRaw = formData.get("expectedFinalTotalCents");
    if (expectedFinalTotalRaw === "null") {
      payload["expectedFinalTotalCents"] = null;
    } else if (
      typeof expectedFinalTotalRaw === "string" &&
      /^\d+$/u.test(expectedFinalTotalRaw.trim())
    ) {
      payload["expectedFinalTotalCents"] = Number(expectedFinalTotalRaw);
    }

    const cardTipRaw = formData.get("cardTip");
    const cardTipCents = parseUsdToCents(cardTipRaw);
    if (hasEnteredValue(cardTipRaw) && cardTipCents === null) {
      return failureResponse(
        returnJson,
        redirectTo,
        "Card tips must be 0 or more.",
      );
    }
    if (cardTipCents !== null) {
      payload["cardTipCents"] = cardTipCents;
    }

    const crewIds = formData
      .getAll("crewMemberId")
      .filter((value): value is string => typeof value === "string");
    if (crewIds.length === 0) {
      return failureResponse(
        returnJson,
        redirectTo,
        "Select at least one crew member before marking complete.",
      );
    }

    // The API resolves authoritative weights from current commission
    // configuration. The Site forwards only the selected identities; submitted
    // weights are deliberately non-authoritative.
    payload["crewMembers"] = [...new Set(crewIds.map((id) => id.trim()))]
      .filter(Boolean)
      .sort()
      .map((memberId) => ({ memberId, splitBps: 1 }));
  }

  if (shouldUpdateBookingDetails) {
    const bookingDetailsResult = parseAppointmentBookingFormData(formData);
    if (!bookingDetailsResult.ok) {
      return failureResponse(
        returnJson,
        redirectTo,
        bookingDetailsResult.error,
      );
    }
    payload["quotedTotalCents"] = bookingDetailsResult.quotedTotalCents;
    payload["bookingDetails"] = bookingDetailsResult.bookingDetails;
  }

  const apiResponse = await callAdminApiAs(
    auth.principal,
    `/api/appointments/${appointmentId.trim()}/status`,
    {
      method: "POST",
      headers: {
        "If-Match": `"${expectedVersion.trim()}"`,
        "Idempotency-Key": idempotencyKey,
      },
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
    return failureResponse(returnJson, redirectTo, message, apiResponse.status);
  }

  const result = (await apiResponse.json().catch(() => null)) as unknown;
  if (
    !isExactAppointmentStatusReceipt(result, {
      appointmentId: appointmentId.trim(),
      status: statusValue,
      customerNotification: customerNotificationIntent.value
        ? "requested"
        : "not_requested",
      reviewRequest: reviewRequestIntent.value ? "requested" : "not_requested",
    })
  ) {
    return failureResponse(
      returnJson,
      redirectTo,
      "The service returned an unreadable appointment receipt. Refresh the calendar before retrying.",
      502,
    );
  }
  if (returnJson) {
    return NextResponse.json(result);
  }

  const response = NextResponse.redirect(redirectTo, 303);
  const effectCopy = customerNotificationIntent.value
    ? " Customer notice requested; delivery is not yet confirmed."
    : reviewRequestIntent.value
      ? " Review request queued; delivery is not yet confirmed."
      : " Customer was not notified.";
  const calendarCopy =
    result.data.calendarSync === "requested"
      ? " Google Calendar cleanup is queued."
      : "";
  response.cookies.set({
    name: "myst-flash",
    value:
      statusValue === "completed" && isQuoteOnly
        ? `Quote marked done.${effectCopy}`
        : statusValue === "completed"
          ? `Job completed.${effectCopy}`
          : statusValue === "canceled"
            ? `Appointment canceled.${effectCopy}${calendarCopy}`
            : `Appointment updated.${effectCopy}`,
    path: "/",
  });
  return response;
}
