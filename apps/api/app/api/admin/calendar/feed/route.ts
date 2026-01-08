import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, gte, lte, eq } from "drizzle-orm";
import { getDb, appointments, contacts, properties } from "@/db";
import { getCalendarConfig, getAccessToken, isGoogleCalendarEnabled } from "@/lib/calendar";
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
const DEFAULT_APPOINTMENT_CAPACITY = 2;

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
  if (isGoogleCalendarEnabled()) {
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
  }

  const allEvents: CalendarEvent[] = [...appointmentsEvents, ...externalEvents];
  const conflicts = computeCapacityConflicts(allEvents, DEFAULT_APPOINTMENT_CAPACITY);

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

function computeCapacityConflicts(
  events: CalendarEvent[],
  rawCapacity: number
): Array<{ a: string; b: string }> {
  const capacity =
    typeof rawCapacity === "number" && Number.isFinite(rawCapacity) && rawCapacity > 0
      ? Math.floor(rawCapacity)
      : 1;
  if (capacity <= 1) {
    const conflicts: Array<{ a: string; b: string }> = [];
    for (let i = 0; i < events.length; i++) {
      const a = events[i];
      if (!a) continue;
      for (let j = i + 1; j < events.length; j++) {
        const b = events[j];
        if (!b) continue;
        if (overlaps(a, b)) conflicts.push({ a: a.id, b: b.id });
      }
    }
    return conflicts;
  }

  type Point = { t: number; type: "start" | "end"; id: string };
  const points: Point[] = [];
  for (const evt of events) {
    const start = Date.parse(evt.start);
    const end = Date.parse(evt.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    points.push({ t: start, type: "start", id: evt.id });
    points.push({ t: end, type: "end", id: evt.id });
  }

  points.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    if (a.type === b.type) return 0;
    // End events first so adjacent events don't count as overlaps.
    return a.type === "end" ? -1 : 1;
  });

  const active = new Set<string>();
  const conflictPairs = new Set<string>();

  for (const point of points) {
    if (point.type === "end") {
      active.delete(point.id);
      continue;
    }

    active.add(point.id);
    if (active.size <= capacity) continue;

    for (const otherId of active) {
      if (otherId === point.id) continue;
      const a = otherId < point.id ? otherId : point.id;
      const b = otherId < point.id ? point.id : otherId;
      conflictPairs.add(`${a}|${b}`);
    }
  }

  return Array.from(conflictPairs).map((key) => {
    const [a, b] = key.split("|");
    return { a: a ?? "", b: b ?? "" };
  });
}
