import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { isTeamMutationSuccessEnvelope } from "@/app/team/lib/mutation-feedback";

export const dynamic = "force-dynamic";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

function wantsJson(request: NextRequest): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

function failureResponse(
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
    redirectTo,
    permissions: "appointments.update",
    returnJson,
  });

  if (!auth.ok) return auth.response;

  const formData = await request.formData();
  const appointmentId = formData.get("appointmentId");
  const body = formData.get("body");
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

  if (typeof body !== "string" || body.trim().length === 0) {
    return failureResponse(returnJson, redirectTo, "Note body required");
  }
  if (
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0
  ) {
    return failureResponse(
      returnJson,
      redirectTo,
      "Refresh this appointment before adding the note.",
      409,
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return failureResponse(
      returnJson,
      redirectTo,
      "The note request is missing its retry key. Refresh and submit it again.",
    );
  }

  const apiResponse = await callAdminApiAs(
    auth.principal,
    `/api/appointments/${appointmentId.trim()}/notes`,
    {
      method: "POST",
      headers: {
        "If-Match": `"${expectedVersion.trim()}"`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        body: body.trim(),
      }),
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
    return failureResponse(returnJson, redirectTo, message, apiResponse.status);
  }

  const result = (await apiResponse.json().catch(() => null)) as unknown;
  if (!isTeamMutationSuccessEnvelope(result)) {
    return failureResponse(
      returnJson,
      redirectTo,
      "The service returned an unreadable note receipt. Refresh the appointment before retrying.",
      502,
    );
  }
  if (returnJson) {
    return NextResponse.json(result);
  }

  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({ name: "myst-flash", value: "Note added", path: "/" });
  return response;
}
