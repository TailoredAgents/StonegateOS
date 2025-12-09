import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { headers } from "next/headers";

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

type BookAppointmentPayload = {
  contactId: string;
  propertyId: string;
  startAt: string;
  durationMinutes?: number;
  travelBufferMinutes?: number;
  services?: string[];
};

type ActionRequest =
  | { type: "create_contact"; payload: CreateContactPayload }
  | { type: "create_quote"; payload: CreateQuotePayload }
  | { type: "create_task"; payload: CreateTaskPayload }
  | { type: "book_appointment"; payload: BookAppointmentPayload };

function getAdminContext() {
  const apiBase =
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:3001";
  const adminKey = process.env["ADMIN_API_KEY"];
  return { apiBase: apiBase.replace(/\/$/, ""), adminKey };
}

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as ActionRequest | null;
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const { apiBase, adminKey } = getAdminContext();
  const hdrs = await headers();
  const apiKey = adminKey ?? hdrs.get("x-api-key");
  if (!apiKey) {
    return NextResponse.json({ error: "admin_key_missing" }, { status: 401 });
  }

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
      body: JSON.stringify(body)
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

  if (payload.type === "book_appointment") {
    const body = payload.payload;
    if (!body || typeof body.contactId !== "string" || typeof body.propertyId !== "string" || typeof body.startAt !== "string") {
      return NextResponse.json({ error: "missing_booking_fields" }, { status: 400 });
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
        services: Array.isArray(body.services) ? body.services : []
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

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}
