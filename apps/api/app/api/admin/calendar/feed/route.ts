import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  parseGoogleCalendarEventListResponse,
  resolveGoogleCalendarApiEndpoint,
} from "@myst-os/sdk";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import {
  getDb,
  appointmentNotes,
  appointmentCrewMembers,
  appointments,
  contacts,
  crmTasks,
  properties,
  teamMembers,
  type AppointmentBookingDetails,
} from "@/db";
import {
  getCalendarConfig,
  getAccessToken,
  isGoogleCalendarEnabled,
} from "@/lib/calendar";
import { getAppointmentCapacity } from "@/lib/appointment-capacity";
import { resolveEasternDayBoundary } from "@/lib/appointment-time";
import { parseAppointmentBookingDetails } from "@/lib/appointment-booking-details";
import {
  getEtaSummariesForAppointments,
  type EtaAppointmentSummary,
} from "@/lib/eta-agent";
import {
  getAppointmentMediaSummaryMap,
  type AppointmentMediaSummary,
} from "@/lib/appointment-media";
import { getAppointmentPaymentSummaryMap } from "@/lib/payment-ledger";
import type { AppointmentPaymentSummary } from "@/lib/payment-summary";
import { requirePermission } from "@/lib/permissions";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { isAdminRequest } from "../../../web/admin";

type CalendarEvent = {
  id: string;
  title: string;
  source: "db" | "google";
  start: string;
  end: string;
  appointmentId?: string;
  appointmentType?: string | null;
  rescheduleToken?: string | null;
  contactName?: string | null;
  address?: string | null;
  status?: string | null;
  quotedTotalCents?: number | null;
  finalTotalCents?: number | null;
  soldByMemberId?: string | null;
  assignedSalespersonMemberId?: string | null;
  version?: string | null;
  quotedScopeText?: string | null;
  mediaSummary?: AppointmentMediaSummary;
  paymentSummary?: AppointmentPaymentSummary;
  paymentLedgerAvailable?: boolean;
  bookingDetails?: AppointmentBookingDetails | null;
  notes?: Array<{ id: string; body: string; createdAt: string }>;
  crewMemberIds?: string[];
  crewNames?: string[];
  eta?: {
    status: string | null;
    eventType: string | null;
    eventSource: string | null;
    eventAt: string | null;
    locationFreshness: string;
    pendingDraft: {
      id: string;
      reason: string;
      body: string;
      confidence: string;
      createdAt: string;
    } | null;
  };
};

const DEFAULT_DAYS_FORWARD = 30;
const DEFAULT_DAYS_BACK = 1;
const MAX_RANGE_DAYS = 366;

function googleAllDayBoundary(date: string | undefined): string | null {
  if (!date) return null;
  const resolved = resolveEasternDayBoundary(date);
  return resolved.ok ? resolved.value.toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExternalGoogleEvents(value: unknown): CalendarEvent[] | null {
  const envelope = parseGoogleCalendarEventListResponse(value);
  if (!envelope) return null;

  const events: CalendarEvent[] = [];
  for (const rawItem of envelope.items) {
    if (!isRecord(rawItem)) return null;
    const id = typeof rawItem["id"] === "string" ? rawItem["id"].trim() : "";
    const status = rawItem["status"];
    const summary = rawItem["summary"];
    if (
      !id ||
      (status !== undefined && typeof status !== "string") ||
      (summary !== undefined && typeof summary !== "string")
    ) {
      return null;
    }
    if (status === "cancelled") continue;

    const start = isRecord(rawItem["start"]) ? rawItem["start"] : null;
    const end = isRecord(rawItem["end"]) ? rawItem["end"] : null;
    if (!start || !end) return null;
    const startDateTime =
      typeof start["dateTime"] === "string" ? start["dateTime"] : undefined;
    const startDate =
      typeof start["date"] === "string" ? start["date"] : undefined;
    const endDateTime =
      typeof end["dateTime"] === "string" ? end["dateTime"] : undefined;
    const endDate = typeof end["date"] === "string" ? end["date"] : undefined;
    const startIso = startDateTime ?? googleAllDayBoundary(startDate);
    const endIso = endDateTime ?? googleAllDayBoundary(endDate);
    const startAt = startIso ? new Date(startIso) : null;
    const endAt = endIso ? new Date(endIso) : null;
    if (
      !startAt ||
      !endAt ||
      Number.isNaN(startAt.getTime()) ||
      Number.isNaN(endAt.getTime()) ||
      endAt <= startAt
    ) {
      return null;
    }
    events.push({
      id: `google:${id}`,
      title: typeof summary === "string" ? summary : "Calendar event",
      source: "google",
      start: startAt.toISOString(),
      end: endAt.toISOString(),
      status: typeof status === "string" ? status : null,
    });
  }
  return events;
}

function fallbackPaymentSummary(
  finalTotalCents: number | null,
): AppointmentPaymentSummary {
  return {
    status: "unknown",
    jobTotalCents: finalTotalCents,
    paidTowardJobCents: 0,
    tipCents: 0,
    refundedCents: 0,
    balanceCents: null,
    activeAttemptId: null,
    latestReceiptUrl: null,
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      {
        ok: false,
        appointments: [],
        externalEvents: [],
        conflicts: [],
        error: "unauthorized",
      },
      { status: 401 },
    );
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;
  const canReadPayments =
    (await requirePermission(request, "payments.read")) === null;
  const paymentLedgerAvailable =
    canReadPayments && (await isPaymentLedgerSchemaAvailable());

  const { windowStart, windowEnd } = getWindow(request);

  const db = getDb();
  const dbRows = await db
    .select({
      id: appointments.id,
      contactId: appointments.contactId,
      type: appointments.type,
      status: appointments.status,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      rescheduleToken: appointments.rescheduleToken,
      quotedTotalCents: appointments.quotedTotalCents,
      finalTotalCents: appointments.finalTotalCents,
      soldByMemberId: appointments.soldByMemberId,
      crew: appointments.crew,
      updatedAt: appointments.updatedAt,
      quotedScopeText: appointments.quotedScopeText,
      bookingDetails: appointments.bookingDetails,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      assignedSalespersonMemberId: contacts.salespersonMemberId,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .where(
      and(
        gte(appointments.startAt, windowStart),
        lt(appointments.startAt, windowEnd),
      ),
    );

  const contactIds = Array.from(
    new Set(
      dbRows
        .map((row) => row.contactId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const appointmentIds = dbRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const notesByAppointmentId = new Map<
    string,
    Array<{ id: string; body: string; createdAt: string }>
  >();
  const quotedScopeByAppointmentId = new Map(
    dbRows.map((row) => [row.id, row.quotedScopeText ?? null]),
  );
  const crewByAppointmentId = new Map<
    string,
    Array<{ memberId: string; name: string }>
  >();
  const [etaSummaryMap, mediaSummaryMap, paymentSummaryMap] = await Promise.all(
    [
      appointmentIds.length > 0
        ? getEtaSummariesForAppointments(appointmentIds)
        : Promise.resolve(new Map<string, EtaAppointmentSummary>()),
      getAppointmentMediaSummaryMap(appointmentIds, quotedScopeByAppointmentId),
      paymentLedgerAvailable
        ? getAppointmentPaymentSummaryMap(
            appointmentIds,
            new Map(dbRows.map((row) => [row.id, row.finalTotalCents ?? null])),
          )
        : Promise.resolve(new Map<string, AppointmentPaymentSummary>()),
    ],
  );
  if (appointmentIds.length) {
    const noteRows = await db
      .select({
        id: appointmentNotes.id,
        appointmentId: appointmentNotes.appointmentId,
        body: appointmentNotes.body,
        createdAt: appointmentNotes.createdAt,
      })
      .from(appointmentNotes)
      .where(inArray(appointmentNotes.appointmentId, appointmentIds))
      .orderBy(desc(appointmentNotes.createdAt));

    for (const row of noteRows) {
      const list = notesByAppointmentId.get(row.appointmentId) ?? [];
      list.push({
        id: `appointment:${row.id}`,
        body: row.body,
        createdAt: row.createdAt.toISOString(),
      });
      notesByAppointmentId.set(row.appointmentId, list);
    }

    const crewRows = await db
      .select({
        appointmentId: appointmentCrewMembers.appointmentId,
        memberId: appointmentCrewMembers.memberId,
        name: teamMembers.name,
      })
      .from(appointmentCrewMembers)
      .leftJoin(
        teamMembers,
        eq(appointmentCrewMembers.memberId, teamMembers.id),
      )
      .where(inArray(appointmentCrewMembers.appointmentId, appointmentIds));
    for (const row of crewRows) {
      const list = crewByAppointmentId.get(row.appointmentId) ?? [];
      list.push({
        memberId: row.memberId,
        name: row.name?.trim() || "Inactive crew member",
      });
      crewByAppointmentId.set(row.appointmentId, list);
    }
  }

  const notesByContactId = new Map<
    string,
    Array<{ id: string; body: string; createdAt: string }>
  >();
  if (contactIds.length) {
    const noteRows = await db
      .select({
        id: crmTasks.id,
        contactId: crmTasks.contactId,
        body: crmTasks.notes,
        createdAt: crmTasks.createdAt,
        status: crmTasks.status,
        dueAt: crmTasks.dueAt,
      })
      .from(crmTasks)
      .where(inArray(crmTasks.contactId, contactIds))
      .orderBy(desc(crmTasks.createdAt));

    for (const row of noteRows) {
      if (!row.contactId) continue;
      if (!row.body || row.body.trim().length === 0) continue;
      if (row.status !== "completed") continue;
      if (row.dueAt) continue;
      const list = notesByContactId.get(row.contactId) ?? [];
      list.push({
        id: `contact:${row.id}`,
        body: row.body,
        createdAt: row.createdAt.toISOString(),
      });
      notesByContactId.set(row.contactId, list);
    }
  }

  const appointmentsEvents: CalendarEvent[] = dbRows
    .filter((row) => row.startAt)
    .map((row) => {
      const start = row.startAt as Date;
      const end = new Date(
        start.getTime() + (row.durationMinutes ?? 60) * 60_000,
      );
      const contactName =
        row.contactFirstName && row.contactLastName
          ? `${row.contactFirstName} ${row.contactLastName}`.trim()
          : (row.contactFirstName ?? row.contactLastName ?? null);
      const addressParts = [
        row.addressLine1,
        row.city,
        row.state,
        row.postalCode,
      ]
        .filter((part) => typeof part === "string" && part.trim().length > 0)
        .join(", ");
      const notes = [
        ...(notesByAppointmentId.get(row.id) ?? []),
        ...(row.contactId ? (notesByContactId.get(row.contactId) ?? []) : []),
      ]
        .filter((note, index, all) => {
          const key = `${note.body.trim().toLowerCase()}|${note.createdAt}`;
          return (
            all.findIndex(
              (candidate) =>
                `${candidate.body.trim().toLowerCase()}|${candidate.createdAt}` ===
                key,
            ) === index
          );
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const crew = crewByAppointmentId.get(row.id) ?? [];
      const crewNames = Array.from(
        new Set([
          ...crew.map((member) => member.name),
          ...(row.crew ?? "")
            .split(/,|&/u)
            .map((name) => name.trim())
            .filter(Boolean),
        ]),
      );
      return {
        id: `db:${row.id}`,
        appointmentId: row.id,
        appointmentType: row.type ?? null,
        rescheduleToken: row.rescheduleToken,
        title: contactName ?? "Appointment",
        source: "db",
        start: start.toISOString(),
        end: end.toISOString(),
        contactName,
        address: addressParts.length ? addressParts : null,
        status: row.status ?? null,
        quotedTotalCents: row.quotedTotalCents ?? null,
        soldByMemberId: row.soldByMemberId ?? null,
        assignedSalespersonMemberId: row.assignedSalespersonMemberId ?? null,
        version: row.updatedAt.toISOString(),
        quotedScopeText: row.quotedScopeText ?? null,
        mediaSummary: mediaSummaryMap.get(row.id) ?? {
          readyCount: 0,
          pendingCount: 0,
          coverMediaId: null,
          needsScope: false,
        },
        ...(canReadPayments
          ? {
              finalTotalCents: row.finalTotalCents ?? null,
              paymentLedgerAvailable,
              paymentSummary: paymentLedgerAvailable
                ? (paymentSummaryMap.get(row.id) ??
                  fallbackPaymentSummary(row.finalTotalCents ?? null))
                : fallbackPaymentSummary(row.finalTotalCents ?? null),
            }
          : {}),
        bookingDetails: parseAppointmentBookingDetails(row.bookingDetails),
        eta: etaSummaryMap.get(row.id) ?? {
          status: null,
          eventType: null,
          eventSource: null,
          eventAt: null,
          locationFreshness: "missing",
          pendingDraft: null,
        },
        notes,
        crewMemberIds: crew.map((member) => member.memberId),
        crewNames,
      };
    });

  const externalEvents: CalendarEvent[] = [];
  let googleCalendarState: "disabled" | "loaded" | "unavailable" = "disabled";
  if (isGoogleCalendarEnabled()) {
    googleCalendarState = "unavailable";
    const config = getCalendarConfig();
    if (config) {
      const token = await getAccessToken(config);
      if (token) {
        const params = new URLSearchParams({
          timeMin: windowStart.toISOString(),
          timeMax: windowEnd.toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          showDeleted: "false",
        });
        const res = await (async () => {
          try {
            const url = resolveGoogleCalendarApiEndpoint(
              { kind: "events", calendarId: config.calendarId },
              process.env,
              params,
            );
            return await fetch(url, {
              headers: {
                Authorization: `Bearer ${token}`,
              },
              signal: AbortSignal.timeout(5_000),
            });
          } catch {
            return null;
          }
        })();
        if (res?.ok) {
          const parsedEvents = parseExternalGoogleEvents(
            await res.json().catch(() => null),
          );
          if (parsedEvents) {
            googleCalendarState = "loaded";
            externalEvents.push(...parsedEvents);
          }
        } else if (res) {
          await res.body?.cancel().catch(() => undefined);
        }
      }
    }
  }

  const allEvents: CalendarEvent[] = [...appointmentsEvents, ...externalEvents];

  const isBlockingForCapacity = (evt: CalendarEvent): boolean => {
    if (evt.source !== "db") return true;
    const status =
      typeof evt.status === "string" ? evt.status.trim().toLowerCase() : "";
    // Canceled/completed/no-show appointments should not consume capacity or be shown as conflicts.
    if (
      status === "canceled" ||
      status === "cancelled" ||
      status === "completed" ||
      status === "no_show"
    )
      return false;
    return true;
  };

  const conflicts = computeCapacityConflicts(
    allEvents.filter(isBlockingForCapacity),
    getAppointmentCapacity(),
  );

  return NextResponse.json({
    ok: true,
    appointments: appointmentsEvents,
    externalEvents,
    conflicts,
    googleCalendarState,
  });
}

function getWindow(request: NextRequest): {
  windowStart: Date;
  windowEnd: Date;
} {
  const now = new Date();
  const defaultStart = new Date(
    now.getTime() - DEFAULT_DAYS_BACK * 24 * 60 * 60 * 1000,
  );
  const defaultEnd = new Date(
    now.getTime() + DEFAULT_DAYS_FORWARD * 24 * 60 * 60 * 1000,
  );

  let url: URL | null = null;
  try {
    url = new URL(request.url);
  } catch {
    return { windowStart: defaultStart, windowEnd: defaultEnd };
  }

  const startRaw = url.searchParams.get("start");
  const endRaw = url.searchParams.get("end");
  if (!startRaw || !endRaw)
    return { windowStart: defaultStart, windowEnd: defaultEnd };

  const parsedStart = new Date(startRaw);
  const parsedEnd = new Date(endRaw);
  if (
    Number.isNaN(parsedStart.getTime()) ||
    Number.isNaN(parsedEnd.getTime())
  ) {
    return { windowStart: defaultStart, windowEnd: defaultEnd };
  }

  if (parsedEnd <= parsedStart)
    return { windowStart: defaultStart, windowEnd: defaultEnd };

  const diffDays =
    (parsedEnd.getTime() - parsedStart.getTime()) / (24 * 60 * 60 * 1000);
  if (
    !Number.isFinite(diffDays) ||
    diffDays <= 0 ||
    diffDays > MAX_RANGE_DAYS
  ) {
    return { windowStart: defaultStart, windowEnd: defaultEnd };
  }

  return { windowStart: parsedStart, windowEnd: parsedEnd };
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
  rawCapacity: number,
): Array<{ a: string; b: string }> {
  const capacity =
    typeof rawCapacity === "number" &&
    Number.isFinite(rawCapacity) &&
    rawCapacity > 0
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
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      continue;
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
