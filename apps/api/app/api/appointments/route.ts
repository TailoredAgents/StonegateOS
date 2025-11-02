import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { inArray, asc, desc, eq } from "drizzle-orm";
import { getDb, appointments, contacts, properties, leads, appointmentNotes } from "@/db";
import { isAdminRequest } from "../web/admin";

const STATUS_OPTIONS = ["requested", "confirmed", "completed", "no_show", "canceled"] as const;
type StatusOption = (typeof STATUS_OPTIONS)[number];

function parseStatusParam(param: string | null): StatusOption[] | null {
  if (!param || param.trim().length === 0 || param === "all") {
    return null;
  }

  const parts = param
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const valid: StatusOption[] = [];
  for (const part of parts) {
    if ((STATUS_OPTIONS as readonly string[]).includes(part)) {
      valid.push(part as StatusOption);
    }
  }

  return valid.length ? valid : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const statusFilter = parseStatusParam(request.nextUrl.searchParams.get("status"));

  const baseQuery = db
    .select({
      id: appointments.id,
      status: appointments.status,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      createdAt: appointments.createdAt,
      updatedAt: appointments.updatedAt,
      leadId: appointments.leadId,
      contactId: contacts.id,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      propertyId: properties.id,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
      servicesRequested: leads.servicesRequested,
      rescheduleToken: appointments.rescheduleToken,
      calendarEventId: appointments.calendarEventId
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .leftJoin(leads, eq(appointments.leadId, leads.id));

  const filteredQuery =
    statusFilter && statusFilter.length > 0
      ? baseQuery.where(inArray(appointments.status, statusFilter))
      : baseQuery;

  const baseRows = await filteredQuery.orderBy(
    asc(appointments.status),
    asc(appointments.startAt),
    desc(appointments.createdAt)
  );

  const appointmentIds = baseRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const notesMap = new Map<string, { id: string; body: string; createdAt: string }[]>();

  if (appointmentIds.length > 0) {
    const noteRows = await db
      .select({
        id: appointmentNotes.id,
        appointmentId: appointmentNotes.appointmentId,
        body: appointmentNotes.body,
        createdAt: appointmentNotes.createdAt
      })
      .from(appointmentNotes)
      .where(inArray(appointmentNotes.appointmentId, appointmentIds));

    for (const note of noteRows) {
      if (!notesMap.has(note.appointmentId)) {
        notesMap.set(note.appointmentId, []);
      }
      notesMap.get(note.appointmentId)!.push({
        id: note.id,
        body: note.body,
        createdAt: note.createdAt.toISOString()
      });
    }

    for (const noteList of notesMap.values()) {
      noteList.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
    }
  }

  const appointmentsDto = baseRows.map((row) => {
    const contactName = row.contactFirstName && row.contactLastName
      ? `${row.contactFirstName} ${row.contactLastName}`
      : row.contactFirstName ?? row.contactLastName ?? "Stonegate Customer";

    return {
      id: row.id,
      status: row.status,
      startAt: row.startAt ? row.startAt.toISOString() : null,
      durationMinutes: row.durationMinutes,
      travelBufferMinutes: row.travelBufferMinutes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      leadId: row.leadId,
      services: row.servicesRequested ?? [],
      contact: {
        id: row.contactId ?? "unknown",
        name: contactName,
        email: row.contactEmail ?? null,
        phone: row.contactPhoneE164 ?? row.contactPhone ?? null
      },
      property: {
        id: row.propertyId ?? "unknown",
        addressLine1: row.addressLine1 ?? "Undisclosed",
        city: row.city ?? "",
        state: row.state ?? "",
        postalCode: row.postalCode ?? ""
      },
      calendarEventId: row.calendarEventId,
      rescheduleToken: row.rescheduleToken,
      notes: notesMap.get(row.id) ?? []
    };
  });

  return NextResponse.json({ ok: true, data: appointmentsDto });
}

