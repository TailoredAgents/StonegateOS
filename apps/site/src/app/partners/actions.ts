"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";
import { callPartnerApi, callPartnerPublicApi } from "./lib/api";

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as {
        error?: string;
        detail?: string;
        message?: string;
      };
      return json.error ?? json.detail ?? json.message ?? fallback;
    } catch {
      return text || fallback;
    }
  } catch {
    return fallback;
  }
}

export async function requestPartnerMagicLinkAction(formData: FormData) {
  const identifierRaw = formData.get("identifier");
  const identifier =
    typeof identifierRaw === "string" ? identifierRaw.trim() : "";
  if (!identifier) {
    redirect("/partners/login?error=email_or_phone_required");
  }

  const isEmail = identifier.includes("@");

  await callPartnerPublicApi("/api/public/partners/request-link", {
    method: "POST",
    body: JSON.stringify({
      email: isEmail ? identifier : undefined,
      phone: isEmail ? undefined : identifier,
    }),
  });

  redirect("/partners/login?sent=1");
}

export async function partnerPasswordLoginAction(formData: FormData) {
  const emailRaw = formData.get("email");
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!email || !password) {
    redirect("/partners/login?error=missing_credentials");
  }

  const res = await callPartnerPublicApi(
    "/api/public/partners/login-password",
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
    },
  );

  if (!res.ok) {
    const msg = await readErrorMessage(res, "login_failed");
    redirect(`/partners/login?error=${encodeURIComponent(msg)}`);
  }

  const payload = (await res.json().catch(() => ({}))) as {
    sessionToken?: string;
  };
  const token =
    typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (!token) {
    redirect("/partners/login?error=login_failed");
  }

  const jar = await cookies();
  jar.set({
    name: PARTNER_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
  });

  redirect("/partners");
}

export async function partnerLogoutAction() {
  const jar = await cookies();
  jar.delete(PARTNER_SESSION_COOKIE);
  redirect("/partners/login");
}

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function partnerSetPasswordAction(formData: FormData) {
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!password || password.length < 10) {
    redirect("/partners/settings?error=password_too_short");
  }

  const res = await callPartnerApi("/api/portal/password", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const msg = await readErrorMessage(res, "save_failed");
    redirect(`/partners/settings?error=${encodeURIComponent(msg)}`);
  }

  redirect("/partners/settings?saved=1");
}

export async function partnerCreatePropertyAction(formData: FormData) {
  const addressLine1 = readFormString(formData, "addressLine1");
  const addressLine2 = readFormString(formData, "addressLine2");
  const city = readFormString(formData, "city");
  const state = readFormString(formData, "state");
  const postalCode = readFormString(formData, "postalCode");
  const gated = formData.get("gated") === "on";

  const res = await callPartnerApi("/api/portal/properties", {
    method: "POST",
    body: JSON.stringify({
      addressLine1,
      addressLine2: addressLine2.length ? addressLine2 : null,
      city,
      state,
      postalCode,
      gated,
    }),
  });

  if (!res.ok) {
    const msg = await readErrorMessage(res, "create_failed");
    redirect(`/partners/properties?error=${encodeURIComponent(msg)}`);
  }

  redirect("/partners/properties?created=1");
}

export async function partnerCreateBookingAction(formData: FormData) {
  const operationKey = readFormString(formData, "operationKey");
  const propertyId = readFormString(formData, "propertyId");
  const serviceKey = readFormString(formData, "serviceKey");
  const tierKey = readFormString(formData, "tierKey");
  const preferredDate = readFormString(formData, "preferredDate");
  const timeWindowId = readFormString(formData, "timeWindowId");
  const notes = readFormString(formData, "notes");
  const rescheduleFromAppointmentId = readFormString(
    formData,
    "rescheduleFromAppointmentId",
  );
  const rescheduleFromVersion = readFormString(
    formData,
    "rescheduleFromVersion",
  );

  if (!operationKey) {
    redirect("/partners/book?error=booking_operation_expired");
  }
  if (rescheduleFromAppointmentId && !rescheduleFromVersion) {
    redirect(
      "/partners/bookings?error=The%20booking%20changed%20before%20it%20could%20be%20rescheduled.%20Refresh%20and%20try%20again.",
    );
  }

  const res = await callPartnerApi("/api/portal/bookings", {
    method: "POST",
    headers: {
      "Idempotency-Key": operationKey,
      ...(rescheduleFromAppointmentId
        ? { "If-Match": rescheduleFromVersion }
        : {}),
    },
    body: JSON.stringify({
      propertyId,
      serviceKey,
      tierKey: tierKey.length ? tierKey : null,
      preferredDate,
      timeWindowId,
      notes: notes.length ? notes : null,
      ...(rescheduleFromAppointmentId ? { rescheduleFromAppointmentId } : {}),
    }),
  }).catch(() => null);

  if (!res) {
    redirect(
      rescheduleFromAppointmentId
        ? "/partners/bookings?error=We%20could%20not%20confirm%20the%20reschedule.%20Check%20the%20booking%20list%20before%20trying%20again."
        : "/partners/book?error=We%20could%20not%20confirm%20the%20booking.%20Check%20your%20booking%20list%20before%20trying%20again.",
    );
  }
  if (!res.ok) {
    const msg = await readErrorMessage(
      res,
      rescheduleFromAppointmentId ? "reschedule_failed" : "booking_failed",
    );
    if (rescheduleFromAppointmentId) {
      redirect(
        `/partners/bookings?error=${encodeURIComponent(
          `The reschedule was not completed; your original booking remains in place (${msg}).`,
        )}`,
      );
    }
    redirect(`/partners/book?error=${encodeURIComponent(msg)}`);
  }

  const created = (await res.json().catch(() => null)) as {
    ok?: boolean;
    appointmentId?: string;
    version?: number;
    rescheduledFromAppointmentId?: string | null;
    rescheduledFromVersion?: number | null;
    receipt?: {
      operationId?: string;
      correlationId?: string;
      auditEventId?: string;
      committedAt?: string;
    };
  } | null;
  if (
    created?.ok !== true ||
    typeof created.appointmentId !== "string" ||
    typeof created.version !== "number" ||
    typeof created.receipt?.operationId !== "string" ||
    typeof created.receipt.correlationId !== "string" ||
    typeof created.receipt.auditEventId !== "string" ||
    typeof created.receipt.committedAt !== "string"
  ) {
    redirect(
      rescheduleFromAppointmentId
        ? "/partners/bookings?error=The%20server%20did%20not%20return%20a%20complete%20reschedule%20receipt.%20Refresh%20the%20list%20before%20retrying."
        : "/partners/book?error=booking_confirmation_invalid",
    );
  }

  if (rescheduleFromAppointmentId) {
    if (
      created.rescheduledFromAppointmentId !== rescheduleFromAppointmentId ||
      created.rescheduledFromVersion !== Number(rescheduleFromVersion)
    ) {
      redirect(
        "/partners/bookings?error=The%20server%20receipt%20did%20not%20match%20the%20booking%20you%20rescheduled.%20Refresh%20the%20list%20before%20retrying.",
      );
    }
    redirect("/partners/bookings?rescheduled=1");
  }

  redirect("/partners/bookings?created=1");
}

export async function partnerCancelBookingAction(formData: FormData) {
  const appointmentId = readFormString(formData, "appointmentId");
  const version = readFormString(formData, "version");
  const operationKey = readFormString(formData, "operationKey");
  if (!appointmentId || !version || !operationKey) {
    redirect("/partners/bookings?error=missing_appointment_id");
  }

  const res = await callPartnerApi(
    `/api/portal/bookings/${encodeURIComponent(appointmentId)}/cancel`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": operationKey,
        "If-Match": version,
      },
      body: JSON.stringify({}),
    },
  );

  if (!res.ok) {
    const msg = await readErrorMessage(res, "cancel_failed");
    redirect(`/partners/bookings?error=${encodeURIComponent(msg)}`);
  }

  const canceled = (await res.json().catch(() => null)) as {
    ok?: boolean;
    status?: string;
    version?: number;
    receipt?: {
      operationId?: string;
      correlationId?: string;
      auditEventId?: string;
      committedAt?: string;
    };
  } | null;
  if (
    canceled?.ok !== true ||
    canceled.status !== "canceled" ||
    typeof canceled.version !== "number" ||
    typeof canceled.receipt?.operationId !== "string" ||
    typeof canceled.receipt.correlationId !== "string" ||
    typeof canceled.receipt.auditEventId !== "string" ||
    typeof canceled.receipt.committedAt !== "string"
  ) {
    redirect("/partners/bookings?error=cancel_confirmation_invalid");
  }

  redirect("/partners/bookings?canceled=1");
}
