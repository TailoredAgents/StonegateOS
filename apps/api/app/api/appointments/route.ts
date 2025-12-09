import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { inArray, asc, desc, eq } from "drizzle-orm";
import {
  getDb,
  appointments,
  contacts,
  properties,
  leads,
  appointmentNotes,
  appointmentAttachments,
  crmPipeline,
  quotes
} from "@/db";
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
      lat: properties.lat,
      lng: properties.lng,
      servicesRequested: leads.servicesRequested,
      rescheduleToken: appointments.rescheduleToken,
      calendarEventId: appointments.calendarEventId,
      crew: appointments.crew,
      owner: appointments.owner
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
  const contactIds = Array.from(
    new Set(
      baseRows
        .map((row) => row.contactId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  );

  const notesMap = new Map<string, { id: string; body: string; createdAt: string }[]>();
  const attachmentsMap = new Map<
    string,
    { id: string; filename: string; url: string; contentType: string | null; createdAt: string }[]
  >();
  const tasksMap = new Map<string, { id: string; title: string; status: string; createdAt: string }[]>();

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

    const attachmentRows = await db
      .select({
        id: appointmentAttachments.id,
        appointmentId: appointmentAttachments.appointmentId,
        filename: appointmentAttachments.filename,
        url: appointmentAttachments.url,
        contentType: appointmentAttachments.contentType,
        createdAt: appointmentAttachments.createdAt
      })
      .from(appointmentAttachments)
      .where(inArray(appointmentAttachments.appointmentId, appointmentIds));

    for (const att of attachmentRows) {
      if (!attachmentsMap.has(att.appointmentId)) {
        attachmentsMap.set(att.appointmentId, []);
      }
      attachmentsMap.get(att.appointmentId)!.push({
        id: att.id,
        filename: att.filename,
        url: att.url,
        contentType: att.contentType,
        createdAt: att.createdAt.toISOString()
      });
    }

    for (const attList of attachmentsMap.values()) {
      attList.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
    }

    const taskRows = await db
      .select({
        id: appointmentTasks.id,
        appointmentId: appointmentTasks.appointmentId,
        title: appointmentTasks.title,
        status: appointmentTasks.status,
        createdAt: appointmentTasks.createdAt
      })
      .from(appointmentTasks)
      .where(inArray(appointmentTasks.appointmentId, appointmentIds));

    for (const task of taskRows) {
      if (!tasksMap.has(task.appointmentId)) {
        tasksMap.set(task.appointmentId, []);
      }
      tasksMap.get(task.appointmentId)!.push({
        id: task.id,
        title: task.title,
        status: task.status ?? "open",
        createdAt: task.createdAt.toISOString()
      });
    }

    for (const taskList of tasksMap.values()) {
      taskList.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
    }
  }

  const pipelineMap = new Map<string, string>();
  if (contactIds.length > 0) {
    const pipelineRows = await db
      .select({
        contactId: crmPipeline.contactId,
        stage: crmPipeline.stage,
        updatedAt: crmPipeline.updatedAt
      })
      .from(crmPipeline)
      .where(inArray(crmPipeline.contactId, contactIds));
    for (const row of pipelineRows) {
      if (!row.contactId) continue;
      pipelineMap.set(row.contactId, row.stage ?? "new");
    }
  }

  const quoteMap = new Map<string, { status: string; updatedAt: Date }>();
  if (contactIds.length > 0) {
    const quoteRows = await db
      .select({
        contactId: quotes.contactId,
        status: quotes.status,
        updatedAt: quotes.updatedAt
      })
      .from(quotes)
      .where(inArray(quotes.contactId, contactIds))
      .orderBy(desc(quotes.updatedAt));

    for (const row of quoteRows) {
      if (!row.contactId) continue;
      if (quoteMap.has(row.contactId)) continue; // keep most recent
      quoteMap.set(row.contactId, { status: row.status ?? "pending", updatedAt: row.updatedAt });
    }
  }

  const appointmentsDto = baseRows.map((row) => {
    const contactName = row.contactFirstName && row.contactLastName
      ? `${row.contactFirstName} ${row.contactLastName}`
      : row.contactFirstName ?? row.contactLastName ?? "Stonegate Customer";
    const pipelineStage = row.contactId ? pipelineMap.get(row.contactId) ?? null : null;
    const quoteStatus = row.contactId ? quoteMap.get(row.contactId)?.status ?? null : null;

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
      pipelineStage,
      quoteStatus,
      property: {
        id: row.propertyId ?? "unknown",
        addressLine1: row.addressLine1 ?? "Undisclosed",
        city: row.city ?? "",
        state: row.state ?? "",
        postalCode: row.postalCode ?? "",
        lat: row.lat ? Number(row.lat) : null,
        lng: row.lng ? Number(row.lng) : null
      },
      calendarEventId: row.calendarEventId,
      rescheduleToken: row.rescheduleToken,
      crew: row.crew ?? null,
      owner: row.owner ?? null,
      notes: notesMap.get(row.id) ?? [],
      attachments: attachmentsMap.get(row.id) ?? [],
      tasks: tasksMap.get(row.id) ?? []
    };
  });

  return NextResponse.json({ ok: true, data: appointmentsDto });
}

