"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Route } from "next";
import { TEAM_SESSION_COOKIE } from "@/lib/team-session";
import { callAdminApi } from "../team/lib/api";
import { callTeamApi, callTeamPublicApi } from "../team/login/lib/api";
import { hasMobilePermission, resolveMobileSessionFromCookies } from "./lib/session";

async function requireMobilePermission(required: string): Promise<void> {
  const session = await resolveMobileSessionFromCookies();
  if (!session) {
    redirect("/mobile/login");
  }
  if (!hasMobilePermission(session.teamMember.permissions, required)) {
    redirect(`/mobile?error=${encodeURIComponent("forbidden")}` as Route);
  }
}

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

export async function sendMobileThreadMessageAction(formData: FormData) {
  await requireMobilePermission("messages.send");

  const threadIdRaw = formData.get("threadId");
  const channelRaw = formData.get("channel");
  const bodyRaw = formData.get("body");
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";
  const channel = typeof channelRaw === "string" ? channelRaw.trim() : "";
  const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";

  if (!threadId) {
    redirect("/mobile?error=thread_required");
  }
  if (!body) {
    redirect(`/mobile?threadId=${encodeURIComponent(threadId)}&error=message_required`);
  }

  const response = await callAdminApi(`/api/admin/inbox/threads/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      body,
      direction: "outbound",
      ...(channel ? { channel } : {})
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "send_failed");
    redirect(`/mobile?threadId=${encodeURIComponent(threadId)}&error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/mobile");
  redirect(`/mobile?threadId=${encodeURIComponent(threadId)}&sent=1`);
}

function makeNoteTitle(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "Note";
  const maxLength = 60;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
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

function parseUsdToDollars(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[$,\s]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100) / 100;
}

const mobileQuoteServiceIds = new Set([
  "single-item",
  "furniture",
  "appliances",
  "yard-waste",
  "construction-debris",
  "hot-tub",
  "other"
]);

export async function addMobileContactNoteAction(formData: FormData) {
  await requireMobilePermission("bookings.manage");

  const contactIdRaw = formData.get("contactId");
  const threadIdRaw = formData.get("threadId");
  const bodyRaw = formData.get("body");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";
  const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";

  const makeRedirect = (params: Record<string, string>): Route => {
    const searchParams = new URLSearchParams();
    if (threadId) searchParams.set("threadId", threadId);
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, value);
    }
    const query = searchParams.toString();
    return (query ? `/mobile?${query}` : "/mobile") as Route;
  };

  if (!contactId) {
    redirect(makeRedirect({ error: "contact_required" }));
  }
  if (!body) {
    redirect(makeRedirect({ error: "note_required" }));
  }

  const response = await callAdminApi("/api/admin/crm/tasks", {
    method: "POST",
    body: JSON.stringify({
      contactId,
      title: makeNoteTitle(body),
      notes: body,
      status: "completed"
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "note_failed");
    redirect(makeRedirect({ error: message }));
  }

  revalidatePath("/mobile");
  redirect(makeRedirect({ note: "1" }));
}

export async function completeMobileTaskAction(formData: FormData) {
  await requireMobilePermission("bookings.manage");

  const taskIdRaw = formData.get("taskId");
  const screenRaw = formData.get("screen");
  const taskId = typeof taskIdRaw === "string" ? taskIdRaw.trim() : "";
  const screen = typeof screenRaw === "string" && screenRaw.trim() === "contacts" ? "contacts" : "myday";
  const redirectPath = screen === "contacts" ? "/mobile?screen=contacts" : "/mobile?screen=myday";

  if (!taskId) {
    redirect(`${redirectPath}&error=task_required` as Route);
  }

  const response = await callAdminApi(`/api/admin/crm/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "completed" })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "task_update_failed");
    redirect(`${redirectPath}&error=${encodeURIComponent(message)}` as Route);
  }

  revalidatePath("/mobile");
  redirect(`${redirectPath}&task=1` as Route);
}

export async function mobileLogoutAction() {
  const jar = await cookies();
  const token = jar.get(TEAM_SESSION_COOKIE)?.value ?? "";
  if (token) {
    await callTeamApi("/api/team/logout", { method: "POST" }).catch(() => null);
  }
  jar.delete(TEAM_SESSION_COOKIE);
  redirect("/mobile/login");
}

export async function createMobileTeamMemberAction(formData: FormData) {
  await requireMobilePermission("access.manage");

  const nameRaw = formData.get("name");
  const emailRaw = formData.get("email");
  const roleIdRaw = formData.get("roleId");
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  const roleId = typeof roleIdRaw === "string" ? roleIdRaw.trim() : "";

  if (!name) {
    redirect("/mobile?screen=access&error=name_required");
  }
  if (!email) {
    redirect("/mobile?screen=access&error=email_required");
  }
  if (!roleId) {
    redirect("/mobile?screen=access&error=role_required");
  }

  const response = await callAdminApi("/api/admin/team/members", {
    method: "POST",
    body: JSON.stringify({
      name,
      email,
      roleId,
      active: true
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "member_create_failed");
    redirect(`/mobile?screen=access&error=${encodeURIComponent(message)}` as Route);
  }

  revalidatePath("/mobile");
  redirect("/mobile?screen=access&account=created");
}

export async function updateMobileTeamMemberAction(formData: FormData) {
  await requireMobilePermission("access.manage");

  const memberIdRaw = formData.get("memberId");
  const nameRaw = formData.get("name");
  const emailRaw = formData.get("email");
  const roleIdRaw = formData.get("roleId");
  const phoneRaw = formData.get("phone");
  const memberId = typeof memberIdRaw === "string" ? memberIdRaw.trim() : "";
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  const roleId = typeof roleIdRaw === "string" ? roleIdRaw.trim() : "";
  const phone = typeof phoneRaw === "string" ? phoneRaw.trim() : "";

  if (!memberId) {
    redirect("/mobile?screen=access&error=member_required");
  }
  if (!name) {
    redirect("/mobile?screen=access&error=name_required");
  }
  if (!roleId) {
    redirect("/mobile?screen=access&error=role_required");
  }

  const response = await callAdminApi(`/api/admin/team/members/${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name,
      email: email || null,
      roleId,
      phone: phone || null,
      active: formData.get("active") === "on"
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "member_update_failed");
    redirect(`/mobile?screen=access&error=${encodeURIComponent(message)}` as Route);
  }

  revalidatePath("/mobile");
  redirect("/mobile?screen=access&account=updated");
}

export async function sendMobileTeamInviteAction(formData: FormData) {
  await requireMobilePermission("access.manage");

  const identifierRaw = formData.get("identifier");
  const identifier = typeof identifierRaw === "string" ? identifierRaw.trim() : "";
  if (!identifier) {
    redirect("/mobile?screen=access&error=invite_identifier_required");
  }

  const response = await callTeamPublicApi("/api/public/team/request-link", {
    method: "POST",
    body: JSON.stringify({
      identifier,
      redirectPath: "/mobile/auth"
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "invite_failed");
    redirect(`/mobile?screen=access&error=${encodeURIComponent(message)}` as Route);
  }

  redirect("/mobile?screen=access&invite=sent");
}

export async function updateMobileContactAction(formData: FormData) {
  await requireMobilePermission("bookings.manage");

  const contactIdRaw = formData.get("contactId");
  const threadIdRaw = formData.get("threadId");
  const firstNameRaw = formData.get("firstName");
  const lastNameRaw = formData.get("lastName");
  const emailRaw = formData.get("email");
  const phoneRaw = formData.get("phone");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";
  const firstName = typeof firstNameRaw === "string" ? firstNameRaw.trim() : "";
  const lastName = typeof lastNameRaw === "string" ? lastNameRaw.trim() : "";
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  const phone = typeof phoneRaw === "string" ? phoneRaw.trim() : "";

  const makeRedirect = (params: Record<string, string>): Route => {
    const searchParams = new URLSearchParams();
    if (threadId) searchParams.set("threadId", threadId);
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, value);
    }
    const query = searchParams.toString();
    return (query ? `/mobile?${query}` : "/mobile") as Route;
  };

  if (!contactId) {
    redirect(makeRedirect({ error: "contact_required" }));
  }
  if (!firstName || !lastName) {
    redirect(makeRedirect({ error: "name_required" }));
  }

  const response = await callAdminApi(`/api/admin/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      firstName,
      lastName,
      email: email || null,
      phone: phone || null
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "contact_update_failed");
    redirect(makeRedirect({ error: message }));
  }

  revalidatePath("/mobile");
  redirect(makeRedirect({ contact: "1" }));
}

export async function updateMobileAppointmentStatusAction(formData: FormData) {
  await requireMobilePermission("appointments.update");

  const appointmentIdRaw = formData.get("appointmentId");
  const statusRaw = formData.get("status");
  const dateRaw = formData.get("date");
  const appointmentId = typeof appointmentIdRaw === "string" ? appointmentIdRaw.trim() : "";
  const status = typeof statusRaw === "string" ? statusRaw.trim() : "";
  const date = typeof dateRaw === "string" ? dateRaw.trim() : "";
  const redirectPath = (date ? `/mobile?screen=calendar&date=${encodeURIComponent(date)}` : "/mobile?screen=calendar") as Route;

  if (!appointmentId) {
    redirect(`${redirectPath}&error=appointment_required` as Route);
  }
  if (!["requested", "confirmed", "no_show", "canceled"].includes(status)) {
    redirect(`${redirectPath}&error=invalid_status` as Route);
  }

  const response = await callAdminApi(`/api/appointments/${encodeURIComponent(appointmentId)}/status`, {
    method: "POST",
    body: JSON.stringify({ status })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "appointment_update_failed");
    redirect(`${redirectPath}&error=${encodeURIComponent(message)}` as Route);
  }

  revalidatePath("/mobile");
  redirect(`${redirectPath}&appointment=1` as Route);
}

export async function addMobileAppointmentAttachmentAction(formData: FormData) {
  await requireMobilePermission("appointments.update");

  const appointmentIdRaw = formData.get("appointmentId");
  const dateRaw = formData.get("date");
  const file = formData.get("file");
  const filenameRaw = formData.get("filename");
  const appointmentId = typeof appointmentIdRaw === "string" ? appointmentIdRaw.trim() : "";
  const date = typeof dateRaw === "string" ? dateRaw.trim() : "";
  const filename = typeof filenameRaw === "string" ? filenameRaw.trim() : "";
  const redirectPath = (date ? `/mobile?screen=calendar&date=${encodeURIComponent(date)}` : "/mobile?screen=calendar") as Route;

  if (!appointmentId) {
    redirect(`${redirectPath}&error=appointment_required` as Route);
  }
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${redirectPath}&error=file_required` as Route);
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const contentType = file.type || "application/octet-stream";
  const dataUrl = `data:${contentType};base64,${buf.toString("base64")}`;

  const response = await callAdminApi(`/api/appointments/${encodeURIComponent(appointmentId)}/attachments`, {
    method: "POST",
    body: JSON.stringify({
      url: dataUrl,
      filename: filename || file.name || "mobile-upload",
      contentType
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "attachment_upload_failed");
    redirect(`${redirectPath}&error=${encodeURIComponent(message)}` as Route);
  }

  revalidatePath("/mobile");
  redirect(`${redirectPath}&upload=1` as Route);
}

export async function rescheduleMobileAppointmentAction(formData: FormData) {
  await requireMobilePermission("appointments.update");

  const appointmentIdRaw = formData.get("appointmentId");
  const preferredDateRaw = formData.get("preferredDate");
  const startTimeRaw = formData.get("startTime");
  const currentDateRaw = formData.get("currentDate");
  const appointmentId = typeof appointmentIdRaw === "string" ? appointmentIdRaw.trim() : "";
  const preferredDate = typeof preferredDateRaw === "string" ? preferredDateRaw.trim() : "";
  const startTime = typeof startTimeRaw === "string" ? startTimeRaw.trim() : "";
  const currentDate = typeof currentDateRaw === "string" ? currentDateRaw.trim() : "";
  const redirectPath = (currentDate
    ? `/mobile?screen=calendar&date=${encodeURIComponent(currentDate)}`
    : "/mobile?screen=calendar") as Route;

  if (!appointmentId) {
    redirect(`${redirectPath}&error=appointment_required` as Route);
  }
  if (!preferredDate || !startTime) {
    redirect(`${redirectPath}&error=new_time_required` as Route);
  }

  const response = await callAdminApi(`/api/web/appointments/${encodeURIComponent(appointmentId)}/reschedule`, {
    method: "POST",
    body: JSON.stringify({
      preferredDate,
      startTime
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "reschedule_failed");
    redirect(`${redirectPath}&error=${encodeURIComponent(message)}` as Route);
  }

  revalidatePath("/mobile");
  redirect(`/mobile?screen=calendar&date=${encodeURIComponent(preferredDate)}&appointment=1` as Route);
}

export async function bookMobileAppointmentAction(formData: FormData) {
  await requireMobilePermission("bookings.manage");

  const contactIdRaw = formData.get("contactId");
  const propertyIdRaw = formData.get("propertyId");
  const threadIdRaw = formData.get("threadId");
  const appointmentTypeRaw = formData.get("appointmentType");
  const startAtRaw = formData.get("startAt");
  const durationRaw = formData.get("durationMinutes");
  const quotedTotalRaw = formData.get("quotedTotal");
  const notesRaw = formData.get("notes");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const propertyId = typeof propertyIdRaw === "string" ? propertyIdRaw.trim() : "";
  const threadId = typeof threadIdRaw === "string" ? threadIdRaw.trim() : "";
  const appointmentType =
    typeof appointmentTypeRaw === "string" && appointmentTypeRaw.trim() === "in_person_quote"
      ? "in_person_quote"
      : "job";
  const startAt = typeof startAtRaw === "string" ? startAtRaw.trim() : "";
  const durationMinutes = typeof durationRaw === "string" ? Number(durationRaw) : NaN;
  const quotedTotalCents = parseUsdToCents(quotedTotalRaw);
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";
  const threadParam = threadId ? `&threadId=${encodeURIComponent(threadId)}` : "";
  const errorRedirect = (message: string): Route => `/mobile?${threadParam ? `threadId=${encodeURIComponent(threadId)}&` : ""}error=${encodeURIComponent(message)}` as Route;

  if (!contactId) {
    redirect(errorRedirect("contact_required"));
  }
  if (!startAt) {
    redirect(errorRedirect("start_time_required"));
  }

  const payload: Record<string, unknown> = {
    contactId,
    appointmentType,
    startAt,
    durationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 60,
    travelBufferMinutes: 30,
    source: "mobile"
  };

  if (propertyId) payload["propertyId"] = propertyId;
  if (quotedTotalCents !== null) payload["quotedTotalCents"] = quotedTotalCents;
  if (notes) payload["notes"] = notes;

  const response = await callAdminApi("/api/admin/booking/book", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "booking_failed");
    redirect(errorRedirect(message));
  }

  revalidatePath("/mobile");
  const dayKey = startAt.slice(0, 10);
  const calendarRedirect = dayKey
    ? `/mobile?screen=calendar&date=${encodeURIComponent(dayKey)}&booked=1`
    : "/mobile?screen=calendar&booked=1";
  redirect(calendarRedirect as Route);
}

export async function createMobileQuoteAction(formData: FormData) {
  await requireMobilePermission("quotes.write");

  const contactIdRaw = formData.get("contactId");
  const propertyIdRaw = formData.get("propertyId");
  const notesRaw = formData.get("notes");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const propertyId = typeof propertyIdRaw === "string" ? propertyIdRaw.trim() : "";
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";
  const selectedServices = formData
    .getAll("services")
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => mobileQuoteServiceIds.has(value));

  const errorRedirect = (message: string): Route =>
    `/mobile?screen=quotes&error=${encodeURIComponent(message)}` as Route;

  if (!contactId || !propertyId) {
    redirect(errorRedirect("contact_and_property_required"));
  }
  if (!selectedServices.length) {
    redirect(errorRedirect("service_required"));
  }

  const serviceOverrides: Record<string, number> = {};
  for (const serviceId of selectedServices) {
    const amount = parseUsdToDollars(formData.get(`servicePrice:${serviceId}`));
    if (amount === null) {
      redirect(errorRedirect("price_required"));
    }
    serviceOverrides[serviceId] = amount;
  }

  const response = await callAdminApi("/api/quotes", {
    method: "POST",
    body: JSON.stringify({
      contactId,
      propertyId,
      zoneId: "zone-core",
      selectedServices,
      serviceOverrides,
      expiresInDays: 30,
      ...(notes ? { notes } : {})
    })
  });

  type CreateQuoteResponse = {
    quote?: { id?: string };
    error?: string;
    message?: string;
  };
  const data = (await response.json().catch(() => null)) as CreateQuoteResponse | null;

  if (!response.ok) {
    const message = data?.message ?? data?.error ?? "quote_create_failed";
    redirect(errorRedirect(message));
  }

  const shouldSend = formData.get("sendQuote") === "on";
  const quoteId = data?.quote?.id ?? "";
  if (shouldSend && quoteId) {
    const sendResponse = await callAdminApi(`/api/quotes/${encodeURIComponent(quoteId)}/send`, {
      method: "POST",
      body: JSON.stringify({})
    });
    if (!sendResponse.ok) {
      const message = await readErrorMessage(sendResponse, "quote_created_send_failed");
      revalidatePath("/mobile");
      redirect(`/mobile?screen=quotes&quote=1&error=${encodeURIComponent(message)}` as Route);
    }
  }

  revalidatePath("/mobile");
  redirect(`/mobile?screen=quotes&quote=${shouldSend ? "sent" : "1"}` as Route);
}

export async function updateMobileQuoteAction(formData: FormData) {
  await requireMobilePermission("quotes.update");

  const quoteIdRaw = formData.get("quoteId");
  const notesRaw = formData.get("notes");
  const quoteId = typeof quoteIdRaw === "string" ? quoteIdRaw.trim() : "";
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";
  const selectedServices = formData
    .getAll("services")
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => mobileQuoteServiceIds.has(value));

  const errorRedirect = (message: string): Route =>
    `/mobile?screen=quotes&error=${encodeURIComponent(message)}` as Route;

  if (!quoteId) {
    redirect(errorRedirect("quote_required"));
  }
  if (!selectedServices.length) {
    redirect(errorRedirect("service_required"));
  }

  const serviceOverrides: Record<string, number> = {};
  for (const serviceId of selectedServices) {
    const amount = parseUsdToDollars(formData.get(`servicePrice:${serviceId}`));
    if (amount === null) {
      redirect(errorRedirect("price_required"));
    }
    serviceOverrides[serviceId] = amount;
  }

  const response = await callAdminApi(`/api/quotes/${encodeURIComponent(quoteId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      zoneId: "zone-core",
      selectedServices,
      serviceOverrides,
      notes: notes || null
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "quote_update_failed");
    redirect(errorRedirect(message));
  }

  revalidatePath("/mobile");
  redirect("/mobile?screen=quotes&quote=updated");
}

export async function sendMobileQuoteAction(formData: FormData) {
  await requireMobilePermission("quotes.send");

  const quoteIdRaw = formData.get("quoteId");
  const quoteId = typeof quoteIdRaw === "string" ? quoteIdRaw.trim() : "";
  if (!quoteId) {
    redirect("/mobile?screen=quotes&error=quote_required");
  }

  const response = await callAdminApi(`/api/quotes/${encodeURIComponent(quoteId)}/send`, {
    method: "POST",
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "quote_send_failed");
    redirect(`/mobile?screen=quotes&error=${encodeURIComponent(message)}` as Route);
  }

  revalidatePath("/mobile");
  redirect("/mobile?screen=quotes&quote=sent");
}

export async function updateMobileQuoteDecisionAction(formData: FormData) {
  await requireMobilePermission("quotes.update");

  const quoteIdRaw = formData.get("quoteId");
  const decisionRaw = formData.get("decision");
  const quoteId = typeof quoteIdRaw === "string" ? quoteIdRaw.trim() : "";
  const decision = typeof decisionRaw === "string" ? decisionRaw.trim() : "";
  if (!quoteId) {
    redirect("/mobile?screen=quotes&error=quote_required");
  }
  if (decision !== "accepted" && decision !== "declined") {
    redirect("/mobile?screen=quotes&error=invalid_quote_decision");
  }

  const response = await callAdminApi(`/api/quotes/${encodeURIComponent(quoteId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "quote_update_failed");
    redirect(`/mobile?screen=quotes&error=${encodeURIComponent(message)}` as Route);
  }

  revalidatePath("/mobile");
  redirect("/mobile?screen=quotes&quote=updated");
}
