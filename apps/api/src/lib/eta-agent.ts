import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { DateTime } from "luxon";
import {
  appointmentEtaEvents,
  appointments,
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  crewLocationPings,
  crewRouteStates,
  crewTrackingDevices,
  etaMessageDrafts,
  getDb,
  outboxEvents,
  properties,
  type DatabaseClient,
} from "@/db";
import type { AuditActor } from "@/lib/audit";
import { recordAuditEvent } from "@/lib/audit";
import { sendSmsMessage } from "@/lib/messaging";
import { recordProviderFailure, recordProviderSuccess } from "@/lib/provider-health";

export const CREW_ETA_STATUSES = [
  "heading_there",
  "on_site",
  "need_dump",
  "dumping",
  "dump_complete",
  "finished",
  "running_behind",
] as const;

export type CrewEtaStatus = (typeof CREW_ETA_STATUSES)[number];
export type EtaLocationFreshness = "fresh" | "stale" | "missing" | "fallback";
export type EtaConfidence = "high" | "medium" | "low";
export type EtaAppointmentSummary = {
  status: string | null;
  eventType: string | null;
  eventSource: string | null;
  eventAt: string | null;
  locationFreshness: EtaLocationFreshness;
  pendingDraft: {
    id: string;
    reason: string;
    body: string;
    confidence: string;
    createdAt: string;
  } | null;
};

const TEAM_TIME_ZONE = "America/New_York";

type AppointmentEtaContext = {
  appointmentId: string;
  contactId: string;
  contactName: string;
  contactPhone: string | null;
  propertyLat: number | null;
  propertyLng: number | null;
  address: string | null;
  startAt: Date | null;
  durationMinutes: number;
  travelBufferMinutes: number;
  crewLabel: string | null;
  teamMemberId: string | null;
};

type LatestLocation = {
  pingId: string | null;
  lat: number | null;
  lng: number | null;
  fixAt: Date | null;
  freshness: EtaLocationFreshness;
};

type EtaDraftComputation = {
  body: string;
  reason: string;
  etaStartAt: Date | null;
  etaEndAt: Date | null;
  confidence: EtaConfidence;
  locationFreshness: EtaLocationFreshness;
};

type TraccarPosition = {
  id?: number | string;
  deviceId?: number | string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  speed?: number;
  fixTime?: string;
  deviceTime?: string;
  serverTime?: string;
  attributes?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getFreshness(fixAt: Date | null, now = new Date()): EtaLocationFreshness {
  if (!fixAt) return "missing";
  const thresholdMinutes = Number(process.env["TRACCAR_LOCATION_FRESHNESS_MINUTES"] ?? 10);
  const thresholdMs =
    Number.isFinite(thresholdMinutes) && thresholdMinutes > 0
      ? thresholdMinutes * 60_000
      : 10 * 60_000;
  return now.getTime() - fixAt.getTime() <= thresholdMs ? "fresh" : "stale";
}

function formatTeamDayKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function getTeamDayRange(date: Date): { start: Date; end: Date; key: string } {
  const key = formatTeamDayKey(date);
  const start = DateTime.fromISO(key, { zone: TEAM_TIME_ZONE }).startOf("day").toJSDate();
  const end = DateTime.fromISO(key, { zone: TEAM_TIME_ZONE }).plus({ days: 1 }).startOf("day").toJSDate();
  return { start, end, key };
}

function formatEtaTime(date: Date | null): string {
  if (!date) return "as soon as possible";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function firstName(name: string): string {
  const cleaned = name.trim();
  return cleaned ? (cleaned.split(/\s+/)[0] ?? "there") : "there";
}

function buildAddress(row: {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}): string | null {
  const parts = [row.addressLine1, row.city, row.state, row.postalCode]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());
  return parts.length ? parts.join(", ") : null;
}

function normalizeCrewEtaStatus(value: string): CrewEtaStatus | null {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((CREW_ETA_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as CrewEtaStatus;
  }
  return null;
}

export function parseCrewEtaText(body: string): {
  status: CrewEtaStatus | null;
  ambiguous: boolean;
} {
  const text = body.trim().toLowerCase();
  if (!text) return { status: null, ambiguous: true };
  if (/\b(need|needs|dump|landfill|transfer)\b/.test(text) && /\bdump(ing)?\b|\blandfill\b|\btransfer\b/.test(text)) {
    if (/\b(done|complete|finished)\b/.test(text)) return { status: "dump_complete", ambiguous: false };
    return { status: "need_dump", ambiguous: false };
  }
  if (/\bdump(ing)?\b/.test(text)) return { status: "dumping", ambiguous: false };
  if (/\b(on\s*site|arrived|here)\b/.test(text)) return { status: "on_site", ambiguous: false };
  if (/\b(heading|headed|on\s*the\s*way|en\s*route|going)\b/.test(text)) {
    return { status: "heading_there", ambiguous: false };
  }
  if (/\b(done|finished|complete|completed)\b/.test(text)) return { status: "finished", ambiguous: false };
  if (/\b(late|behind|delayed|delay|running behind)\b/.test(text)) {
    return { status: "running_behind", ambiguous: false };
  }
  return { status: null, ambiguous: true };
}

async function getAppointmentContext(
  db: DatabaseClient,
  appointmentId: string,
): Promise<AppointmentEtaContext | null> {
  const [row] = await db
    .select({
      appointmentId: appointments.id,
      contactId: appointments.contactId,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      crew: appointments.crew,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      lat: properties.lat,
      lng: properties.lng,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
    })
    .from(appointments)
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (!row?.appointmentId || !row.contactId) return null;
  const contactName =
    [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ").trim() ||
    "Stonegate Customer";
  return {
    appointmentId: row.appointmentId,
    contactId: row.contactId,
    contactName,
    contactPhone: row.phoneE164 ?? row.phone ?? null,
    propertyLat: row.lat ? Number(row.lat) : null,
    propertyLng: row.lng ? Number(row.lng) : null,
    address: buildAddress(row),
    startAt: row.startAt ?? null,
    durationMinutes: row.durationMinutes ?? 60,
    travelBufferMinutes: row.travelBufferMinutes ?? 30,
    crewLabel: row.crew ?? null,
    teamMemberId: null,
  };
}

async function getLatestLocation(
  db: DatabaseClient,
  teamMemberId: string | null,
  crewLabel: string | null,
): Promise<LatestLocation> {
  const deviceConditions = [eq(crewTrackingDevices.active, true)];
  if (teamMemberId) {
    deviceConditions.push(eq(crewTrackingDevices.teamMemberId, teamMemberId));
  } else if (crewLabel) {
    deviceConditions.push(eq(crewTrackingDevices.crewLabel, crewLabel));
  } else {
    return { pingId: null, lat: null, lng: null, fixAt: null, freshness: "missing" };
  }

  const [row] = await db
    .select({
      pingId: crewLocationPings.id,
      lat: crewLocationPings.lat,
      lng: crewLocationPings.lng,
      fixAt: crewLocationPings.fixAt,
    })
    .from(crewTrackingDevices)
    .innerJoin(
      crewLocationPings,
      eq(crewLocationPings.trackingDeviceId, crewTrackingDevices.id),
    )
    .where(and(...deviceConditions))
    .orderBy(desc(crewLocationPings.fixAt))
    .limit(1);

  if (!row?.pingId) {
    return { pingId: null, lat: null, lng: null, fixAt: null, freshness: "missing" };
  }
  const freshness = getFreshness(row.fixAt);
  return {
    pingId: row.pingId,
    lat: row.lat,
    lng: row.lng,
    fixAt: row.fixAt,
    freshness,
  };
}

async function getRouteMinutes(input: {
  originLat: number | null;
  originLng: number | null;
  destLat: number | null;
  destLng: number | null;
  fallbackMinutes: number;
}): Promise<{ minutes: number; routed: boolean }> {
  if (
    input.originLat === null ||
    input.originLng === null ||
    input.destLat === null ||
    input.destLng === null
  ) {
    return { minutes: input.fallbackMinutes, routed: false };
  }
  const token = process.env["MAPBOX_ACCESS_TOKEN"] ?? process.env["NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN"];
  if (!token) return { minutes: input.fallbackMinutes, routed: false };
  const coords = `${input.originLng},${input.originLat};${input.destLng},${input.destLat}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}?overview=false&access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return { minutes: input.fallbackMinutes, routed: false };
    const payload = (await res.json().catch(() => null)) as {
      routes?: Array<{ duration?: number }>;
    } | null;
    const seconds = readNumber(payload?.routes?.[0]?.duration);
    if (!seconds || seconds <= 0) return { minutes: input.fallbackMinutes, routed: false };
    return { minutes: Math.max(1, Math.round(seconds / 60)), routed: true };
  } catch {
    return { minutes: input.fallbackMinutes, routed: false };
  }
}

async function computeDraft(
  context: AppointmentEtaContext,
  status: CrewEtaStatus,
  location: LatestLocation,
): Promise<EtaDraftComputation | null> {
  if (!["heading_there", "need_dump", "running_behind"].includes(status)) {
    return null;
  }
  const route = await getRouteMinutes({
    originLat: location.lat,
    originLng: location.lng,
    destLat: context.propertyLat,
    destLng: context.propertyLng,
    fallbackMinutes: context.travelBufferMinutes,
  });
  const now = new Date();
  const confidence: EtaConfidence =
    location.freshness === "fresh" && route.routed
      ? "high"
      : location.freshness === "fresh"
        ? "medium"
        : "low";
  const etaStartAt = location.freshness === "missing" ? context.startAt : new Date(now.getTime() + route.minutes * 60_000);
  const etaEndAt = etaStartAt ? new Date(etaStartAt.getTime() + 15 * 60_000) : null;
  const etaText =
    confidence === "low"
      ? context.startAt
        ? `around ${formatEtaTime(context.startAt)} based on the schedule`
        : "as soon as possible"
      : `around ${formatEtaTime(etaStartAt)}`;
  const name = firstName(context.contactName);

  if (status === "need_dump") {
    return {
      reason: "dump_needed",
      body: `Hi ${name}, Stonegate update: the crew needs to dump before your stop. Current ETA is ${etaText}. We will keep you updated if that changes.`,
      etaStartAt,
      etaEndAt,
      confidence,
      locationFreshness: location.freshness,
    };
  }
  if (status === "running_behind") {
    return {
      reason: "running_behind",
      body: `Hi ${name}, Stonegate update: the crew is running behind today. Current ETA is ${etaText}. We will keep you updated if anything changes.`,
      etaStartAt,
      etaEndAt,
      confidence,
      locationFreshness: location.freshness,
    };
  }
  return {
    reason: "crew_on_the_way",
    body: `Hi ${name}, Stonegate update: the crew is on the way. Current ETA is ${etaText}.`,
    etaStartAt,
    etaEndAt,
    confidence,
    locationFreshness: location.freshness,
  };
}

async function ensureEtaThread(
  db: DatabaseClient,
  contactId: string,
): Promise<{ threadId: string; channel: string } | null> {
  const [existing] = await db
    .select({ id: conversationThreads.id, channel: conversationThreads.channel })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.contactId, contactId),
        inArray(conversationThreads.channel, ["dm", "sms"]),
        or(
          eq(conversationThreads.status, "open"),
          eq(conversationThreads.status, "pending"),
          eq(conversationThreads.status, "closed"),
        ),
      ),
    )
    .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
    .limit(1);
  if (existing?.id) return { threadId: existing.id, channel: existing.channel };

  const [contact] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      salespersonMemberId: contacts.salespersonMemberId,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!contact?.id || !(contact.phoneE164 ?? contact.phone)) return null;

  const now = new Date();
  const [thread] = await db
    .insert(conversationThreads)
    .values({
      contactId,
      channel: "sms",
      status: "open",
      state: "new",
      assignedTo: contact.salespersonMemberId ?? null,
      stateUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: conversationThreads.id });
  if (!thread?.id) return null;

  await db.insert(conversationParticipants).values({
    threadId: thread.id,
    participantType: "contact",
    contactId,
    externalAddress: contact.phoneE164 ?? contact.phone,
    displayName:
      [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() ||
      "Contact",
    createdAt: now,
  });

  return { threadId: thread.id, channel: "sms" };
}

async function createDraftIfNeeded(input: {
  db: DatabaseClient;
  context: AppointmentEtaContext;
  status: CrewEtaStatus;
  location: LatestLocation;
  actorId?: string | null;
}): Promise<string | null> {
  const draft = await computeDraft(input.context, input.status, input.location);
  if (!draft) return null;
  const [existing] = await input.db
    .select({ id: etaMessageDrafts.id, body: etaMessageDrafts.body })
    .from(etaMessageDrafts)
    .where(
      and(
        eq(etaMessageDrafts.appointmentId, input.context.appointmentId),
        eq(etaMessageDrafts.status, "draft"),
        eq(etaMessageDrafts.reason, draft.reason),
      ),
    )
    .orderBy(desc(etaMessageDrafts.createdAt))
    .limit(1);

  const thread = await ensureEtaThread(input.db, input.context.contactId);
  const now = new Date();
  if (existing?.id) {
    await input.db
      .update(etaMessageDrafts)
      .set({
        body: draft.body,
        threadId: thread?.threadId ?? null,
        channel: thread?.channel ?? "sms",
        etaStartAt: draft.etaStartAt,
        etaEndAt: draft.etaEndAt,
        confidence: draft.confidence,
        locationFreshness: draft.locationFreshness,
        updatedAt: now,
      })
      .where(eq(etaMessageDrafts.id, existing.id));
    return existing.id;
  }

  const [created] = await input.db
    .insert(etaMessageDrafts)
      .values({
        appointmentId: input.context.appointmentId,
        contactId: input.context.contactId,
      threadId: thread?.threadId ?? null,
      channel: thread?.channel ?? "sms",
      status: "draft",
      reason: draft.reason,
      body: draft.body,
      etaStartAt: draft.etaStartAt,
      etaEndAt: draft.etaEndAt,
      confidence: draft.confidence,
      locationFreshness: draft.locationFreshness,
      createdBy: input.actorId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: etaMessageDrafts.id });
  return created?.id ?? null;
}

async function resolveNextAppointment(
  db: DatabaseClient,
  context: AppointmentEtaContext,
): Promise<string | null> {
  if (!context.startAt) return null;
  const day = getTeamDayRange(context.startAt);
  const conditions = [
    gte(appointments.startAt, day.start),
    lt(appointments.startAt, day.end),
    sql`${appointments.id} <> ${context.appointmentId}`,
    sql`${appointments.status} not in ('completed', 'canceled', 'no_show')`,
  ];
  if (context.crewLabel) {
    conditions.push(eq(appointments.crew, context.crewLabel));
  }
  const [next] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(...conditions))
    .orderBy(asc(appointments.startAt))
    .limit(1);
  return next?.id ?? null;
}

export async function updateCrewEtaStatus(input: {
  appointmentId: string;
  status: string;
  source: "crm" | "mobile" | "sms" | "system";
  note?: string | null;
  actor?: AuditActor;
}): Promise<{ ok: true; draftId: string | null; status: CrewEtaStatus } | { ok: false; error: string }> {
  const status = normalizeCrewEtaStatus(input.status);
  if (!status) return { ok: false, error: "invalid_eta_status" };

  const db = getDb();
  const context = await getAppointmentContext(db, input.appointmentId);
  if (!context) return { ok: false, error: "appointment_not_found" };

  const teamMemberId = input.actor?.id ?? context.teamMemberId ?? null;
  const location = await getLatestLocation(db, teamMemberId, context.crewLabel);
  const nextAppointmentId = await resolveNextAppointment(db, context);
  const serviceDate = formatTeamDayKey(context.startAt ?? new Date());
  const now = new Date();
  const dumpStatus =
    status === "need_dump"
      ? "needed"
      : status === "dumping"
        ? "dumping"
        : status === "dump_complete"
          ? "complete"
          : undefined;

  await db.transaction(async (tx) => {
    await tx.insert(appointmentEtaEvents).values({
      appointmentId: input.appointmentId,
      teamMemberId,
      crewLabel: context.crewLabel,
      eventType: status,
      source: input.source,
      note: input.note ?? null,
      meta: {
        locationFreshness: location.freshness,
        locationPingId: location.pingId,
        nextAppointmentId,
      },
      createdAt: now,
    });

    const [existingState] = await tx
      .select({ id: crewRouteStates.id })
      .from(crewRouteStates)
      .where(
        and(
          eq(crewRouteStates.serviceDate, serviceDate),
          teamMemberId
            ? eq(crewRouteStates.teamMemberId, teamMemberId)
            : context.crewLabel
              ? eq(crewRouteStates.crewLabel, context.crewLabel)
              : eq(crewRouteStates.currentAppointmentId, input.appointmentId),
        ),
      )
      .orderBy(desc(crewRouteStates.updatedAt))
      .limit(1);

    const values = {
      teamMemberId,
      crewLabel: context.crewLabel,
      serviceDate,
      currentAppointmentId: input.appointmentId,
      nextAppointmentId,
      status,
      ...(dumpStatus ? { dumpStatus } : {}),
      locationFreshness: location.freshness,
      lastLocationPingId: location.pingId,
      statusNote: input.note ?? null,
      updatedAt: now,
    };

    if (existingState?.id) {
      await tx
        .update(crewRouteStates)
        .set(values)
        .where(eq(crewRouteStates.id, existingState.id));
    } else {
      await tx.insert(crewRouteStates).values({
        ...values,
        dumpStatus: dumpStatus ?? "not_needed",
        createdAt: now,
      });
    }
  });

  const draftId = await createDraftIfNeeded({
    db,
    context,
    status,
    location,
    actorId: input.actor?.id ?? null,
  });

  await recordAuditEvent({
    actor: input.actor ?? { type: "system", label: "eta-agent" },
    action: "eta.status_updated",
    entityType: "appointment",
    entityId: input.appointmentId,
    meta: { status, source: input.source, draftId },
  });

  return { ok: true, draftId, status };
}

export async function getEtaSummariesForAppointments(
  appointmentIds: string[],
): Promise<Map<string, EtaAppointmentSummary>> {
  const result = new Map<string, EtaAppointmentSummary>();
  const ids = Array.from(new Set(appointmentIds.filter(Boolean)));
  if (!ids.length) return result;
  const db = getDb();

  const eventRows = await db
    .select({
      appointmentId: appointmentEtaEvents.appointmentId,
      eventType: appointmentEtaEvents.eventType,
      source: appointmentEtaEvents.source,
      createdAt: appointmentEtaEvents.createdAt,
      meta: appointmentEtaEvents.meta,
    })
    .from(appointmentEtaEvents)
    .where(inArray(appointmentEtaEvents.appointmentId, ids))
    .orderBy(desc(appointmentEtaEvents.createdAt));

  for (const row of eventRows) {
    if (result.has(row.appointmentId)) continue;
    const meta = isRecord(row.meta) ? row.meta : {};
    const freshness = readString(meta["locationFreshness"]) as EtaLocationFreshness | null;
    result.set(row.appointmentId, {
      status: row.eventType,
      eventType: row.eventType,
      eventSource: row.source,
      eventAt: row.createdAt.toISOString(),
      locationFreshness: freshness ?? "missing",
      pendingDraft: null,
    });
  }

  const draftRows = await db
    .select({
      id: etaMessageDrafts.id,
      appointmentId: etaMessageDrafts.appointmentId,
      reason: etaMessageDrafts.reason,
      body: etaMessageDrafts.body,
      confidence: etaMessageDrafts.confidence,
      locationFreshness: etaMessageDrafts.locationFreshness,
      createdAt: etaMessageDrafts.createdAt,
    })
    .from(etaMessageDrafts)
    .where(and(inArray(etaMessageDrafts.appointmentId, ids), eq(etaMessageDrafts.status, "draft")))
    .orderBy(desc(etaMessageDrafts.createdAt));

  for (const row of draftRows) {
    const existing: EtaAppointmentSummary = result.get(row.appointmentId) ?? {
      status: null,
      eventType: null,
      eventSource: null,
      eventAt: null,
      locationFreshness: (row.locationFreshness as EtaLocationFreshness | null) ?? "missing",
      pendingDraft: null,
    };
    if (!existing.pendingDraft) {
      existing.pendingDraft = {
        id: row.id,
        reason: row.reason,
        body: row.body,
        confidence: row.confidence,
        createdAt: row.createdAt.toISOString(),
      };
    }
    result.set(row.appointmentId, existing);
  }

  return result;
}

export async function listEtaDrafts(status = "draft", limit = 25) {
  const db = getDb();
  const rows = await db
    .select({
      id: etaMessageDrafts.id,
      appointmentId: etaMessageDrafts.appointmentId,
      contactId: etaMessageDrafts.contactId,
      threadId: etaMessageDrafts.threadId,
      status: etaMessageDrafts.status,
      reason: etaMessageDrafts.reason,
      body: etaMessageDrafts.body,
      confidence: etaMessageDrafts.confidence,
      locationFreshness: etaMessageDrafts.locationFreshness,
      etaStartAt: etaMessageDrafts.etaStartAt,
      etaEndAt: etaMessageDrafts.etaEndAt,
      createdAt: etaMessageDrafts.createdAt,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      startAt: appointments.startAt,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
    })
    .from(etaMessageDrafts)
    .leftJoin(appointments, eq(etaMessageDrafts.appointmentId, appointments.id))
    .leftJoin(contacts, eq(etaMessageDrafts.contactId, contacts.id))
    .leftJoin(properties, eq(appointments.propertyId, properties.id))
    .where(eq(etaMessageDrafts.status, status))
    .orderBy(desc(etaMessageDrafts.createdAt))
    .limit(Math.max(1, Math.min(100, Math.floor(limit))));

  return rows.map((row) => ({
    id: row.id,
    appointmentId: row.appointmentId,
    contactId: row.contactId,
    threadId: row.threadId,
    status: row.status,
    reason: row.reason,
    body: row.body,
    confidence: row.confidence,
    locationFreshness: row.locationFreshness,
    etaStartAt: row.etaStartAt?.toISOString() ?? null,
    etaEndAt: row.etaEndAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    customerName:
      [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ").trim() ||
      "Customer",
    appointmentStartAt: row.startAt?.toISOString() ?? null,
    address: buildAddress(row),
  }));
}

export async function sendEtaDraft(input: {
  draftId: string;
  actor?: AuditActor;
}): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const db = getDb();
  const [draft] = await db
    .select({
      id: etaMessageDrafts.id,
      appointmentId: etaMessageDrafts.appointmentId,
      contactId: etaMessageDrafts.contactId,
      threadId: etaMessageDrafts.threadId,
      channel: etaMessageDrafts.channel,
      body: etaMessageDrafts.body,
      status: etaMessageDrafts.status,
    })
    .from(etaMessageDrafts)
    .where(eq(etaMessageDrafts.id, input.draftId))
    .limit(1);
  if (!draft?.id) return { ok: false, error: "draft_not_found" };
  if (draft.status !== "draft") return { ok: false, error: "draft_not_open" };
  if (!draft.contactId) return { ok: false, error: "contact_missing" };

  const ensuredThread = draft.threadId
    ? { threadId: draft.threadId, channel: draft.channel }
    : await ensureEtaThread(db, draft.contactId);
  if (!ensuredThread?.threadId) return { ok: false, error: "thread_missing" };
  const threadId = ensuredThread.threadId;

  const now = new Date();
  const [thread] = await db
    .select({
      channel: conversationThreads.channel,
      contactId: conversationThreads.contactId,
      doNotContact: contacts.doNotContact,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      email: contacts.email,
    })
    .from(conversationThreads)
    .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
    .where(eq(conversationThreads.id, threadId))
    .limit(1);
  if (!thread) return { ok: false, error: "thread_not_found" };
  if (thread.doNotContact) return { ok: false, error: "dnc_confirmation_required" };

  let toAddress =
    thread.channel === "email"
      ? thread.email
      : thread.channel === "dm"
        ? null
        : thread.phoneE164 ?? thread.phone;
  let metadata: Record<string, unknown> = {
    etaDraftId: draft.id,
    etaAppointmentId: draft.appointmentId,
    source: "eta_agent",
  };
  if (thread.channel === "dm") {
    const [lastInboundDm] = await db
      .select({
        fromAddress: conversationMessages.fromAddress,
        metadata: conversationMessages.metadata,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.threadId, threadId),
          eq(conversationMessages.direction, "inbound"),
          eq(conversationMessages.channel, "dm"),
        ),
      )
      .orderBy(desc(conversationMessages.createdAt))
      .limit(1);
    toAddress = lastInboundDm?.fromAddress ?? null;
    metadata = {
      ...(isRecord(lastInboundDm?.metadata) ? lastInboundDm.metadata : { source: "facebook" }),
      ...metadata,
    };
  }
  if (!toAddress) return { ok: false, error: "missing_recipient" };

  const [participant] = await db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        eq(conversationParticipants.participantType, "team"),
        input.actor?.id
          ? eq(conversationParticipants.teamMemberId, input.actor.id)
          : isNull(conversationParticipants.teamMemberId),
      ),
    )
    .limit(1);
  const participantId =
    participant?.id ??
    (
      await db
        .insert(conversationParticipants)
        .values({
          threadId,
          participantType: "team",
          teamMemberId: input.actor?.id ?? null,
          displayName: input.actor?.label ?? "ETA Agent",
          createdAt: now,
        })
        .returning({ id: conversationParticipants.id })
    )[0]?.id ??
    null;

  const [message] = await db
    .insert(conversationMessages)
    .values({
      threadId,
      participantId,
      direction: "outbound",
      channel: thread.channel,
      body: draft.body,
      toAddress,
      deliveryStatus: "queued",
      metadata,
      createdAt: now,
    })
    .returning({ id: conversationMessages.id });
  if (!message?.id) return { ok: false, error: "message_create_failed" };

  await db
    .update(conversationThreads)
    .set({
      lastMessagePreview: draft.body.slice(0, 140),
      lastMessageAt: now,
      updatedAt: now,
    })
    .where(eq(conversationThreads.id, threadId));
  await db.insert(outboxEvents).values({
    type: "message.send",
    payload: { messageId: message.id },
    createdAt: now,
  });
  await db
    .update(etaMessageDrafts)
    .set({
      status: "sent",
      threadId,
      sentBy: input.actor?.id ?? null,
      sentAt: now,
      updatedAt: now,
    })
    .where(eq(etaMessageDrafts.id, draft.id));
  await recordAuditEvent({
    actor: input.actor ?? { type: "system", label: "eta-agent" },
    action: "eta.draft_sent",
    entityType: "eta_message_draft",
    entityId: draft.id,
    meta: { appointmentId: draft.appointmentId, messageId: message.id },
  });
  return { ok: true, messageId: message.id };
}

export async function dismissEtaDraft(input: {
  draftId: string;
  actor?: AuditActor;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const now = new Date();
  const [updated] = await db
    .update(etaMessageDrafts)
    .set({
      status: "dismissed",
      dismissedAt: now,
      updatedAt: now,
    })
    .where(and(eq(etaMessageDrafts.id, input.draftId), eq(etaMessageDrafts.status, "draft")))
    .returning({ id: etaMessageDrafts.id, appointmentId: etaMessageDrafts.appointmentId });
  if (!updated?.id) return { ok: false, error: "draft_not_found" };
  await recordAuditEvent({
    actor: input.actor ?? { type: "system", label: "eta-agent" },
    action: "eta.draft_dismissed",
    entityType: "eta_message_draft",
    entityId: updated.id,
    meta: { appointmentId: updated.appointmentId },
  });
  return { ok: true };
}

export async function syncTraccarPositions(): Promise<{
  ok: boolean;
  configured: boolean;
  devices: number;
  positions: number;
  stored: number;
  error?: string;
}> {
  const baseUrl = readString(process.env["TRACCAR_BASE_URL"]);
  const token = readString(process.env["TRACCAR_API_TOKEN"]);
  if (!baseUrl || !token) {
    return { ok: true, configured: false, devices: 0, positions: 0, stored: 0 };
  }

  const db = getDb();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/positions`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      await recordProviderFailure("traccar", `positions_http_${res.status}`);
      return {
        ok: false,
        configured: true,
        devices: 0,
        positions: 0,
        stored: 0,
        error: `positions_http_${res.status}`,
      };
    }

    const payload = (await res.json().catch(() => null)) as unknown;
    const positions = Array.isArray(payload) ? (payload as TraccarPosition[]) : [];
    const deviceRows = await db
      .select({
        id: crewTrackingDevices.id,
        providerDeviceId: crewTrackingDevices.providerDeviceId,
      })
      .from(crewTrackingDevices)
      .where(and(eq(crewTrackingDevices.provider, "traccar"), eq(crewTrackingDevices.active, true)));
    const deviceByProviderId = new Map(deviceRows.map((row) => [row.providerDeviceId, row.id]));
    let stored = 0;
    const now = new Date();

    for (const position of positions) {
      const providerDeviceId = position.deviceId === undefined ? null : String(position.deviceId);
      if (!providerDeviceId) continue;
      const trackingDeviceId = deviceByProviderId.get(providerDeviceId);
      if (!trackingDeviceId) continue;
      const lat = readNumber(position.latitude);
      const lng = readNumber(position.longitude);
      if (lat === null || lng === null) continue;
      const fixAt =
        toDate(position.fixTime) ??
        toDate(position.deviceTime) ??
        toDate(position.serverTime) ??
        now;
      const providerPositionId = position.id === undefined ? null : String(position.id);
      const [existing] = providerPositionId
        ? await db
            .select({ id: crewLocationPings.id })
            .from(crewLocationPings)
            .where(
              and(
                eq(crewLocationPings.trackingDeviceId, trackingDeviceId),
                eq(crewLocationPings.providerPositionId, providerPositionId),
              ),
            )
            .limit(1)
        : [];
      if (existing?.id) continue;
      await db.insert(crewLocationPings).values({
        trackingDeviceId,
        provider: "traccar",
        providerPositionId,
        lat,
        lng,
        accuracyMeters: readNumber(position.accuracy),
        speedKph: readNumber(position.speed),
        fixAt,
        receivedAt: now,
        freshness: getFreshness(fixAt, now),
        raw: isRecord(position) ? position : null,
      });
      stored += 1;
    }

    await recordProviderSuccess("traccar");
    return {
      ok: true,
      configured: true,
      devices: deviceRows.length,
      positions: positions.length,
      stored,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "traccar_sync_failed";
    await recordProviderFailure("traccar", message);
    return {
      ok: false,
      configured: true,
      devices: 0,
      positions: 0,
      stored: 0,
      error: message,
    };
  }
}

async function findCurrentCrewAppointment(memberId: string): Promise<string | null> {
  const db = getDb();
  const day = getTeamDayRange(new Date());
  const [state] = await db
    .select({ currentAppointmentId: crewRouteStates.currentAppointmentId })
    .from(crewRouteStates)
    .where(and(eq(crewRouteStates.teamMemberId, memberId), eq(crewRouteStates.serviceDate, day.key)))
    .orderBy(desc(crewRouteStates.updatedAt))
    .limit(1);
  if (state?.currentAppointmentId) return state.currentAppointmentId;

  const [device] = await db
    .select({ crewLabel: crewTrackingDevices.crewLabel })
    .from(crewTrackingDevices)
    .where(
      and(
        eq(crewTrackingDevices.teamMemberId, memberId),
        eq(crewTrackingDevices.active, true),
      ),
    )
    .orderBy(desc(crewTrackingDevices.updatedAt))
    .limit(1);
  const crewLabel = device?.crewLabel?.trim() || null;

  const [appt] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        gte(appointments.startAt, day.start),
        lt(appointments.startAt, day.end),
        sql`${appointments.status} not in ('completed', 'canceled', 'no_show')`,
        crewLabel ? eq(appointments.crew, crewLabel) : sql`true`,
      ),
    )
    .orderBy(asc(appointments.startAt))
    .limit(1);
  return appt?.id ?? null;
}

export async function handleCrewEtaSms(input: {
  teamMember: { id: string; name: string; phoneE164: string | null };
  body: string;
  fromAddress: string;
}): Promise<{ handled: true; status?: CrewEtaStatus; ambiguous?: boolean; appointmentId?: string | null }> {
  const parsed = parseCrewEtaText(input.body);
  if (parsed.ambiguous || !parsed.status) {
    await sendSmsMessage(
      input.fromAddress,
      "Stonegate ETA agent: I did not understand that update. Please reply with one of: heading, on site, done, need dump, dump complete, or running behind.",
    ).catch(() => null);
    return { handled: true, ambiguous: true };
  }

  const appointmentId = await findCurrentCrewAppointment(input.teamMember.id);
  if (!appointmentId) {
    await sendSmsMessage(
      input.fromAddress,
      "Stonegate ETA agent: I understood the update, but I could not find your current job for today.",
    ).catch(() => null);
    return { handled: true, status: parsed.status, appointmentId: null };
  }

  const result = await updateCrewEtaStatus({
    appointmentId,
    status: parsed.status,
    source: "sms",
    note: input.body,
    actor: {
      type: "human",
      id: input.teamMember.id,
      label: input.teamMember.name,
      role: "crew",
    },
  });

  if (result.ok) {
    await sendSmsMessage(
      input.fromAddress,
      `Stonegate ETA agent: saved "${parsed.status.replace(/_/g, " ")}" for your current job.`,
    ).catch(() => null);
  }

  return { handled: true, status: parsed.status, appointmentId };
}

export const __etaAgentTest = {
  computeDraft,
  getFreshness,
};
