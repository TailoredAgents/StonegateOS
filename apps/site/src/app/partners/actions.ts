"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";
import { callPartnerApi, callPartnerPublicApi } from "./lib/api";

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: string; detail?: string; message?: string };
      return json.error ?? json.detail ?? json.message ?? fallback;
    } catch {
      return text || fallback;
    }
  } catch {
    return fallback;
  }
}

export async function requestPartnerMagicLinkAction(formData: FormData) {
  const emailRaw = formData.get("email");
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  if (!email) {
    redirect("/partners/login?error=email_required");
  }

  await callPartnerPublicApi("/api/public/partners/request-link", {
    method: "POST",
    body: JSON.stringify({ email })
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

  const res = await callPartnerPublicApi("/api/public/partners/login-password", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  if (!res.ok) {
    const msg = await readErrorMessage(res, "login_failed");
    redirect(`/partners/login?error=${encodeURIComponent(msg)}`);
  }

  const payload = (await res.json().catch(() => ({}))) as { sessionToken?: string };
  const token = typeof payload.sessionToken === "string" ? payload.sessionToken : "";
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
    path: "/"
  });

  redirect("/partners");
}

export async function partnerLogoutAction() {
  const jar = await cookies();
  jar.delete(PARTNER_SESSION_COOKIE);
  redirect("/partners/login");
}

export async function partnerSetPasswordAction(formData: FormData) {
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  if (!password || password.length < 10) {
    redirect("/partners/settings?error=password_too_short");
  }

  const res = await callPartnerApi("/api/portal/password", {
    method: "POST",
    body: JSON.stringify({ password })
  });
  if (!res.ok) {
    const msg = await readErrorMessage(res, "save_failed");
    redirect(`/partners/settings?error=${encodeURIComponent(msg)}`);
  }

  redirect("/partners/settings?saved=1");
}

export async function partnerCreatePropertyAction(formData: FormData) {
  const addressLine1 = typeof formData.get("addressLine1") === "string" ? String(formData.get("addressLine1")).trim() : "";
  const addressLine2 = typeof formData.get("addressLine2") === "string" ? String(formData.get("addressLine2")).trim() : "";
  const city = typeof formData.get("city") === "string" ? String(formData.get("city")).trim() : "";
  const state = typeof formData.get("state") === "string" ? String(formData.get("state")).trim() : "";
  const postalCode = typeof formData.get("postalCode") === "string" ? String(formData.get("postalCode")).trim() : "";
  const gated = formData.get("gated") === "on";

  const res = await callPartnerApi("/api/portal/properties", {
    method: "POST",
    body: JSON.stringify({
      addressLine1,
      addressLine2: addressLine2.length ? addressLine2 : null,
      city,
      state,
      postalCode,
      gated
    })
  });

  if (!res.ok) {
    const msg = await readErrorMessage(res, "create_failed");
    redirect(`/partners/properties?error=${encodeURIComponent(msg)}`);
  }

  redirect("/partners/properties?created=1");
}

export async function partnerCreateBookingAction(formData: FormData) {
  const propertyId = typeof formData.get("propertyId") === "string" ? String(formData.get("propertyId")).trim() : "";
  const serviceKey = typeof formData.get("serviceKey") === "string" ? String(formData.get("serviceKey")).trim() : "";
  const tierKey = typeof formData.get("tierKey") === "string" ? String(formData.get("tierKey")).trim() : "";
  const preferredDate = typeof formData.get("preferredDate") === "string" ? String(formData.get("preferredDate")).trim() : "";
  const timeWindowId = typeof formData.get("timeWindowId") === "string" ? String(formData.get("timeWindowId")).trim() : "";
  const notes = typeof formData.get("notes") === "string" ? String(formData.get("notes")).trim() : "";

  const res = await callPartnerApi("/api/portal/bookings", {
    method: "POST",
    body: JSON.stringify({
      propertyId,
      serviceKey,
      tierKey: tierKey.length ? tierKey : null,
      preferredDate,
      timeWindowId,
      notes: notes.length ? notes : null
    })
  });

  if (!res.ok) {
    const msg = await readErrorMessage(res, "booking_failed");
    redirect(`/partners/book?error=${encodeURIComponent(msg)}`);
  }

  redirect("/partners/bookings?created=1");
}

