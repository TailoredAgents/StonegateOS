import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { ADMIN_SESSION_COOKIE, getAdminKey } from "@/lib/admin-session";

type CreateContactPayload = {
  contactName: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  addressLine2?: string | null;
  phone?: string | null;
  email?: string | null;
};

type CreateQuotePayload = {
  contactId: string;
  propertyId: string;
  services: string[];
  notes?: string | null;
  note?: string | null;
  appointmentId?: string | null;
  zoneId?: string | null;
};

type CreateTaskPayload = {
  appointmentId: string;
  title: string;
  note?: string | null;
};

type AddContactNotePayload = {
  contactId: string;
  body: string;
};

type CreateReminderPayload = {
  contactId: string;
  title?: string | null;
  dueAt: string;
  notes?: string | null;
  assignedTo?: string | null;
};

type BookAppointmentPayload = {
  contactId: string;
  propertyId: string;
  startAt: string;
  durationMinutes?: number;
  travelBufferMinutes?: number;
  services?: string[];
  note?: string | null;
};

type CancelAppointmentPayload = {
  appointmentId: string;
};

type ActionRequest =
  | { type: "create_contact"; payload: CreateContactPayload }
  | { type: "create_quote"; payload: CreateQuotePayload }
  | { type: "create_task"; payload: CreateTaskPayload }
  | { type: "add_contact_note"; payload: AddContactNotePayload }
  | { type: "create_reminder"; payload: CreateReminderPayload }
  | { type: "book_appointment"; payload: BookAppointmentPayload }
  | { type: "cancel_appointment"; payload: CancelAppointmentPayload };

const ACTIONS_ENABLED = process.env["CHAT_ACTIONS_ENABLED"] !== "false";
const ACTION_RATE_LIMIT_MS = Number(process.env["CHAT_ACTION_RATE_MS"] ?? 0);
const lastActionByType = new Map<string, number>();

function hasOwnerSession(request: NextRequest): boolean {
  const adminKey = getAdminKey();
  if (!adminKey) return false;
  return request.cookies.get(ADMIN_SESSION_COOKIE)?.value === adminKey;
}

function getAdminContext() {
  const apiBase =
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:3001";
  const adminKey = process.env["ADMIN_API_KEY"];
  return { apiBase: apiBase.replace(/\/$/, ""), adminKey };
}

export async function POST(request: NextRequest) {
  if (!hasOwnerSession(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as ActionRequest | null;
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (!ACTIONS_ENABLED) {
    return NextResponse.json({ error: "actions_disabled" }, { status: 403 });
  }

  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) {
    return NextResponse.json({ error: "admin_key_missing" }, { status: 401 });
  }

  const now = Date.now();
  const last = lastActionByType.get(payload.type);
  if (ACTION_RATE_LIMIT_MS > 0 && last && now - last < ACTION_RATE_LIMIT_MS) {
    return NextResponse.json({ error: "rate_limited", retryInMs: ACTION_RATE_LIMIT_MS - (now - last) }, { status: 429 });
  }
  lastActionByType.set(payload.type, now);

  if (payload.type === "create_contact") {
    const body = payload.payload;
    if (
      !body ||
      typeof body.contactName !== "string" ||
      typeof body.addressLine1 !== "string" ||
      typeof body.city !== "string" ||
      typeof body.state !== "string" ||
      typeof body.postalCode !== "string"
    ) {
      return NextResponse.json({ error: "missing_contact_fields" }, { status: 400 });
    }

    const res = await fetch(`${apiBase}/api/admin/tools/contact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        contactName: body.contactName.trim(),
        addressLine1: body.addressLine1.trim(),
        city: body.city.trim(),
        state: body.state.trim(),
        postalCode: body.postalCode.trim(),
        addressLine2: typeof body.addressLine2 === "string" ? body.addressLine2.trim() : undefined,
        phone: typeof body.phone === "string" ? body.phone.trim() : undefined,
        email: typeof body.email === "string" ? body.email.trim() : undefined
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "contact_create_failed", detail: detail.slice(0, 200) }, { status: res.status });
    }

    const data = await res.json().catch(() => ({}));
    console.info("[chat-actions] contact created", { result: data });
    return NextResponse.json({ ok: true, type: payload.type, result: data });
  }

  if (payload.type === "create_quote") {
    const body = payload.payload;
    if (
      !body ||
      typeof body.contactId !== "string" ||
      typeof body.propertyId !== "string" ||
      !Array.isArray(body.services)
    ) {
      return NextResponse.json({ error: "missing_quote_fields" }, { status: 400 });
    }

    const res = await fetch(`${apiBase}/api/admin/tools/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        ...body,
        notes: typeof body.notes === "string" && body.notes.trim().length ? body.notes.trim() : body.note ?? null
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "quote_create_failed", detail: detail.slice(0, 200) }, { status: res.status });
    }

    const data = await res.json().catch(() => ({}));
    console.info("[chat-actions] quote created", { result: data });
    return NextResponse.json({ ok: true, type: payload.type, result: data });
  }

  if (payload.type === "create_task") {
    const body = payload.payload;
    if (!body || typeof body.appointmentId !== "string" || typeof body.title !== "string") {
      return NextResponse.json({ error: "missing_task_fields" }, { status: 400 });
    }

    const titleWithNote =
      body.note && body.note.trim().length && !body.title.includes(body.note)
        ? `${body.title} — ${body.note.trim()}`
        : body.title;

    const res = await fetch(`${apiBase}/api/appointments/${body.appointmentId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({ title: titleWithNote })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "task_create_failed", detail: detail.slice(0, 200) }, { status: res.status });
    }

    const data = await res.json().catch(() => ({}));
    console.info("[chat-actions] task created", { result: data });
    return NextResponse.json({ ok: true, type: payload.type, result: data });
  }

  if (payload.type === "add_contact_note") {
    const body = payload.payload;
    if (!body || typeof body.contactId !== "string" || typeof body.body !== "string") {
      return NextResponse.json({ error: "missing_note_fields" }, { status: 400 });
    }

    const noteBody = body.body.trim();
    if (!noteBody.length) {
      return NextResponse.json({ error: "note_body_required" }, { status: 400 });
    }

    const title = noteBody.length <= 60 ? noteBody : `${noteBody.slice(0, 57)}...`;

    const res = await fetch(`${apiBase}/api/admin/crm/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        contactId: body.contactId,
        title,
        notes: noteBody,
        status: "completed"
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "note_create_failed", detail: detail.slice(0, 200) }, { status: res.status });
    }

    const data = await res.json().catch(() => ({}));
    console.info("[chat-actions] note created", { result: data });
    return NextResponse.json({
      ok: true,
      type: payload.type,
      result: { summary: "Note added", ...(data && typeof data === "object" ? data : {}) }
    });
  }

  if (payload.type === "create_reminder") {
    const body = payload.payload;
    if (!body || typeof body.contactId !== "string" || typeof body.dueAt !== "string") {
      return NextResponse.json({ error: "missing_reminder_fields" }, { status: 400 });
    }

    const title = typeof body.title === "string" && body.title.trim().length ? body.title.trim() : "Call back";
    const dueAt = body.dueAt.trim();
    const parsed = new Date(dueAt);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "invalid_due_at" }, { status: 400 });
    }

    const res = await fetch(`${apiBase}/api/admin/crm/reminders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        contactId: body.contactId,
        title,
        dueAt,
        notes: typeof body.notes === "string" && body.notes.trim().length ? body.notes.trim() : undefined,
        assignedTo: typeof body.assignedTo === "string" && body.assignedTo.trim().length ? body.assignedTo.trim() : undefined
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: "reminder_create_failed", detail: detail.slice(0, 200) },
        { status: res.status }
      );
    }

    const data = await res.json().catch(() => ({}));
    console.info("[chat-actions] reminder created", { result: data });
    return NextResponse.json({
      ok: true,
      type: payload.type,
      result: { summary: "Reminder created", ...(data && typeof data === "object" ? data : {}) }
    });
  }

  if (payload.type === "book_appointment") {
    const body = payload.payload;
    if (!body || typeof body.contactId !== "string" || typeof body.propertyId !== "string" || typeof body.startAt !== "string") {
      return NextResponse.json({ error: "missing_booking_fields" }, { status: 400 });
    }
    if (body.durationMinutes !== undefined && (!Number.isFinite(body.durationMinutes) || body.durationMinutes <= 0)) {
      return NextResponse.json({ error: "invalid_duration" }, { status: 400 });
    }
    if (body.travelBufferMinutes !== undefined && (!Number.isFinite(body.travelBufferMinutes) || body.travelBufferMinutes < 0)) {
      return NextResponse.json({ error: "invalid_travel_buffer" }, { status: 400 });
    }

    const res = await fetch(`${apiBase}/api/admin/booking/book`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        contactId: body.contactId,
        propertyId: body.propertyId,
        startAt: body.startAt,
        durationMinutes: typeof body.durationMinutes === "number" ? body.durationMinutes : 60,
        travelBufferMinutes: typeof body.travelBufferMinutes === "number" ? body.travelBufferMinutes : 30,
        services: Array.isArray(body.services)
          ? body.services.filter((s) => typeof s === "string" && s.trim().length).slice(0, 3)
          : [],
        note: typeof body.note === "string" && body.note.trim().length ? body.note.trim() : undefined
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "booking_failed", detail: detail.slice(0, 200) }, { status: res.status });
    }

    const data = await res.json().catch(() => ({}));
    console.info("[chat-actions] appointment booked", { result: data });
    return NextResponse.json({ ok: true, type: payload.type, result: data });
  }

  if (payload.type === "cancel_appointment") {
    const body = payload.payload;
    if (!body || typeof body.appointmentId !== "string") {
      return NextResponse.json({ error: "missing_cancel_fields" }, { status: 400 });
    }

    const res = await fetch(`${apiBase}/api/appointments/${body.appointmentId}/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({ status: "canceled" })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json({ error: "cancel_failed", detail: detail.slice(0, 200) }, { status: res.status });
    }

    const data = await res.json().catch(() => ({}));
    console.info("[chat-actions] appointment canceled", { result: data });
    return NextResponse.json({ ok: true, type: payload.type, result: data });
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}
