'use server';

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { callAdminApi } from "./lib/api";

const TEAM_ACTOR_ID_COOKIE = "myst-team-actor-id";
const TEAM_ACTOR_LABEL_COOKIE = "myst-team-actor-label";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function setActingMemberAction(formData: FormData) {
  const jar = await cookies();
  const memberRaw = formData.get("member");
  if (typeof memberRaw !== "string" || memberRaw.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Pick a team member first", path: "/" });
    revalidatePath("/team");
    return;
  }

  let parsed: { id?: unknown; name?: unknown } | null = null;
  try {
    parsed = JSON.parse(memberRaw) as { id?: unknown; name?: unknown };
  } catch {
    parsed = null;
  }

  const memberId = parsed && typeof parsed.id === "string" ? parsed.id.trim() : "";
  const memberName = parsed && typeof parsed.name === "string" ? parsed.name.trim() : "";

  if (!memberId || !isUuid(memberId)) {
    jar.set({ name: "myst-flash-error", value: "Invalid member selection", path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: TEAM_ACTOR_ID_COOKIE,
    value: memberId,
    path: "/",
    maxAge: 60 * 60 * 24 * 365
  });

  if (memberName) {
    jar.set({
      name: TEAM_ACTOR_LABEL_COOKIE,
      value: memberName,
      path: "/",
      maxAge: 60 * 60 * 24 * 365
    });
  } else {
    jar.set({ name: TEAM_ACTOR_LABEL_COOKIE, value: "", path: "/", maxAge: 0 });
  }

  jar.set({
    name: "myst-flash",
    value: memberName ? `Acting as ${memberName}` : "Acting member updated",
    path: "/"
  });

  revalidatePath("/team");
}

export async function clearActingMemberAction() {
  const jar = await cookies();
  jar.set({ name: TEAM_ACTOR_ID_COOKIE, value: "", path: "/", maxAge: 0 });
  jar.set({ name: TEAM_ACTOR_LABEL_COOKIE, value: "", path: "/", maxAge: 0 });
  jar.set({ name: "myst-flash", value: "Reset acting member to default", path: "/" });
  revalidatePath("/team");
}

export async function updateApptStatus(formData: FormData) {
  const id = formData.get("appointmentId");
  const status = formData.get("status");
  const crew = formData.get("crew");
  const owner = formData.get("owner");
  if (typeof id !== "string" || typeof status !== "string") return;

  const payload: Record<string, unknown> = { status };
  if (typeof crew === "string") payload["crew"] = crew.length ? crew : null;
  if (typeof owner === "string") payload["owner"] = owner.length ? owner : null;

  if (status === "completed") {
    const finalTotalCents = parseUsdToCents(formData.get("finalTotal"));
    const same = formData.get("finalTotalSameAsQuoted");
    const finalTotalSameAsQuoted = typeof same === "string" && (same === "true" || same === "on");

    if (finalTotalCents !== null) {
      payload["finalTotalCents"] = finalTotalCents;
    } else if (finalTotalSameAsQuoted) {
      payload["finalTotalSameAsQuoted"] = true;
    }
  }

  await callAdminApi(`/api/appointments/${id}/status`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const jar = await cookies();
  jar.set({ name: "myst-flash", value: "Appointment updated", path: "/" });
  revalidatePath("/team");
}

export async function addApptNote(formData: FormData) {
  const id = formData.get("appointmentId");
  const body = formData.get("body");
  if (typeof id !== "string" || typeof body !== "string" || body.trim().length === 0) return;

  await callAdminApi(`/api/appointments/${id}/notes`, {
    method: "POST",
    body: JSON.stringify({ body })
  });

  const jar = await cookies();
  jar.set({ name: "myst-flash", value: "Note added", path: "/" });
  revalidatePath("/team");
}

export async function sendQuoteAction(formData: FormData) {
  const id = formData.get("quoteId");
  const jar = await cookies();
  if (typeof id !== "string" || id.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Quote ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/quotes/${id.trim()}/send`, {
    method: "POST",
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to send quote");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Quote sent", path: "/" });
  revalidatePath("/team");
}

export async function quoteDecisionAction(formData: FormData) {
  const id = formData.get("quoteId");
  const decision = formData.get("decision");
  if (typeof id !== "string" || (decision !== "accepted" && decision !== "declined")) return;

  await callAdminApi(`/api/quotes/${id}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision })
  });

  const jar = await cookies();
  jar.set({ name: "myst-flash", value: "Quote updated", path: "/" });
  revalidatePath("/team");
}

export async function deleteQuoteAction(formData: FormData) {
  const jar = await cookies();
  const id = formData.get("quoteId");
  if (typeof id !== "string" || id.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Quote ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/quotes/${id}`, { method: "DELETE" });
  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete quote");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Quote deleted", path: "/" });
  revalidatePath("/team");
}

export async function deleteInstantQuoteAction(formData: FormData) {
  const jar = await cookies();
  const id = formData.get("instantQuoteId");
  if (typeof id !== "string" || id.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Instant quote ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/instant-quotes/${id}`, { method: "DELETE" });
  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete instant quote");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Instant quote deleted", path: "/" });
  revalidatePath("/team");
}

export async function attachPaymentAction(formData: FormData) {
  const id = formData.get("paymentId");
  const appt = formData.get("appointmentId");
  if (typeof id !== "string" || typeof appt !== "string" || appt.trim().length === 0) return;

  await callAdminApi(`/api/payments/${id}/attach`, {
    method: "POST",
    body: JSON.stringify({ appointmentId: appt })
  });

  const jar = await cookies();
  jar.set({ name: "myst-flash", value: "Payment attached", path: "/" });
  revalidatePath("/team");
}

export async function detachPaymentAction(formData: FormData) {
  const id = formData.get("paymentId");
  if (typeof id !== "string") return;

  await callAdminApi(`/api/payments/${id}/detach`, { method: "POST" });
  const jar = await cookies();
  jar.set({ name: "myst-flash", value: "Payment detached", path: "/" });
  revalidatePath("/team");
}

export async function rescheduleAppointmentAction(formData: FormData) {
  const id = formData.get("appointmentId");
  const preferredDate = formData.get("preferredDate");
  const timeWindow = formData.get("timeWindow");
  const startTime = formData.get("startTime");

  const jar = await cookies();

  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    typeof preferredDate !== "string" ||
    preferredDate.trim().length === 0
  ) {
    jar.set({ name: "myst-flash-error", value: "Missing date", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {};

  if (typeof startTime === "string" && startTime.trim().length > 0) {
    payload["preferredDate"] = preferredDate;
    payload["startTime"] = startTime.trim();
  } else {
    payload["preferredDate"] = preferredDate;
    if (typeof timeWindow === "string" && timeWindow.length > 0) {
      payload["timeWindow"] = timeWindow;
    }
  }

  if (!payload["startAt"] && !payload["preferredDate"]) {
    jar.set({ name: "myst-flash-error", value: "Missing time", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/web/appointments/${id}/reschedule`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let message = "Unable to reschedule";
    try {
      const data = (await response.json()) as { error?: string; message?: string };
      message = data.message ?? data.error ?? message;
    } catch {
      // ignore
    }
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
  } else {
    jar.set({ name: "myst-flash", value: "Appointment rescheduled", path: "/" });
  }

  revalidatePath("/team");
}

export async function createQuoteAction(formData: FormData) {
  const jar = await cookies();

  const contactId = formData.get("contactId");
  const propertyId = formData.get("propertyId");
  const appointmentId = formData.get("appointmentId");
  const zoneId = formData.get("zoneId");
  const workflow = formData.get("workflow");
  const servicesRaw = formData.get("services");
  const depositRate = formData.get("depositRate");
  const expiresInDays = formData.get("expiresInDays");
  const notes = formData.get("notes");
  const serviceOverridesRaw = formData.get("serviceOverrides");

  if (typeof contactId !== "string" || typeof propertyId !== "string" || typeof zoneId !== "string") {
    jar.set({ name: "myst-flash-error", value: "Missing quote details", path: "/" });
    revalidatePath("/team");
    return;
  }

  let services: string[] = [];
  if (typeof servicesRaw === "string" && servicesRaw.length > 0) {
    try {
      const parsed = JSON.parse(servicesRaw) as string[];
      if (Array.isArray(parsed)) {
        services = parsed;
      }
    } catch {
      // ignore
    }
  }

  if (!services.length) {
    jar.set({ name: "myst-flash-error", value: "No services selected", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    contactId,
    propertyId,
    zoneId,
    selectedServices: services
  };

  if (typeof depositRate === "string" && depositRate.trim().length > 0) {
    const rate = Number(depositRate);
    if (!Number.isNaN(rate) && rate > 0 && rate <= 1) {
      payload["depositRate"] = rate;
    }
  }

  if (typeof expiresInDays === "string" && expiresInDays.trim().length > 0) {
    const days = Number(expiresInDays);
    if (!Number.isNaN(days) && days > 0) {
      payload["expiresInDays"] = days;
    }
  }

  if (typeof notes === "string" && notes.trim().length > 0) {
    payload["notes"] = notes.trim();
  }

  if (typeof serviceOverridesRaw === "string" && serviceOverridesRaw.trim().length > 0) {
    try {
      const parsed = JSON.parse(serviceOverridesRaw) as Record<string, unknown>;
      const sanitized: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        const numeric = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(numeric) && numeric > 0 && key !== "driveway") {
          sanitized[key] = numeric;
        }
      }
      if (Object.keys(sanitized).length > 0) {
        payload["serviceOverrides"] = sanitized;
      }
    } catch {
      // ignore malformed overrides
    }
  }

  // Removed surface area and concrete surface handling for junk removal

  const response = await callAdminApi(`/api/quotes`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  type CreateQuoteResponse = {
    quote?: { id: string; shareToken?: string | null };
    shareUrl?: string;
    breakdown?: { total?: number };
    error?: string;
    details?: unknown;
  };

  let data: CreateQuoteResponse | null = null;
  try {
    data = (await response.json()) as CreateQuoteResponse;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      (data?.error && typeof data.error === "string" ? data.error : null) ?? "Unable to create quote";
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const quoteId = data?.quote?.id ?? null;
  const shareLink = data?.shareUrl ?? (data?.quote?.shareToken ? `/quote/${data.quote.shareToken}` : null);
  const shouldSend = typeof formData.get("sendQuote") === "string";
  const isCanvass = typeof workflow === "string" && workflow.trim().toLowerCase() === "canvass";

  let successMessage = shareLink ? `Quote created. Share link: ${shareLink}` : "Quote created";
  let sendError: string | null = null;

  if (shouldSend) {
    if (quoteId) {
      const sendResponse = await callAdminApi(`/api/quotes/${quoteId}/send`, {
        method: "POST",
        body: JSON.stringify({})
      });

      if (sendResponse.ok) {
        successMessage = shareLink ? `Quote emailed. Share link: ${shareLink}` : "Quote emailed";
      } else {
        sendError = await readErrorMessage(sendResponse, "Quote created, but the email failed to send");
      }
    } else {
      sendError = "Quote created, but no quote ID was returned to send the email.";
    }
  }

  jar.set({ name: "myst-flash", value: successMessage, path: "/" });
  if (sendError) {
    jar.set({ name: "myst-flash-error", value: sendError, path: "/" });
  }

  if (isCanvass && quoteId && typeof contactId === "string") {
    const repName = jar.get("myst-team-actor-label")?.value?.trim() || "Stonegate";

    let firstName = "there";
    try {
      const lookup = await callAdminApi(`/api/admin/contacts?contactId=${encodeURIComponent(contactId)}&limit=1`);
      if (lookup.ok) {
        const payload = (await lookup.json()) as { contacts?: Array<{ firstName?: string | null }> };
        const candidate = payload.contacts?.[0]?.firstName;
        if (candidate && candidate.trim().length) firstName = candidate.trim();
      }
    } catch {
      // ignore lookup failures
    }

    const total = typeof data?.breakdown?.total === "number" ? data.breakdown.total : null;
    const totalText = total !== null ? `$${total.toFixed(0)}` : "your total";
    const draftBody = `Hey ${firstName}, this is ${repName} with Stonegate Junk Removal. Your quote total is ${totalText}. What day works best for pickup?`;

    try {
      const ensured = await callAdminApi("/api/admin/inbox/threads/ensure", {
        method: "POST",
        body: JSON.stringify({ contactId, channel: "sms" })
      });
      if (ensured.ok) {
        const ensuredPayload = (await ensured.json()) as { threadId?: string };
        const threadId = typeof ensuredPayload.threadId === "string" ? ensuredPayload.threadId : null;
        if (threadId) {
          await callAdminApi(`/api/admin/inbox/threads/${threadId}/draft`, {
            method: "POST",
            body: JSON.stringify({ channel: "sms", body: draftBody })
          });
          jar.set({ name: "myst-flash", value: "Quote created. Draft SMS prepared in Inbox.", path: "/" });
          redirect(`/team?tab=inbox&threadId=${encodeURIComponent(threadId)}`);
        }
      }
    } catch {
      // ignore draft failures; keep standard flow
    }
  }

  revalidatePath("/team");
}

export async function createContactAction(formData: FormData) {
  const jar = await cookies();

  const firstName = formData.get("firstName");
  const lastName = formData.get("lastName");
  const email = formData.get("email");
  const phone = formData.get("phone");
  const pipelineStage = formData.get("pipelineStage");
  const pipelineNotes = formData.get("pipelineNotes");
  const addressLine1 = formData.get("addressLine1");
  const city = formData.get("city");
  const state = formData.get("state");
  const postalCode = formData.get("postalCode");

  if (
    typeof firstName !== "string" ||
    typeof lastName !== "string" ||
    firstName.trim().length === 0 ||
    lastName.trim().length === 0
  ) {
    jar.set({ name: "myst-flash-error", value: "First and last name are required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: typeof email === "string" && email.trim().length ? email.trim() : undefined,
    phone: typeof phone === "string" && phone.trim().length ? phone.trim() : undefined,
    pipelineStage: typeof pipelineStage === "string" && pipelineStage.trim().length ? pipelineStage.trim() : undefined,
    pipelineNotes: typeof pipelineNotes === "string" && pipelineNotes.trim().length ? pipelineNotes.trim() : undefined
  };

  const hasAddress =
    typeof addressLine1 === "string" &&
    typeof city === "string" &&
    typeof state === "string" &&
    typeof postalCode === "string" &&
    addressLine1.trim().length > 0 &&
    city.trim().length > 0 &&
    state.trim().length > 0 &&
    postalCode.trim().length > 0;

  const anyAddressField =
    (typeof addressLine1 === "string" && addressLine1.trim().length > 0) ||
    (typeof city === "string" && city.trim().length > 0) ||
    (typeof state === "string" && state.trim().length > 0) ||
    (typeof postalCode === "string" && postalCode.trim().length > 0);

  if (anyAddressField && !hasAddress) {
    jar.set({
      name: "myst-flash-error",
      value: "If you add an address, include street, city, state, and postal code",
      path: "/"
    });
    revalidatePath("/team");
    return;
  }

  if (hasAddress) {
    payload["property"] = {
      addressLine1: addressLine1.trim(),
      city: city.trim(),
      state: state.trim(),
      postalCode: postalCode.trim()
    };
  }

  const response = await callAdminApi("/api/admin/contacts", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let message = "Unable to create contact";
    try {
      const data = (await response.json()) as {
        error?: string;
        existingContact?: { firstName?: string | null; lastName?: string | null } | null;
      };
      if (data.error === "contact_already_exists") {
        const existingName = `${data.existingContact?.firstName ?? ""} ${data.existingContact?.lastName ?? ""}`.trim();
        message = existingName.length > 0 ? `Contact already exists (${existingName}).` : "Contact already exists.";
      } else if (data.error) {
        message = data.error.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contact created", path: "/" });
  revalidatePath("/team");
}

export async function bookAppointmentAction(formData: FormData) {
  const jar = await cookies();

  const contactId = formData.get("contactId");
  const propertyId = formData.get("propertyId");
  const startAt = formData.get("startAt");
  const durationMinutes = formData.get("durationMinutes");
  const travelBufferMinutes = formData.get("travelBufferMinutes");
  const servicesRaw = formData.get("services");
  const notesRaw = formData.get("notes");
  const quotedTotalCents = parseUsdToCents(formData.get("quotedTotal"));

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  if (typeof startAt !== "string" || startAt.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Start time is required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const parsedDuration = typeof durationMinutes === "string" ? Number(durationMinutes) : NaN;
  const parsedTravel = typeof travelBufferMinutes === "string" ? Number(travelBufferMinutes) : NaN;

  const services =
    typeof servicesRaw === "string" && servicesRaw.trim().length > 0
      ? servicesRaw
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : [];

  const payload: Record<string, unknown> = {
    contactId: contactId.trim(),
    startAt: startAt.trim(),
    durationMinutes: Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 60,
    travelBufferMinutes: Number.isFinite(parsedTravel) && parsedTravel >= 0 ? parsedTravel : 30,
    services
  };

  if (typeof propertyId === "string" && propertyId.trim().length > 0) {
    payload["propertyId"] = propertyId.trim();
  }
  if (typeof notesRaw === "string" && notesRaw.trim().length > 0) {
    payload["notes"] = notesRaw.trim();
  }
  if (quotedTotalCents !== null) {
    payload["quotedTotalCents"] = quotedTotalCents;
  }

  const response = await callAdminApi("/api/admin/booking/book", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to book appointment");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Appointment booked", path: "/" });
  revalidatePath("/team");
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string; message?: string };
    const message = data.message ?? data.error;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.replace(/_/g, " ");
    }
  } catch {
    // ignore
  }
  return fallback;
}

function parseUsdToCents(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,]/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export async function createCanvassLeadAction(formData: FormData) {
  const jar = await cookies();

  const firstName = formData.get("firstName");
  const lastName = formData.get("lastName");
  const phone = formData.get("phone");
  const email = formData.get("email");
  const addressLine1 = formData.get("addressLine1");
  const city = formData.get("city");
  const state = formData.get("state");
  const postalCode = formData.get("postalCode");
  const salespersonMemberId = formData.get("salespersonMemberId");

  const hasPhone = typeof phone === "string" && phone.trim().length > 0;
  const hasEmail = typeof email === "string" && email.trim().length > 0;

  if (typeof firstName !== "string" || firstName.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "First name is required", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (typeof lastName !== "string" || lastName.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Last name is required", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (!hasPhone && !hasEmail) {
    jar.set({ name: "myst-flash-error", value: "Phone or email is required", path: "/" });
    revalidatePath("/team");
    return;
  }

  if (
    typeof addressLine1 !== "string" ||
    typeof city !== "string" ||
    typeof state !== "string" ||
    typeof postalCode !== "string" ||
    addressLine1.trim().length === 0 ||
    city.trim().length === 0 ||
    state.trim().length === 0 ||
    postalCode.trim().length === 0
  ) {
    jar.set({ name: "myst-flash-error", value: "Full address is required for canvass leads", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    pipelineStage: "contacted",
    source: "canvass",
    property: {
      addressLine1: addressLine1.trim(),
      city: city.trim(),
      state: state.trim(),
      postalCode: postalCode.trim()
    }
  };

  if (hasPhone) payload["phone"] = (phone as string).trim();
  if (hasEmail) payload["email"] = (email as string).trim();
  if (typeof salespersonMemberId === "string" && salespersonMemberId.trim().length > 0) {
    payload["salespersonMemberId"] = salespersonMemberId.trim();
  }

  const response = await callAdminApi("/api/admin/contacts", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  type ContactCreateResponse =
    | { contact?: { id: string; salespersonMemberId?: string | null } }
    | { existingContact?: { id?: string } };

  let data: ContactCreateResponse | null = null;
  try {
    data = (await response.json()) as ContactCreateResponse;
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 409) {
      const existingId =
        data && "existingContact" in data && data.existingContact && typeof data.existingContact.id === "string"
          ? data.existingContact.id
          : null;
      if (existingId) {
        jar.set({ name: "myst-flash-error", value: "Contact already exists. Opening existing record.", path: "/" });
        redirect(`/team?tab=quotes&quoteMode=canvass&contactId=${encodeURIComponent(existingId)}`);
      }
    }

    const message = await readErrorMessage(response, "Unable to create canvass lead");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const contactId =
    data && "contact" in data && data.contact && typeof data.contact.id === "string" ? data.contact.id : null;
  if (!contactId) {
    jar.set({ name: "myst-flash-error", value: "Canvass lead created, but no contact ID returned", path: "/" });
    revalidatePath("/team");
    return;
  }

  const assigneeFromForm =
    typeof salespersonMemberId === "string" && salespersonMemberId.trim().length > 0 ? salespersonMemberId.trim() : null;
  const assigneeFromApi =
    data && "contact" in data && data.contact && typeof data.contact.salespersonMemberId === "string"
      ? data.contact.salespersonMemberId
      : null;
  const assignee = assigneeFromForm ?? assigneeFromApi;

  try {
    await callAdminApi("/api/admin/crm/tasks", {
      method: "POST",
      body: JSON.stringify({
        contactId,
        title: "Canvass lead",
        assignedTo: assignee ?? undefined,
        notes: "kind=canvass"
      })
    });
  } catch {
    // ignore task failures
  }

  jar.set({ name: "myst-flash", value: "Canvass lead created", path: "/" });
  redirect(
    `/team?tab=quotes&quoteMode=canvass&contactId=${encodeURIComponent(contactId)}${
      assignee ? `&memberId=${encodeURIComponent(assignee)}` : ""
    }`
  );
}

export async function createCanvassFollowupAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const dueAt = formData.get("dueAt");
  const assignedTo = formData.get("assignedTo");
  const notes = formData.get("notes");

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (typeof dueAt !== "string" || dueAt.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Follow-up time required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    contactId: contactId.trim(),
    title: "Canvass follow-up",
    dueAt: dueAt.trim(),
    notes: `kind=canvass${typeof notes === "string" && notes.trim().length ? `\nnotes=${notes.trim()}` : ""}`
  };

  if (typeof assignedTo === "string" && assignedTo.trim().length > 0) {
    payload["assignedTo"] = assignedTo.trim();
  }

  const response = await callAdminApi("/api/admin/crm/reminders", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to schedule follow-up");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Follow-up scheduled", path: "/" });
  revalidatePath("/team");
}

export async function startContactCallAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const taskId = formData.get("taskId");
  const resolvedTaskId = typeof taskId === "string" && isUuid(taskId.trim()) ? taskId.trim() : null;

  const response = await callAdminApi("/api/admin/calls/start", {
    method: "POST",
    body: JSON.stringify({ contactId: contactId.trim(), ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}) })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to start call");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-flash",
    value: "Ringing assigned salesperson now... answer to connect",
    path: "/"
  });
  revalidatePath("/team");
}

export async function openContactThreadAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const channel = formData.get("channel");

  const resolvedContactId = typeof contactId === "string" ? contactId.trim() : "";
  const resolvedChannel = typeof channel === "string" ? channel.trim() : "sms";

  if (!resolvedContactId) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  if (resolvedChannel === "dm") {
    jar.set({ name: "myst-flash-error", value: "Messenger thread not found yet.", path: "/" });
    revalidatePath("/team");
    return;
  }

  const ensureRes = await callAdminApi("/api/admin/inbox/threads/ensure", {
    method: "POST",
    body: JSON.stringify({ contactId: resolvedContactId, channel: resolvedChannel })
  });

  if (!ensureRes.ok) {
    const message = await readErrorMessage(ensureRes, "Unable to open a thread for this contact");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const ensurePayload = (await ensureRes.json().catch(() => null)) as { threadId?: string } | null;
  const threadId = typeof ensurePayload?.threadId === "string" ? ensurePayload.threadId.trim() : "";
  if (!threadId) {
    jar.set({ name: "myst-flash-error", value: "Unable to open a thread for this contact", path: "/" });
    revalidatePath("/team");
    return;
  }

  redirect(
    `/team?tab=inbox&threadId=${encodeURIComponent(threadId)}&contactId=${encodeURIComponent(
      resolvedContactId
    )}&channel=${encodeURIComponent(resolvedChannel)}`
  );
}

export async function sendDraftMessageAction(formData: FormData) {
  const jar = await cookies();
  const messageId = formData.get("messageId");
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Message ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/inbox/messages/${messageId.trim()}/retry`, {
    method: "POST",
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to send draft");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Message sending...", path: "/" });
  revalidatePath("/team");
}

export async function updateContactAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {};
  const stringFields: Array<[keyof Record<string, unknown>, string | FormDataEntryValue | null]> = [
    ["firstName", formData.get("firstName")],
    ["lastName", formData.get("lastName")],
    ["email", formData.get("email")],
    ["phone", formData.get("phone")]
  ];

  for (const [key, value] of stringFields) {
    if (typeof value === "string") {
      payload[key] = value.trim();
    }
  }

  const salespersonMemberId = formData.get("salespersonMemberId");
  if (typeof salespersonMemberId === "string") {
    payload["salespersonMemberId"] = salespersonMemberId.trim().length > 0 ? salespersonMemberId.trim() : null;
  }

  if (Object.keys(payload).length === 0) {
    jar.set({ name: "myst-flash-error", value: "No changes to apply", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update contact");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contact updated", path: "/" });
  revalidatePath("/team");
}

export async function updateContactNameAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const firstNameRaw = formData.get("firstName");
  const lastNameRaw = formData.get("lastName");
  const firstName = typeof firstNameRaw === "string" ? firstNameRaw.trim() : "";
  const lastName = typeof lastNameRaw === "string" ? lastNameRaw.trim() : "";

  if (!firstName.length) {
    jar.set({ name: "myst-flash-error", value: "First name is required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = { firstName };
  if (lastName.length) payload["lastName"] = lastName;

  const response = await callAdminApi(`/api/admin/contacts/${contactId.trim()}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update contact name");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contact updated", path: "/" });
  revalidatePath("/team");
}

export async function deleteContactAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/contacts/${contactId}`, { method: "DELETE" });
  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete contact");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contact deleted", path: "/" });
  revalidatePath("/team");
}

export async function addPropertyAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const addressLine1 = formData.get("addressLine1");
  const addressLine2 = formData.get("addressLine2");
  const city = formData.get("city");
  const state = formData.get("state");
  const postalCode = formData.get("postalCode");

  if (
    typeof addressLine1 !== "string" ||
    addressLine1.trim().length === 0 ||
    typeof city !== "string" ||
    city.trim().length === 0 ||
    typeof state !== "string" ||
    state.trim().length === 0 ||
    typeof postalCode !== "string" ||
    postalCode.trim().length === 0
  ) {
    jar.set({ name: "myst-flash-error", value: "Property details are required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/contacts/${contactId}/properties`, {
    method: "POST",
    body: JSON.stringify({
      addressLine1: addressLine1.trim(),
      addressLine2: typeof addressLine2 === "string" && addressLine2.trim().length ? addressLine2.trim() : undefined,
      city: city.trim(),
      state: state.trim(),
      postalCode: postalCode.trim()
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to add property");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Property added", path: "/" });
  revalidatePath("/team");
}

export async function updatePropertyAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const propertyId = formData.get("propertyId");
  if (
    typeof contactId !== "string" ||
    contactId.trim().length === 0 ||
    typeof propertyId !== "string" ||
    propertyId.trim().length === 0
  ) {
    jar.set({ name: "myst-flash-error", value: "Property details missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {};
  const updates: Array<[string, FormDataEntryValue | null]> = [
    ["addressLine1", formData.get("addressLine1")],
    ["addressLine2", formData.get("addressLine2")],
    ["city", formData.get("city")],
    ["state", formData.get("state")],
    ["postalCode", formData.get("postalCode")]
  ];

  for (const [key, value] of updates) {
    if (typeof value === "string") {
      payload[key] = value.trim();
    }
  }

  if (Object.keys(payload).length === 0) {
    jar.set({ name: "myst-flash-error", value: "No property changes to apply", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(
    `/api/admin/contacts/${contactId}/properties/${propertyId}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update property");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Property updated", path: "/" });
  revalidatePath("/team");
}

export async function deletePropertyAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const propertyId = formData.get("propertyId");
  if (
    typeof contactId !== "string" ||
    contactId.trim().length === 0 ||
    typeof propertyId !== "string" ||
    propertyId.trim().length === 0
  ) {
    jar.set({ name: "myst-flash-error", value: "Property details missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(
    `/api/admin/contacts/${contactId}/properties/${propertyId}`,
    { method: "DELETE" }
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete property");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Property removed", path: "/" });
  revalidatePath("/team");
}

export async function updatePipelineStageAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const stage = formData.get("stage");
  const notes = formData.get("notes");

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (typeof stage !== "string" || stage.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Stage is required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = { stage: stage.trim() };
  if (typeof notes === "string") {
    payload["notes"] = notes.trim();
  }

  const response = await callAdminApi(`/api/admin/crm/pipeline/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update stage");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Pipeline updated", path: "/" });
  revalidatePath("/team");
}

function makeNoteTitle(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "Note";
  const maxLen = 60;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLen - 3))}...`;
}

export async function createContactNoteAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const body = formData.get("body");

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  if (typeof body !== "string" || body.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Note body required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    contactId: contactId.trim(),
    title: makeNoteTitle(body),
    notes: body.trim(),
    status: "completed"
  };

  const response = await callAdminApi(`/api/admin/crm/tasks`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to add note");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Note added", path: "/" });
  revalidatePath("/team");
}

export async function deleteContactNoteAction(formData: FormData) {
  const jar = await cookies();
  const noteId = formData.get("noteId");

  if (typeof noteId !== "string" || noteId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Note ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/crm/tasks/${noteId.trim()}`, { method: "DELETE" });
  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete note");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Note deleted", path: "/" });
  revalidatePath("/team");
}

export async function createTaskAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const title = formData.get("title");
  const dueAt = formData.get("dueAt");
  const assignedTo = formData.get("assignedTo");

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Task title required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    contactId: contactId.trim(),
    title: title.trim()
  };

  if (typeof dueAt === "string" && dueAt.trim().length > 0) {
    payload["dueAt"] = dueAt.trim();
  }
  if (typeof assignedTo === "string" && assignedTo.trim().length > 0) {
    payload["assignedTo"] = assignedTo.trim();
  }

  const response = await callAdminApi(`/api/admin/crm/tasks`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to create task");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Task added", path: "/" });
  revalidatePath("/team");
}

export async function updateTaskAction(formData: FormData) {
  const jar = await cookies();
  const taskId = formData.get("taskId");
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Task ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {};
  const fields: Array<[string, FormDataEntryValue | null]> = [
    ["title", formData.get("title")],
    ["dueAt", formData.get("dueAt")],
    ["assignedTo", formData.get("assignedTo")],
    ["status", formData.get("status")],
    ["notes", formData.get("notes")]
  ];

  for (const [key, value] of fields) {
    if (typeof value === "string") {
      payload[key] = value.trim();
    }
  }

  if (Object.keys(payload).length === 0) {
    jar.set({ name: "myst-flash-error", value: "No task changes to apply", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/crm/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update task");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Task updated", path: "/" });
  revalidatePath("/team");
}

export async function deleteTaskAction(formData: FormData) {
  const jar = await cookies();
  const taskId = formData.get("taskId");
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Task ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/crm/tasks/${taskId}`, { method: "DELETE" });
  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete task");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Task removed", path: "/" });
  revalidatePath("/team");
}

export async function updatePolicyAction(formData: FormData) {
  const jar = await cookies();
  const key = formData.get("key");
  const value = formData.get("value");

  if (typeof key !== "string" || key.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Policy key missing", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Policy value missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    jar.set({ name: "myst-flash-error", value: "Invalid JSON", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/policy", {
    method: "POST",
    body: JSON.stringify({ key: key.trim(), value: parsed })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update policy");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Policy updated", path: "/" });
  revalidatePath("/team");
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
type Weekday = (typeof WEEKDAYS)[number];

function parseTimeField(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  return match ? trimmed : null;
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  return (Number(hours) || 0) * 60 + (Number(minutes) || 0);
}

function parseIntegerField(value: FormDataEntryValue | null, minValue = 0): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < minValue) return null;
  return rounded;
}

function parseNumberField(value: FormDataEntryValue | null, minValue = 0): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < minValue) return null;
  return parsed;
}

function parseListField(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseZipListField(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  const parts = value.split(/[\s,]+/);
  const cleaned = parts
    .map((entry) => entry.replace(/\D/g, "").slice(0, 5))
    .filter((entry) => entry.length === 5);
  return Array.from(new Set(cleaned));
}

function parseTemplateField(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function submitPolicyUpdate(
  jar: Awaited<ReturnType<typeof cookies>>,
  key: string,
  value: Record<string, unknown>,
  successMessage: string
): Promise<void> {
  const response = await callAdminApi("/api/admin/policy", {
    method: "POST",
    body: JSON.stringify({ key, value })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update policy");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: successMessage, path: "/" });
  revalidatePath("/team");
}

export async function updateBusinessHoursPolicyAction(formData: FormData) {
  const jar = await cookies();
  const timezoneRaw = formData.get("timezone");
  const timezone = typeof timezoneRaw === "string" ? timezoneRaw.trim() : "";
  const weekly: Record<Weekday, Array<{ start: string; end: string }>> = {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: []
  };

  for (const day of WEEKDAYS) {
    const closed = formData.get(`${day}_closed`) === "on";
    if (closed) {
      weekly[day] = [];
      continue;
    }
    const start = parseTimeField(formData.get(`${day}_start`));
    const end = parseTimeField(formData.get(`${day}_end`));
    if (!start || !end) {
      jar.set({ name: "myst-flash-error", value: `Missing hours for ${day}`, path: "/" });
      revalidatePath("/team");
      return;
    }
    if (timeToMinutes(end) <= timeToMinutes(start)) {
      jar.set({ name: "myst-flash-error", value: `End time must be after start on ${day}`, path: "/" });
      revalidatePath("/team");
      return;
    }
    weekly[day] = [{ start, end }];
  }

  await submitPolicyUpdate(
    jar,
    "business_hours",
    {
      timezone: timezone.length > 0 ? timezone : "America/New_York",
      weekly
    },
    "Business hours updated"
  );
}

export async function updateQuietHoursPolicyAction(formData: FormData) {
  const jar = await cookies();
  const channels: Record<string, { start: string; end: string }> = {};
  const channelKeys = ["sms", "email", "dm"];

  for (const channel of channelKeys) {
    const always = formData.get(`${channel}_always`) === "on";
    if (always) {
      channels[channel] = { start: "00:00", end: "00:00" };
      continue;
    }
    const start = parseTimeField(formData.get(`${channel}_start`));
    const end = parseTimeField(formData.get(`${channel}_end`));
    if (!start || !end) {
      jar.set({ name: "myst-flash-error", value: `Missing quiet hours for ${channel}`, path: "/" });
      revalidatePath("/team");
      return;
    }
    channels[channel] = { start, end };
  }

  await submitPolicyUpdate(jar, "quiet_hours", { channels }, "Quiet hours updated");
}

export async function updateServiceAreaPolicyAction(formData: FormData) {
  const jar = await cookies();
  const modeRaw = formData.get("mode");
  const mode = modeRaw === "ga_only" || modeRaw === "ga_above_macon" ? String(modeRaw) : "zip_allowlist";
  const homeBaseRaw = formData.get("homeBase");
  const homeBase = typeof homeBaseRaw === "string" ? homeBaseRaw.trim() : "";
  const radiusMiles = parseNumberField(formData.get("radiusMiles"), 0);
  if (radiusMiles === null) {
    jar.set({ name: "myst-flash-error", value: "Radius miles must be a number", path: "/" });
    revalidatePath("/team");
    return;
  }
  const zipAllowlist = mode === "ga_only" || mode === "ga_above_macon" ? [] : parseZipListField(formData.get("zipAllowlist"));
  const notesRaw = formData.get("notes");
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";

  await submitPolicyUpdate(
    jar,
    "service_area",
    {
      mode,
      homeBase: homeBase.length > 0 ? homeBase : undefined,
      radiusMiles,
      zipAllowlist,
      notes: notes.length > 0 ? notes : undefined
    },
    "Service area updated"
  );
}

export async function updateBookingRulesPolicyAction(formData: FormData) {
  const jar = await cookies();
  const bookingWindowDays = parseIntegerField(formData.get("bookingWindowDays"), 1);
  const bufferMinutes = parseIntegerField(formData.get("bufferMinutes"), 0);
  const maxJobsPerDay = parseIntegerField(formData.get("maxJobsPerDay"), 0);
  const maxJobsPerCrew = parseIntegerField(formData.get("maxJobsPerCrew"), 0);

  if (
    bookingWindowDays === null ||
    bufferMinutes === null ||
    maxJobsPerDay === null ||
    maxJobsPerCrew === null
  ) {
    jar.set({ name: "myst-flash-error", value: "Booking rule values must be numbers", path: "/" });
    revalidatePath("/team");
    return;
  }

  await submitPolicyUpdate(
    jar,
    "booking_rules",
    {
      bookingWindowDays,
      bufferMinutes,
      maxJobsPerDay,
      maxJobsPerCrew
    },
    "Booking rules updated"
  );
}

export async function updateStandardJobPolicyAction(formData: FormData) {
  const jar = await cookies();
  const allowedServices = parseListField(formData.get("allowedServices"));
  if (!allowedServices.length) {
    jar.set({ name: "myst-flash-error", value: "Add at least one allowed service", path: "/" });
    revalidatePath("/team");
    return;
  }
  const maxVolumeCubicYards = parseNumberField(formData.get("maxVolumeCubicYards"), 0);
  const maxItemCount = parseIntegerField(formData.get("maxItemCount"), 0);
  const notesRaw = formData.get("notes");
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";

  if (maxVolumeCubicYards === null || maxItemCount === null) {
    jar.set({ name: "myst-flash-error", value: "Standard job values must be numbers", path: "/" });
    revalidatePath("/team");
    return;
  }

  await submitPolicyUpdate(
    jar,
    "standard_job",
    {
      allowedServices,
      maxVolumeCubicYards,
      maxItemCount,
      notes: notes.length > 0 ? notes : undefined
    },
    "Standard job rules updated"
  );
}

export async function updateItemPoliciesAction(formData: FormData) {
  const jar = await cookies();
  const declined = parseListField(formData.get("declined"));
  const extraFees: Array<{ item: string; fee: number }> = [];

  for (let index = 1; index <= 5; index += 1) {
    const itemRaw = formData.get(`fee_item_${index}`);
    const feeRaw = formData.get(`fee_amount_${index}`);
    if (typeof itemRaw !== "string" || itemRaw.trim().length === 0) {
      continue;
    }
    const fee = parseNumberField(feeRaw, 0);
    if (fee === null) {
      jar.set({ name: "myst-flash-error", value: "Extra fee amounts must be numbers", path: "/" });
      revalidatePath("/team");
      return;
    }
    extraFees.push({ item: itemRaw.trim(), fee });
  }

  await submitPolicyUpdate(
    jar,
    "item_policies",
    {
      declined,
      extraFees
    },
    "Item policies updated"
  );
}

export async function updateCompanyProfilePolicyAction(formData: FormData) {
  const jar = await cookies();
  const readText = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };

  const businessName = readText("businessName");
  const primaryPhone = readText("primaryPhone");
  const serviceAreaSummary = readText("serviceAreaSummary");
  const trailerAndPricingSummary = readText("trailerAndPricingSummary");
  const whatWeDo = readText("whatWeDo");
  const whatWeDontDo = readText("whatWeDontDo");
  const bookingStyle = readText("bookingStyle");
  const agentNotes = readText("agentNotes");
  const outboundCallRecordingNotice = readText("outboundCallRecordingNotice");

  if (!businessName) {
    jar.set({ name: "myst-flash-error", value: "Business name is required", path: "/" });
    revalidatePath("/team");
    return;
  }

  await submitPolicyUpdate(
    jar,
    "company_profile",
    {
      businessName,
      primaryPhone: primaryPhone.length > 0 ? primaryPhone : undefined,
      serviceAreaSummary: serviceAreaSummary.length > 0 ? serviceAreaSummary : undefined,
      trailerAndPricingSummary: trailerAndPricingSummary.length > 0 ? trailerAndPricingSummary : undefined,
      whatWeDo: whatWeDo.length > 0 ? whatWeDo : undefined,
      whatWeDontDo: whatWeDontDo.length > 0 ? whatWeDontDo : undefined,
      bookingStyle: bookingStyle.length > 0 ? bookingStyle : undefined,
      agentNotes: agentNotes.length > 0 ? agentNotes : undefined,
      outboundCallRecordingNotice: outboundCallRecordingNotice.length > 0 ? outboundCallRecordingNotice : ""
    },
    "Company profile updated"
  );
}

export async function updateConversationPersonaPolicyAction(formData: FormData) {
  const jar = await cookies();
  const raw = formData.get("systemPrompt");
  const systemPrompt = typeof raw === "string" ? raw.trim() : "";

  if (!systemPrompt) {
    jar.set({ name: "myst-flash-error", value: "System prompt is required", path: "/" });
    revalidatePath("/team");
    return;
  }

  if (systemPrompt.length > 4000) {
    jar.set({ name: "myst-flash-error", value: "System prompt must be 4000 characters or less", path: "/" });
    revalidatePath("/team");
    return;
  }

  await submitPolicyUpdate(
    jar,
    "conversation_persona",
    { systemPrompt },
    "Conversation persona updated"
  );
}

export async function updateInboxAlertsPolicyAction(formData: FormData) {
  const jar = await cookies();
  const sms = formData.get("sms") === "on";
  const dm = formData.get("dm") === "on";
  const email = formData.get("email") === "on";

  await submitPolicyUpdate(
    jar,
    "inbox_alerts",
    { sms, dm, email },
    "Inbox alerts updated"
  );
}

export async function updateTemplatesPolicyAction(formData: FormData) {
  const jar = await cookies();
  const firstTouch: Record<string, string> = {};
  const followUp: Record<string, string> = {};
  const confirmations: Record<string, string> = {};
  const reviews: Record<string, string> = {};
  const outOfArea: Record<string, string> = {};

  const firstTouchFields = ["sms", "email", "dm", "call", "web"];
  const followUpFields = ["sms", "email"];
  const confirmationsFields = ["sms", "email"];
  const reviewsFields = ["sms", "email"];
  const outOfAreaFields = ["sms", "email", "web"];

  for (const field of firstTouchFields) {
    const value = parseTemplateField(formData.get(`first_touch_${field}`));
    if (value) firstTouch[field] = value;
  }
  for (const field of followUpFields) {
    const value = parseTemplateField(formData.get(`follow_up_${field}`));
    if (value) followUp[field] = value;
  }
  for (const field of confirmationsFields) {
    const value = parseTemplateField(formData.get(`confirmations_${field}`));
    if (value) confirmations[field] = value;
  }
  for (const field of reviewsFields) {
    const value = parseTemplateField(formData.get(`reviews_${field}`));
    if (value) reviews[field] = value;
  }
  for (const field of outOfAreaFields) {
    const value = parseTemplateField(formData.get(`out_of_area_${field}`));
    if (value) outOfArea[field] = value;
  }

  await submitPolicyUpdate(
    jar,
    "templates",
    {
      first_touch: firstTouch,
      follow_up: followUp,
      confirmations,
      reviews,
      out_of_area: outOfArea
    },
    "Templates updated"
  );
}

export async function updateReviewRequestPolicyAction(formData: FormData) {
  const jar = await cookies();
  const enabled = formData.get("enabled") === "on";
  const rawUrl = formData.get("reviewUrl");
  const reviewUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";

  if (!reviewUrl) {
    jar.set({ name: "myst-flash-error", value: "Review link is required", path: "/" });
    revalidatePath("/team");
    return;
  }

  try {
    // Allow either g.page, https://, etc. If missing scheme, assume https.
    const normalized = /^https?:\/\//i.test(reviewUrl) ? reviewUrl : `https://${reviewUrl}`;
    // eslint-disable-next-line no-new
    new URL(normalized);
  } catch {
    jar.set({ name: "myst-flash-error", value: "Review link must be a valid URL", path: "/" });
    revalidatePath("/team");
    return;
  }

  await submitPolicyUpdate(
    jar,
    "review_request",
    { enabled, reviewUrl },
    "Review request settings updated"
  );
}

export async function updateConfirmationLoopPolicyAction(formData: FormData) {
  const jar = await cookies();
  const enabled = formData.get("enabled") === "on";
  const windows = [
    parseNumberField(formData.get("window_hours_1"), 0),
    parseNumberField(formData.get("window_hours_2"), 0),
    parseNumberField(formData.get("window_hours_3"), 0)
  ]
    .filter((value): value is number => value !== null && value > 0)
    .map((hours) => Math.round(hours * 60));

  const windowsMinutes = windows.length ? windows : [24 * 60, 2 * 60];

  await submitPolicyUpdate(
    jar,
    "confirmation_loop",
    {
      enabled,
      windowsMinutes
    },
    "Confirmation loop updated"
  );
}

export async function updateFollowUpSequencePolicyAction(formData: FormData) {
  const jar = await cookies();
  const enabled = formData.get("enabled") === "on";
  const steps = [
    parseNumberField(formData.get("step_hours_1"), 0),
    parseNumberField(formData.get("step_hours_2"), 0),
    parseNumberField(formData.get("step_hours_3"), 0),
    parseNumberField(formData.get("step_hours_4"), 0)
  ]
    .filter((value): value is number => value !== null && value > 0)
    .map((hours) => Math.round(hours * 60));

  const stepsMinutes = steps.length ? steps : [24 * 60, 72 * 60, 7 * 24 * 60];

  await submitPolicyUpdate(
    jar,
    "follow_up_sequence",
    {
      enabled,
      stepsMinutes
    },
    "Follow-up sequence updated"
  );
}

export async function updateAutomationModeAction(formData: FormData) {
  const jar = await cookies();
  const channel = formData.get("channel");
  const mode = formData.get("mode");

  if (typeof channel !== "string" || channel.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Channel missing", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (typeof mode !== "string" || mode.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Mode missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/automation", {
    method: "POST",
    body: JSON.stringify({ channel: channel.trim(), mode: mode.trim() })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update automation mode");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Automation updated", path: "/" });
  revalidatePath("/team");
}

export async function updateSalesAutopilotPolicyAction(formData: FormData) {
  const jar = await cookies();

  const enabled = formData.get("autopilot_enabled") === "on";
  const autoSendAfterMinutes = formData.get("autoSendAfterMinutes");
  const activityWindowMinutes = formData.get("activityWindowMinutes");
  const retryDelayMinutes = formData.get("retryDelayMinutes");
  const dmSmsFallbackAfterMinutes = formData.get("dmSmsFallbackAfterMinutes");
  const dmMinSilenceBeforeSmsMinutes = formData.get("dmMinSilenceBeforeSmsMinutes");
  const agentDisplayName = formData.get("agentDisplayName");

  const payload: Record<string, unknown> = { enabled };

  for (const [key, value] of [
    ["autoSendAfterMinutes", autoSendAfterMinutes],
    ["activityWindowMinutes", activityWindowMinutes],
    ["retryDelayMinutes", retryDelayMinutes],
    ["dmSmsFallbackAfterMinutes", dmSmsFallbackAfterMinutes],
    ["dmMinSilenceBeforeSmsMinutes", dmMinSilenceBeforeSmsMinutes]
  ] as const) {
    if (typeof value === "string" && value.trim().length > 0) {
      const num = Number(value);
      if (!Number.isNaN(num)) {
        payload[key] = num;
      }
    }
  }

  if (typeof agentDisplayName === "string" && agentDisplayName.trim().length > 0) {
    payload["agentDisplayName"] = agentDisplayName.trim();
  }

  const response = await callAdminApi("/api/admin/sales/autopilot", {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update Sales Autopilot");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Sales Autopilot updated", path: "/" });
  revalidatePath("/team");
}

export async function updateLeadAutomationAction(formData: FormData) {
  const jar = await cookies();
  const leadId = formData.get("leadId");
  const channel = formData.get("channel");
  const paused = formData.get("paused");
  const dnc = formData.get("dnc");
  const humanTakeover = formData.get("humanTakeover");
  const followupState = formData.get("followupState");
  const followupStep = formData.get("followupStep");
  const nextFollowupAt = formData.get("nextFollowupAt");

  if (typeof leadId !== "string" || leadId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Lead ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (typeof channel !== "string" || channel.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Channel missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  let nextFollowupIso: string | null = null;
  if (typeof nextFollowupAt === "string" && nextFollowupAt.trim().length > 0) {
    const parsed = new Date(nextFollowupAt);
    if (Number.isNaN(parsed.getTime())) {
      jar.set({ name: "myst-flash-error", value: "Invalid follow-up date", path: "/" });
      revalidatePath("/team");
      return;
    }
    nextFollowupIso = parsed.toISOString();
  }

  const payload: Record<string, unknown> = {
    leadId: leadId.trim(),
    channel: channel.trim(),
    paused: paused === "on",
    dnc: dnc === "on",
    humanTakeover: humanTakeover === "on"
  };

  if (typeof followupState === "string" && followupState.trim().length > 0) {
    payload["followupState"] = followupState.trim();
  }
  if (typeof followupStep === "string" && followupStep.trim().length > 0) {
    const step = Number(followupStep);
    if (!Number.isNaN(step)) {
      payload["followupStep"] = step;
    }
  }
  if (nextFollowupIso) {
    payload["nextFollowupAt"] = nextFollowupIso;
  }

  const response = await callAdminApi("/api/admin/automation/lead", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update lead automation");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Lead automation updated", path: "/" });
  revalidatePath("/team");
}

export async function scanMergeSuggestionsAction() {
  const jar = await cookies();

  const response = await callAdminApi("/api/admin/merge-suggestions/scan", {
    method: "POST",
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to scan for merges");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Merge scan complete", path: "/" });
  revalidatePath("/team");
}

export async function approveMergeSuggestionAction(formData: FormData) {
  const jar = await cookies();
  const suggestionId = formData.get("suggestionId");
  if (typeof suggestionId !== "string" || suggestionId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Suggestion ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/merge-suggestions/${suggestionId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "approve" })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to approve merge");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contacts merged", path: "/" });
  revalidatePath("/team");
}

export async function declineMergeSuggestionAction(formData: FormData) {
  const jar = await cookies();
  const suggestionId = formData.get("suggestionId");
  if (typeof suggestionId !== "string" || suggestionId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Suggestion ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/merge-suggestions/${suggestionId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "decline" })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to decline merge");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Suggestion declined", path: "/" });
  revalidatePath("/team");
}

export async function manualMergeContactsAction(formData: FormData) {
  const jar = await cookies();
  const targetContactId = formData.get("targetContactId");
  const sourceContactId = formData.get("sourceContactId");
  const reason = formData.get("reason");

  if (
    typeof targetContactId !== "string" ||
    targetContactId.trim().length === 0 ||
    typeof sourceContactId !== "string" ||
    sourceContactId.trim().length === 0
  ) {
    jar.set({ name: "myst-flash-error", value: "Contact IDs required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/merge", {
    method: "POST",
    body: JSON.stringify({
      targetContactId: targetContactId.trim(),
      sourceContactId: sourceContactId.trim(),
      reason: typeof reason === "string" ? reason.trim() : undefined
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to merge contacts");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contacts merged", path: "/" });
  revalidatePath("/team");
}

export async function createRoleAction(formData: FormData) {
  const jar = await cookies();
  const name = formData.get("name");
  const slug = formData.get("slug");
  const permissions = formData.get("permissions");

  if (typeof name !== "string" || name.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Role name required", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (typeof slug !== "string" || slug.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Role slug required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const perms =
    typeof permissions === "string" && permissions.trim().length > 0
      ? permissions
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];

  const response = await callAdminApi("/api/admin/roles", {
    method: "POST",
    body: JSON.stringify({ name: name.trim(), slug: slug.trim(), permissions: perms })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to create role");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Role created", path: "/" });
  revalidatePath("/team");
}

export async function createTeamMemberAction(formData: FormData) {
  const jar = await cookies();
  const name = formData.get("name");
  const email = formData.get("email");
  const roleId = formData.get("roleId");
  const active = formData.get("active");

  if (typeof name !== "string" || name.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Member name required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    name: name.trim(),
    active: active === "on"
  };

  if (typeof email === "string" && email.trim().length > 0) {
    payload["email"] = email.trim();
  }
  if (typeof roleId === "string" && roleId.trim().length > 0) {
    payload["roleId"] = roleId.trim();
  }

  const response = await callAdminApi("/api/admin/team/members", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to create member");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Team member added", path: "/" });
  revalidatePath("/team");
}

export async function updateTeamMemberAction(formData: FormData) {
  const jar = await cookies();
  const memberId = formData.get("memberId");
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Member ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    active: formData.get("active") === "on"
  };

  const roleId = formData.get("roleId");
  if (typeof roleId === "string") {
    payload["roleId"] = roleId.trim();
  }

  const phone = formData.get("phone");
  if (typeof phone === "string") {
    payload["phone"] = phone.trim().length > 0 ? phone.trim() : null;
  }

  const defaultCrewSplitPercent = formData.get("defaultCrewSplitPercent");
  if (typeof defaultCrewSplitPercent === "string") {
    const trimmed = defaultCrewSplitPercent.trim();
    if (trimmed.length === 0) {
      payload["defaultCrewSplitBps"] = null;
    } else {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        jar.set({
          name: "myst-flash-error",
          value: "Crew split % must be between 0 and 100",
          path: "/"
        });
        revalidatePath("/team");
        return;
      }
      payload["defaultCrewSplitBps"] = Math.round(parsed * 100);
    }
  }

  const response = await callAdminApi(`/api/admin/team/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update member");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Member updated", path: "/" });
  revalidatePath("/team");
}

export async function createThreadAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const channel = formData.get("channel");
  const subject = formData.get("subject");

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Contact ID required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    contactId: contactId.trim(),
    channel: typeof channel === "string" && channel.trim().length > 0 ? channel.trim() : "sms"
  };

  if (typeof subject === "string" && subject.trim().length > 0) {
    payload["subject"] = subject.trim();
  }

  const response = await callAdminApi("/api/admin/inbox/threads", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to create thread");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Thread created", path: "/" });
  revalidatePath("/team");
}

export async function updateThreadAction(formData: FormData) {
  const jar = await cookies();
  const threadId = formData.get("threadId");
  const status = formData.get("status");
  const state = formData.get("state");
  const allowBackward = formData.get("allowBackward");

  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Thread ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {};
  if (typeof status === "string" && status.trim().length > 0) {
    payload["status"] = status.trim();
  }
  if (typeof state === "string" && state.trim().length > 0) {
    payload["state"] = state.trim();
  }
  if (allowBackward === "on") {
    payload["allowBackward"] = true;
  }

  const response = await callAdminApi(`/api/admin/inbox/threads/${threadId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update thread");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Thread updated", path: "/" });
  revalidatePath("/team");
}

export async function sendThreadMessageAction(formData: FormData) {
  const jar = await cookies();
  const threadId = formData.get("threadId");
  const contactId = formData.get("contactId");
  const channel = formData.get("channel");
  const body = formData.get("body");
  const subject = formData.get("subject");

  const resolvedChannel = typeof channel === "string" ? channel.trim() : "";
  const attachments = formData
    .getAll("attachments")
    .filter((value): value is File => value instanceof File && value.size > 0);

  let resolvedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (resolvedThreadId.length === 0) {
    const ensuredContactId = typeof contactId === "string" ? contactId.trim() : "";
    const ensuredChannel = resolvedChannel;

    if (!ensuredContactId || !ensuredChannel) {
      jar.set({ name: "myst-flash-error", value: "Thread ID missing", path: "/" });
      revalidatePath("/team");
      return;
    }

    if (ensuredChannel === "dm") {
      jar.set({ name: "myst-flash-error", value: "Messenger thread not found yet.", path: "/" });
      revalidatePath("/team");
      return;
    }

    const ensureRes = await callAdminApi("/api/admin/inbox/threads/ensure", {
      method: "POST",
      body: JSON.stringify({ contactId: ensuredContactId, channel: ensuredChannel })
    });

    if (!ensureRes.ok) {
      const message = await readErrorMessage(ensureRes, "Unable to open a thread for this contact");
      jar.set({ name: "myst-flash-error", value: message, path: "/" });
      revalidatePath("/team");
      return;
    }

    const ensurePayload = (await ensureRes.json().catch(() => null)) as { threadId?: string } | null;
    resolvedThreadId = typeof ensurePayload?.threadId === "string" ? ensurePayload.threadId.trim() : "";
    if (!resolvedThreadId) {
      jar.set({ name: "myst-flash-error", value: "Unable to open a thread for this contact", path: "/" });
      revalidatePath("/team");
      return;
    }
  }
  const trimmedBody = typeof body === "string" ? body.trim() : "";
  if (trimmedBody.length === 0 && attachments.length === 0) {
    jar.set({ name: "myst-flash-error", value: "Add a message or attach photos first", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    body: trimmedBody,
    direction: "outbound",
    ...(resolvedChannel ? { channel: resolvedChannel } : {})
  };
  if (typeof subject === "string" && subject.trim().length > 0) {
    payload["subject"] = subject.trim();
  }

  if (attachments.length > 0) {
    if (resolvedChannel !== "sms" && resolvedChannel !== "dm") {
      jar.set({ name: "myst-flash-error", value: "Attachments are only supported for SMS and Messenger right now.", path: "/" });
      revalidatePath("/team");
      return;
    }

    const uploadForm = new FormData();
    for (const file of attachments) {
      uploadForm.append("file", file, file.name);
    }

    const uploadRes = await callAdminApi("/api/admin/inbox/uploads", {
      method: "POST",
      body: uploadForm
    });

    if (!uploadRes.ok) {
      const message = await readErrorMessage(uploadRes, "Unable to upload attachments");
      jar.set({ name: "myst-flash-error", value: message, path: "/" });
      revalidatePath("/team");
      return;
    }

    const uploadPayload = (await uploadRes.json().catch(() => null)) as { uploads?: { url?: unknown }[] } | null;
    const mediaUrls =
      uploadPayload?.uploads
        ?.map((item) => (item && typeof item.url === "string" ? item.url.trim() : ""))
        .filter((url) => url.length > 0) ?? [];

    if (mediaUrls.length === 0) {
      jar.set({ name: "myst-flash-error", value: "Unable to upload attachments", path: "/" });
      revalidatePath("/team");
      return;
    }

    payload["mediaUrls"] = mediaUrls;
  }

  const response = await callAdminApi(`/api/admin/inbox/threads/${resolvedThreadId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to send message");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: attachments.length ? "Message + photos queued" : "Message queued", path: "/" });
  revalidatePath("/team");
}

export async function retryFailedMessageAction(formData: FormData) {
  const jar = await cookies();
  const messageId = formData.get("messageId");
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Message ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/inbox/messages/${messageId}/retry`, {
    method: "POST",
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to retry message");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Message retry queued", path: "/" });
  revalidatePath("/team");
}

export async function deleteMessageAction(formData: FormData) {
  const jar = await cookies();
  const messageId = formData.get("messageId");
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Message ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi(`/api/admin/inbox/messages/${messageId}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete message");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Message deleted", path: "/" });
  revalidatePath("/team");
}

export async function suggestThreadReplyAction(formData: FormData) {
  const jar = await cookies();
  const threadId = formData.get("threadId");
  const contactId = formData.get("contactId");
  const channel = formData.get("channel");

  let resolvedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  const resolvedChannel = typeof channel === "string" ? channel.trim() : "";
  const resolvedContactId = typeof contactId === "string" ? contactId.trim() : "";
  if (resolvedThreadId.length === 0) {
    const ensuredContactId = resolvedContactId;
    const ensuredChannel = resolvedChannel;

    if (!ensuredContactId || !ensuredChannel) {
      jar.set({ name: "myst-flash-error", value: "Thread ID missing", path: "/" });
      revalidatePath("/team");
      return;
    }

    if (ensuredChannel === "dm") {
      jar.set({ name: "myst-flash-error", value: "Messenger thread not found yet.", path: "/" });
      revalidatePath("/team");
      return;
    }

    const ensureRes = await callAdminApi("/api/admin/inbox/threads/ensure", {
      method: "POST",
      body: JSON.stringify({ contactId: ensuredContactId, channel: ensuredChannel })
    });

    if (!ensureRes.ok) {
      const message = await readErrorMessage(ensureRes, "Unable to open a thread for this contact");
      jar.set({ name: "myst-flash-error", value: message, path: "/" });
      revalidatePath("/team");
      return;
    }

    const ensurePayload = (await ensureRes.json().catch(() => null)) as { threadId?: string } | null;
    resolvedThreadId = typeof ensurePayload?.threadId === "string" ? ensurePayload.threadId.trim() : "";
    if (!resolvedThreadId) {
      jar.set({ name: "myst-flash-error", value: "Unable to open a thread for this contact", path: "/" });
      revalidatePath("/team");
      return;
    }
  }

  const response = await callAdminApi(`/api/admin/inbox/threads/${resolvedThreadId}/suggest`, {
    method: "POST",
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to generate suggestion");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "AI draft created. Review and click Send when ready.", path: "/" });
  redirect(`/team?tab=inbox&threadId=${encodeURIComponent(resolvedThreadId)}${resolvedChannel ? `&channel=${encodeURIComponent(resolvedChannel)}` : ""}${resolvedContactId ? `&contactId=${encodeURIComponent(resolvedContactId)}` : ""}`);
}

export async function logoutCrew() {
  const jar = await cookies();
  jar.set({ name: "myst-crew-session", value: "", path: "/", maxAge: 0 });
  redirect("/team");
}

export async function logoutOwner() {
  const jar = await cookies();
  jar.set({ name: "myst-admin-session", value: "", path: "/", maxAge: 0 });
  redirect("/team");
}

export async function dismissNewLeadAction(formData: FormData) {
  const jar = await cookies();
  const contactId = formData.get("contactId");

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-new-lead-dismissed",
    value: contactId.trim(),
    path: "/",
    maxAge: 60 * 60 * 24
  });

  revalidatePath("/team");
}

export async function updateDefaultSalesAssigneeAction(formData: FormData) {
  const jar = await cookies();
  const memberIdRaw = formData.get("defaultAssigneeMemberId");

  if (memberIdRaw !== null && typeof memberIdRaw !== "string") {
    jar.set({ name: "myst-flash-error", value: "Invalid selection", path: "/" });
    revalidatePath("/team");
    return;
  }

  const memberId = typeof memberIdRaw === "string" ? memberIdRaw.trim() : "";

  const response = await callAdminApi("/api/admin/sales/settings", {
    method: "PATCH",
    body: JSON.stringify({
      defaultAssigneeMemberId: memberId.length ? memberId : null
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update default salesperson");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Default salesperson updated", path: "/" });
  revalidatePath("/team");
  redirect("/team?tab=access");
}

export async function resetSalesHqAction() {
  const jar = await cookies();

  const response = await callAdminApi("/api/admin/sales/reset", {
    method: "POST",
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to reset Sales HQ");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Sales HQ cleared. Only new leads will appear going forward.", path: "/" });
  revalidatePath("/team");
}

export async function deleteCallCoachingAction(formData: FormData) {
  const jar = await cookies();
  const callRecordIdRaw = formData.get("callRecordId");

  if (typeof callRecordIdRaw !== "string" || callRecordIdRaw.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Missing call id", path: "/" });
    revalidatePath("/team");
    return;
  }

  const callRecordId = callRecordIdRaw.trim();
  const response = await callAdminApi(`/api/admin/calls/coaching/${encodeURIComponent(callRecordId)}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete call coaching");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Call coaching deleted.", path: "/" });
  revalidatePath("/team?tab=sales-hq");
}

export async function markSalesTouchAction(formData: FormData) {
  const jar = await cookies();
  const contactIdRaw = formData.get("contactId");

  if (typeof contactIdRaw !== "string" || contactIdRaw.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Missing contact id", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/sales/touch", {
    method: "POST",
    body: JSON.stringify({ contactId: contactIdRaw.trim() })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to mark contacted");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Marked contacted.", path: "/" });
  revalidatePath("/team");
}

export async function setSalesDispositionAction(formData: FormData) {
  const jar = await cookies();
  const contactIdRaw = formData.get("contactId");
  const dispositionRaw = formData.get("disposition");

  if (typeof contactIdRaw !== "string" || contactIdRaw.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Missing contact id", path: "/" });
    revalidatePath("/team");
    return;
  }

  if (typeof dispositionRaw !== "string" || dispositionRaw.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Missing disposition", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/sales/disposition", {
    method: "POST",
    body: JSON.stringify({
      contactId: contactIdRaw.trim(),
      disposition: dispositionRaw.trim()
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to remove from Sales HQ");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Removed from Sales HQ.", path: "/" });
  revalidatePath("/team");
}

export async function runSeoAutopublishAction() {
  const jar = await cookies();

  const response = await callAdminApi("/api/admin/seo/run", {
    method: "POST",
    body: JSON.stringify({ force: true })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to run SEO agent");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect("/team?tab=seo");
  }

  const payload = (await response.json().catch(() => ({}))) as any;
  const result = payload?.result;

  if (result?.ok === true && result?.skipped === false && typeof result?.slug === "string") {
    jar.set({ name: "myst-flash", value: `SEO post published: /blog/${result.slug}`, path: "/" });
  } else if (result?.ok === true && result?.skipped === true && typeof result?.reason === "string") {
    jar.set({ name: "myst-flash", value: `SEO run skipped: ${result.reason}`, path: "/" });
  } else if (result?.ok === false && typeof result?.error === "string") {
    jar.set({ name: "myst-flash-error", value: `SEO run failed: ${result.error}`, path: "/" });
  } else {
    jar.set({ name: "myst-flash", value: "SEO run started", path: "/" });
  }

  redirect("/team?tab=seo");
}

export async function runGoogleAdsSyncAction() {
  const jar = await cookies();

  const response = await callAdminApi("/api/admin/google/ads/sync", {
    method: "POST",
    body: JSON.stringify({ days: 14 })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to sync Google Ads");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect("/team?tab=marketing");
  }

  jar.set({ name: "myst-flash", value: "Google Ads sync queued.", path: "/" });
  redirect("/team?tab=marketing");
}

export async function runGoogleAdsAnalystAction() {
  const jar = await cookies();

  const response = await callAdminApi("/api/admin/google/ads/analyst/run", {
    method: "POST",
    body: JSON.stringify({ rangeDays: 7 })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to run marketing analyst");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect("/team?tab=marketing");
  }

  jar.set({ name: "myst-flash", value: "Marketing analyst queued.", path: "/" });
  redirect("/team?tab=marketing");
}

export async function saveGoogleAdsAnalystSettingsAction(formData: FormData) {
  const jar = await cookies();
  const autonomous = formData.get("autonomous");
  const autonomousEnabled =
    autonomous === "on" || autonomous === "true";

  const response = await callAdminApi("/api/admin/google/ads/analyst/settings", {
    method: "POST",
    body: JSON.stringify({ autonomous: autonomousEnabled })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to save marketing analyst settings");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect("/team?tab=marketing");
  }

  jar.set({ name: "myst-flash", value: "Marketing analyst settings updated.", path: "/" });
  redirect("/team?tab=marketing");
}

export async function updateGoogleAdsAnalystRecommendationAction(formData: FormData) {
  const jar = await cookies();
  const id = formData.get("id");
  const status = formData.get("status");

  if (typeof id !== "string" || typeof status !== "string") {
    jar.set({ name: "myst-flash-error", value: "Missing recommendation update", path: "/" });
    redirect("/team?tab=marketing");
  }

  const response = await callAdminApi("/api/admin/google/ads/analyst/recommendations", {
    method: "POST",
    body: JSON.stringify({ id, status })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update recommendation");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect("/team?tab=marketing");
  }

  jar.set({ name: "myst-flash", value: "Recommendation updated.", path: "/" });
  redirect("/team?tab=marketing");
}

export async function applyGoogleAdsAnalystRecommendationAction(formData: FormData) {
  const jar = await cookies();
  const id = formData.get("id");

  if (typeof id !== "string") {
    jar.set({ name: "myst-flash-error", value: "Missing recommendation id", path: "/" });
    redirect("/team?tab=marketing");
  }

  const response = await callAdminApi("/api/admin/google/ads/analyst/recommendations/apply", {
    method: "POST",
    body: JSON.stringify({ id })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to apply recommendation");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect("/team?tab=marketing");
  }

  jar.set({ name: "myst-flash", value: "Applied in Google Ads.", path: "/" });
  redirect("/team?tab=marketing");
}

function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed.length) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    return trimmed
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
}

export async function bulkUpdateGoogleAdsAnalystRecommendationsAction(formData: FormData) {
  const jar = await cookies();
  const ids = parseJsonStringArray(formData.get("ids"));
  const status = formData.get("status");

  if (ids.length === 0 || (status !== "approved" && status !== "ignored" && status !== "proposed")) {
    jar.set({ name: "myst-flash-error", value: "Missing bulk update", path: "/" });
    redirect("/team?tab=marketing");
  }

  const response = await callAdminApi("/api/admin/google/ads/analyst/recommendations/bulk", {
    method: "POST",
    body: JSON.stringify({ ids, status })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to bulk update recommendations");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect("/team?tab=marketing");
  }

  jar.set({ name: "myst-flash", value: `Updated ${ids.length} recommendation(s).`, path: "/" });
  redirect("/team?tab=marketing");
}

export async function bulkApplyGoogleAdsAnalystRecommendationsAction(formData: FormData) {
  const jar = await cookies();
  const ids = parseJsonStringArray(formData.get("ids"));

  if (ids.length === 0) {
    jar.set({ name: "myst-flash-error", value: "Missing bulk apply selection", path: "/" });
    redirect("/team?tab=marketing");
  }

  const response = await callAdminApi("/api/admin/google/ads/analyst/recommendations/apply/bulk", {
    method: "POST",
    body: JSON.stringify({ ids })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to bulk apply recommendations");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect("/team?tab=marketing");
  }

  jar.set({ name: "myst-flash", value: "Applied approved negatives in Google Ads.", path: "/" });
  redirect("/team?tab=marketing");
}

type OutboundImportRow = {
  company?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  city?: string;
  state?: string;
  zip?: string;
  notes?: string;
};

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      const next = line[i + 1];
      if (inQuotes && next === "\"") {
        current += "\"";
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function detectDelimiter(headerLine: string): string {
  const commaCount = (headerLine.match(/,/g) ?? []).length;
  const tabCount = (headerLine.match(/\t/g) ?? []).length;
  const semiCount = (headerLine.match(/;/g) ?? []).length;

  if (tabCount > commaCount && tabCount > semiCount) return "\t";
  if (semiCount > commaCount) return ";";
  return ",";
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function coerceRow(rows: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rows[key];
    if (typeof value === "string" && value.trim().length) return value.trim();
  }
  return undefined;
}

function parseOutboundCsv(text: string): OutboundImportRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const delimiter = detectDelimiter(lines[0] ?? "");
  const headersRaw = parseDelimitedLine(lines[0] ?? "", delimiter);
  const headers = headersRaw.map(normalizeHeader);
  const rows: OutboundImportRow[] = [];

  for (const rawLine of lines.slice(1)) {
    const cells = parseDelimitedLine(rawLine, delimiter);
    const record: Record<string, string> = {};
    for (let i = 0; i < headers.length; i += 1) {
      const header = headers[i];
      if (!header) continue;
      record[header] = (cells[i] ?? "").trim();
    }

    const company = coerceRow(record, ["company", "company_name", "business", "property_manager", "property_management_company"]);
    const contactName = coerceRow(record, ["contactname", "contact_name", "name", "contact", "full_name"]);
    const phone = coerceRow(record, ["phone", "phone_number", "mobile", "cell"]);
    const email = coerceRow(record, ["email", "email_address"]);
    const city = coerceRow(record, ["city"]);
    const state = coerceRow(record, ["state"]);
    const zip = coerceRow(record, ["zip", "zipcode", "postal", "postal_code"]);
    const notes = coerceRow(record, ["notes", "note", "details"]);

    if (!company && !contactName && !phone && !email) continue;

    rows.push({
      company,
      contactName,
      phone,
      email,
      city,
      state,
      zip,
      notes
    });
  }

  return rows;
}

export async function importOutboundProspectsAction(formData: FormData) {
  const jar = await cookies();

  const campaignRaw = formData.get("campaign");
  const campaign = typeof campaignRaw === "string" && campaignRaw.trim().length ? campaignRaw.trim() : "property_management";

  const assigneeRaw = formData.get("assignedToMemberId");
  const assignedToMemberId = typeof assigneeRaw === "string" && assigneeRaw.trim().length ? assigneeRaw.trim() : null;

  const file = formData.get("file");
  const csvTextRaw = formData.get("csv");

  let text = typeof csvTextRaw === "string" ? csvTextRaw : "";
  if ((!text || text.trim().length === 0) && file instanceof File && file.size > 0) {
    text = await file.text();
  }

  if (!text || text.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Paste a CSV or upload a file first.", path: "/" });
    redirect("/team?tab=outbound");
  }

  const parsed = parseOutboundCsv(text);
  if (parsed.length === 0) {
    jar.set({ name: "myst-flash-error", value: "No valid rows found. Include at least email or phone.", path: "/" });
    redirect("/team?tab=outbound");
  }

  const rows = parsed.slice(0, 2000);

  const response = await callAdminApi("/api/admin/outbound/import", {
    method: "POST",
    body: JSON.stringify({
      campaign,
      assignedToMemberId: assignedToMemberId ?? undefined,
      rows
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to import outbound list");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect("/team?tab=outbound");
  }

  const payload = (await response.json().catch(() => ({}))) as any;
  const created = Number(payload?.created ?? 0);
  const updated = Number(payload?.updated ?? 0);
  const tasksCreated = Number(payload?.tasksCreated ?? 0);
  const skipped = Number(payload?.skipped ?? 0);
  const resolvedAssignee = typeof payload?.assignedToMemberId === "string" ? payload.assignedToMemberId : assignedToMemberId;

  jar.set({
    name: "myst-flash",
    value: `Outbound imported: ${created} new, ${updated} updated, ${tasksCreated} tasks, ${skipped} skipped.`,
    path: "/"
  });

  redirect(`/team?tab=outbound${resolvedAssignee ? `&memberId=${encodeURIComponent(resolvedAssignee)}` : ""}`);
}

export async function setOutboundDispositionAction(formData: FormData) {
  const jar = await cookies();
  const taskIdRaw = formData.get("taskId");
  const dispositionRaw = formData.get("disposition");
  const callbackAtRaw = formData.get("callbackAt");

  const taskId = typeof taskIdRaw === "string" ? taskIdRaw.trim() : "";
  const disposition = typeof dispositionRaw === "string" ? dispositionRaw.trim() : "";
  const callbackAtString = typeof callbackAtRaw === "string" ? callbackAtRaw.trim() : "";
  const callbackAt =
    callbackAtString && Number.isFinite(Date.parse(callbackAtString)) ? new Date(callbackAtString).toISOString() : null;

  if (!taskId) {
    jar.set({ name: "myst-flash-error", value: "Task ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (!disposition) {
    jar.set({ name: "myst-flash-error", value: "Disposition required", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/outbound/disposition", {
    method: "POST",
    body: JSON.stringify({
      taskId,
      disposition,
      callbackAt: callbackAt ?? undefined
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to save disposition");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Outbound updated.", path: "/" });
  revalidatePath("/team");
}

export async function startOutboundCadenceAction(formData: FormData) {
  const jar = await cookies();
  const taskIdRaw = formData.get("taskId");
  const taskId = typeof taskIdRaw === "string" ? taskIdRaw.trim() : "";

  if (!taskId) {
    jar.set({ name: "myst-flash-error", value: "Task ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/outbound/start", {
    method: "POST",
    body: JSON.stringify({ taskId })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to start outbound cadence");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Outbound cadence started.", path: "/" });
  revalidatePath("/team");
}

export async function bulkOutboundAction(formData: FormData) {
  const jar = await cookies();

  const actionRaw = formData.get("action");
  const action = typeof actionRaw === "string" ? actionRaw.trim() : "";

  const assignedToRaw = formData.get("assignedToMemberId");
  const assignedToMemberId = typeof assignedToRaw === "string" && assignedToRaw.trim().length ? assignedToRaw.trim() : null;

  const snoozePresetRaw = formData.get("snoozePreset");
  const snoozePreset = typeof snoozePresetRaw === "string" && snoozePresetRaw.trim().length ? snoozePresetRaw.trim() : null;

  const taskIds = formData
    .getAll("taskIds")
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  if (taskIds.length === 0) {
    jar.set({ name: "myst-flash-error", value: "Select at least one prospect first.", path: "/" });
    revalidatePath("/team");
    return;
  }

  if (action !== "assign" && action !== "start" && action !== "assign_start" && action !== "snooze") {
    jar.set({ name: "myst-flash-error", value: "Pick a bulk action first.", path: "/" });
    revalidatePath("/team");
    return;
  }

  if ((action === "assign" || action === "assign_start") && !assignedToMemberId) {
    jar.set({ name: "myst-flash-error", value: "Pick a team member to assign to.", path: "/" });
    revalidatePath("/team");
    return;
  }

  if (action === "snooze" && !snoozePreset) {
    jar.set({ name: "myst-flash-error", value: "Pick a snooze time first.", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/outbound/bulk", {
    method: "POST",
    body: JSON.stringify({
      action,
      assignedToMemberId: assignedToMemberId ?? undefined,
      snoozePreset: snoozePreset ?? undefined,
      taskIds
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to apply bulk action");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload = (await response.json().catch(() => ({}))) as any;
  const updated = Number(payload?.updated ?? 0);
  const skipped = Number(payload?.skipped ?? 0);
  jar.set({
    name: "myst-flash",
    value: `Outbound updated: ${updated} changed (${skipped} skipped).`,
    path: "/"
  });
  revalidatePath("/team");
}

export async function partnerScheduleCheckinAction(formData: FormData) {
  const jar = await cookies();
  const contactIdRaw = formData.get("contactId");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";

  const daysRaw = formData.get("daysFromNow");
  const daysFromNow = typeof daysRaw === "string" && daysRaw.trim().length ? Number(daysRaw.trim()) : null;

  const dueAtRaw = formData.get("dueAt");
  const dueAt = typeof dueAtRaw === "string" && dueAtRaw.trim().length ? dueAtRaw.trim() : null;

  const assignedToRaw = formData.get("assignedToMemberId");
  const assignedToMemberId = typeof assignedToRaw === "string" && assignedToRaw.trim().length ? assignedToRaw.trim() : null;

  if (!contactId) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/partners/checkin", {
    method: "POST",
    body: JSON.stringify({
      contactId,
      ...(dueAt ? { dueAt } : {}),
      ...(daysFromNow !== null && Number.isFinite(daysFromNow) ? { daysFromNow } : {}),
      ...(assignedToMemberId ? { assignedToMemberId } : {})
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to schedule check-in");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Partner check-in scheduled.", path: "/" });
  revalidatePath("/team");
}

export async function partnerLogTouchAction(formData: FormData) {
  const jar = await cookies();
  const contactIdRaw = formData.get("contactId");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";

  const nextTouchDaysRaw = formData.get("nextTouchDays");
  const nextTouchDays =
    typeof nextTouchDaysRaw === "string" && nextTouchDaysRaw.trim().length ? Number(nextTouchDaysRaw.trim()) : null;

  if (!contactId) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/partners/touch", {
    method: "POST",
    body: JSON.stringify({
      contactId,
      ...(nextTouchDays !== null && Number.isFinite(nextTouchDays) ? { nextTouchDays } : {})
    })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to log touch");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Partner touch logged.", path: "/" });
  revalidatePath("/team");
}

export async function partnerLogReferralAction(formData: FormData) {
  const jar = await cookies();
  const contactIdRaw = formData.get("contactId");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";

  if (!contactId) {
    jar.set({ name: "myst-flash-error", value: "Contact ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/partners/referral", {
    method: "POST",
    body: JSON.stringify({ contactId })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to log referral");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Partner referral logged.", path: "/" });
  revalidatePath("/team");
}

function parseRatesCsv(raw: string): Array<{
  serviceKey: string;
  tierKey: string;
  label: string | null;
  amountCents: number;
  sortOrder: number;
}> {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const rows: Array<{
    serviceKey: string;
    tierKey: string;
    label: string | null;
    amountCents: number;
    sortOrder: number;
  }> = [];

  let sortOrder = 0;
  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 3) continue;

    const serviceKey = (parts[0] ?? "").toLowerCase();
    const tierKey = parts[1] ?? "";
    const label = parts.length >= 4 ? (parts[2] ?? "") || null : null;
    const amountRaw = parts.length >= 4 ? parts[3] ?? "" : parts[2] ?? "";

    const amount = Number(String(amountRaw).replace(/[^0-9.]/g, ""));
    if (!serviceKey || !tierKey || !Number.isFinite(amount)) continue;

    rows.push({
      serviceKey,
      tierKey,
      label,
      amountCents: Math.max(0, Math.round(amount * 100)),
      sortOrder
    });
    sortOrder += 1;
  }

  return rows;
}

export async function partnerPortalInviteUserAction(formData: FormData) {
  const jar = await cookies();
  const orgContactIdRaw = formData.get("orgContactId");
  const orgContactId = typeof orgContactIdRaw === "string" ? orgContactIdRaw.trim() : "";

  const emailRaw = formData.get("email");
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";

  const phoneRaw = formData.get("phone");
  const phone = typeof phoneRaw === "string" ? phoneRaw.trim() : "";

  const nameRaw = formData.get("name");
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";

  if (!orgContactId || !email || !name) {
    jar.set({ name: "myst-flash-error", value: "Partner + email + name are required.", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/partners/users", {
    method: "POST",
    body: JSON.stringify({ orgContactId, email, name, phone: phone.length ? phone : null })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to invite partner user");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: `Invite sent to ${email}.`, path: "/" });
  revalidatePath("/team");
}

export async function partnerPortalSaveRatesAction(formData: FormData) {
  const jar = await cookies();
  const orgContactIdRaw = formData.get("orgContactId");
  const orgContactId = typeof orgContactIdRaw === "string" ? orgContactIdRaw.trim() : "";

  const csvRaw = formData.get("ratesCsv");
  const csv = typeof csvRaw === "string" ? csvRaw : "";

  if (!orgContactId) {
    jar.set({ name: "myst-flash-error", value: "Partner missing.", path: "/" });
    revalidatePath("/team");
    return;
  }

  const items = parseRatesCsv(csv);
  if (!items.length) {
    jar.set({
      name: "myst-flash-error",
      value: "No valid rates found. Format: serviceKey,tierKey,label,amount (or serviceKey,tierKey,amount).",
      path: "/"
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApi("/api/admin/partners/rates", {
    method: "POST",
    body: JSON.stringify({ orgContactId, currency: "USD", items })
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to save rates");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Partner rates saved.", path: "/" });
  revalidatePath("/team");
}
