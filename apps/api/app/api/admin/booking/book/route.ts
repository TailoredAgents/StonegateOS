import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getDb, appointments, outboxEvents } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { parseISO } from "date-fns";

type BookRequest = {
  contactId?: string;
  propertyId?: string;
  startAt?: string;
  durationMinutes?: number;
  travelBufferMinutes?: number;
  services?: string[];
};

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: BookRequest = {};
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    payload = (await request.json().catch(() => ({}))) as BookRequest;
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    payload = {
      contactId: form.get("contactId")?.toString(),
      propertyId: form.get("propertyId")?.toString(),
      startAt: form.get("startAt")?.toString(),
      durationMinutes: form.get("durationMinutes") ? Number(form.get("durationMinutes")) : undefined,
      travelBufferMinutes: form.get("travelBufferMinutes") ? Number(form.get("travelBufferMinutes")) : undefined,
      services: form.get("services")
        ? form
            .get("services")!
            .toString()
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
    };
  }

  const contactId = typeof payload.contactId === "string" && payload.contactId.length ? payload.contactId : null;
  const propertyId = typeof payload.propertyId === "string" && payload.propertyId.length ? payload.propertyId : null;
  const startAtIso = typeof payload.startAt === "string" && payload.startAt.length ? payload.startAt : null;
  const durationMinutes =
    typeof payload.durationMinutes === "number" && payload.durationMinutes > 0 ? payload.durationMinutes : 60;
  const travelBufferMinutes =
    typeof payload.travelBufferMinutes === "number" && payload.travelBufferMinutes >= 0
      ? payload.travelBufferMinutes
      : 30;

  if (!contactId || !propertyId || !startAtIso) {
    return NextResponse.json({ error: "contact_property_and_start_required" }, { status: 400 });
  }

  const startAt = parseISO(startAtIso);
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) {
    return NextResponse.json({ error: "invalid_startAt" }, { status: 400 });
  }

  const services =
    Array.isArray(payload.services) && payload.services.length
      ? payload.services.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];

  const db = getDb();
  const [appt] = await db
    .insert(appointments)
    .values({
      contactId,
      propertyId,
      startAt,
      durationMinutes,
      travelBufferMinutes,
      status: "confirmed",
      rescheduleToken: nanoid(24),
      type: "estimate"
    })
    .returning({ id: appointments.id });

  if (!appt) {
    return NextResponse.json({ error: "appointment_create_failed" }, { status: 500 });
  }

  await db.insert(outboxEvents).values({
    type: "estimate.requested",
    payload: {
      appointmentId: appt.id,
      services
    }
  });

  return NextResponse.json({ ok: true, appointmentId: appt.id, startAt: startAt.toISOString() });
}
