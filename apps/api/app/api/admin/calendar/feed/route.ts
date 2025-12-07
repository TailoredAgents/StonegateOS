import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, gte, lte, eq } from "drizzle-orm";
import { getDb, appointments, contacts, properties } from "@/db";
import { getCalendarConfig, getAccessToken } from "@/lib/calendar";
import { isAdminRequest } from "../../../web/admin";

type CalendarEvent = {
  id: string;
  title: string;
  source: "db" | "google";
  start: string;
  end: string;
  appointmentId?: string;
  rescheduleToken?: string | null;
  contactName?: string | null;
  address?: string | null;
  status?: string | null;
};

type CalendarFeedResponse = {
  ok: boolean;
  appointments: CalendarEvent[];
  externalEvents: CalendarEvent[];
  conflicts: Array<{ a: string; b: string }>;
  error?: string;
};

const DEFAULT_DAYS_FORWARD = 30;
const DEFAULT_DAYS_BACK = 1;

export async function GET(request: NextRequest): Promise<NextResponse<CalendarFeedResponse>> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, appointments: [], externalEvents: [], conflicts: [], error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const daysForward = DEFAULT_DAYS_FORWARD;
  const daysBack = DEFAULT_DAYS_BACK;
  const windowStart = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + daysForward * 24 * 60 * 60 * 1000);

  const db = getDb();
  const dbRows = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      rescheduleToken: appointments.rescheduleToken,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .where(
      and(
        gte(appointments.startAt, windowStart),
        lte(appointments.startAt, windowEnd)
      )
    );

  const appointmentsEvents: CalendarEvent[] = dbRows
    .filter((row) => row.startAt)
    .map((row) => {
      const start = row.startAt as Date;
      const end = new Date(start.getTime() + (row.durationMinutes ?? 60) * 60_000);
      const contactName =
        row.contactFirstName && row.contactLastName
          ? `${row.contactFirstName} ${row.contactLastName}`.trim()
          : row.contactFirstName ?? row.contactLastName ?? null;
      const addressParts = [row.addressLine1, row.city, row.state, row.postalCode]
        .filter((part) => typeof part === "string" && part.trim().length > 0)
        .join(", ");
      return {
        id: `db:${row.id}`,
        appointmentId: row.id,
        rescheduleToken: row.rescheduleToken,
        title: contactName ?? "Appointment",
        source: "db",
        start: start.toISOString(),
        end: end.toISOString(),
        contactName,
        address: addressParts.length ? addressParts : null,
        status: row.status ?? null
      };
    });

  const externalEvents: CalendarEvent[] = [];
  const config = getCalendarConfig();
  if (config) {
    const token = await getAccessToken(config);
    if (token) {
      const params = new URLSearchParams({
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        showDeleted: "false"
      });
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
        config.calendarId
      )}/events?${params.toString()}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{
            id?: string;
            status?: string;
            summary?: string;
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
          }>;
        };
        for (const item of data.items ?? []) {
          if (!item || item.status === "cancelled") continue;
          const startIso = item.start?.dateTime ?? (item.start?.date ? `${item.start.date}T00:00:00.000Z` : null);
          const endIso = item.end?.dateTime ?? (item.end?.date ? `${item.end.date}T00:00:00.000Z` : null);
          if (!startIso || !endIso) continue;
          externalEvents.push({
            id: `google:${item.id ?? randomUUID()}`,
            title: item.summary ?? "Calendar event",
            source: "google",
            start: new Date(startIso).toISOString(),
            end: new Date(endIso).toISOString(),
            status: item.status ?? null
          });
        }
      }
    }
  }

  const conflicts: Array<{ a: string; b: string }> = [];
  const allEvents: CalendarEvent[] = [...appointmentsEvents, ...externalEvents];
  for (let i = 0; i < allEvents.length; i++) {
    const a = allEvents[i];
    if (!a) continue;
    for (let j = i + 1; j < allEvents.length; j++) {
      const b = allEvents[j];
      if (!b) continue;
      if (overlaps(a, b)) {
        conflicts.push({ a: a.id, b: b.id });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    appointments: appointmentsEvents,
    externalEvents,
    conflicts
  });
}

function overlaps(a: CalendarEvent, b: CalendarEvent): boolean {
  const aStart = Date.parse(a.start);
  const aEnd = Date.parse(a.end);
  const bStart = Date.parse(b.start);
  const bEnd = Date.parse(b.end);
  return aStart < bEnd && bStart < aEnd;
}
