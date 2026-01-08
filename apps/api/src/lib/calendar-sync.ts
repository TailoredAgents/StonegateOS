import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, appointments, calendarSyncState } from "@/db";
import type { DatabaseClient } from "@/db";
import type { CalendarConfig } from "./calendar";
import { getCalendarConfig, getAccessToken, isGoogleCalendarEnabled } from "./calendar";

const GOOGLE_API_BASE = "https://www.googleapis.com/calendar/v3";
const WATCH_RENEW_BUFFER_MS = 10 * 60 * 1000;
const WATCH_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SYNC_ITERATIONS = 20;
const DEFAULT_LOOKBACK_DAYS = (() => {
  const raw = Number.parseInt(process.env["GOOGLE_CALENDAR_SYNC_LOOKBACK_DAYS"] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 45;
})();

type CalendarSyncStateRow = typeof calendarSyncState.$inferSelect;

interface GoogleCalendarEvent {
  id: string;
  status?: string;
  start?: {
    dateTime?: string;
    date?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
  };
  updated?: string;
  summary?: string;
  description?: string;
  extendedProperties?: {
    private?: Record<string, string | undefined>;
  };
}

interface CalendarEventsListResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

interface FetchEventsOk {
  kind: "ok";
  items: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string | null;
}

interface FetchEventsReset {
  kind: "reset";
}

interface FetchEventsError {
  kind: "error";
  status: number;
  text: string;
}

type FetchEventsResult = FetchEventsOk | FetchEventsReset | FetchEventsError;

export interface SyncOptions {
  reason?: string;
  forceResync?: boolean;
  channelId?: string | null;
  resourceState?: string | null;
}

export interface CalendarSyncResult {
  ok: boolean;
  updated?: number;
  cancelled?: number;
  pages?: number;
  resets?: number;
  reason?: string;
  status?: number;
  details?: string;
  watchRegistered?: boolean;
}

export interface CalendarNotificationMetadata {
  channelId?: string | null;
  resourceId?: string | null;
  channelExpiration?: string | null;
}

let syncInFlight: Promise<CalendarSyncResult> | null = null;

export async function ensureCalendarWatch(): Promise<boolean> {
  if (!isGoogleCalendarEnabled()) {
    return false;
  }

  const config = getCalendarConfig();
  if (!config) {
    return false;
  }

  const db = getDb();
  const state = await getOrCreateState(db, config.calendarId);
  const accessToken = await getAccessToken(config);
  if (!accessToken) {
    console.warn("[calendar-sync] ensure_watch_failed", { reason: "token_error" });
    return false;
  }

  const result = await ensureWatchForState(db, config, state, accessToken);
  if (result.registered) {
    console.info("[calendar-sync] watch_registered", {
      calendarId: config.calendarId,
      channelId: result.state.channelId
    });
  }

  return result.registered;
}

export async function syncGoogleCalendar(options: SyncOptions = {}): Promise<CalendarSyncResult> {
  if (!isGoogleCalendarEnabled()) {
    return { ok: true, reason: "disabled" };
  }

  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = performSync(options).finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
}

export async function recordCalendarNotification(metadata: CalendarNotificationMetadata): Promise<void> {
  const config = getCalendarConfig();
  if (!config) {
    return;
  }

  const db = getDb();
  const state = await getOrCreateState(db, config.calendarId);

  if (state.channelId && metadata.channelId && state.channelId !== metadata.channelId) {
    console.warn("[calendar-sync] notification_channel_mismatch", {
      expected: state.channelId,
      received: metadata.channelId
    });
    return;
  }

  const updates: Partial<typeof calendarSyncState.$inferInsert> = {
    lastNotificationAt: new Date()
  };

  if (!state.channelId && metadata.channelId) {
    updates.channelId = metadata.channelId;
  }

  if (!state.resourceId && metadata.resourceId) {
    updates.resourceId = metadata.resourceId;
  }

  if (metadata.channelExpiration) {
    const expiry = Date.parse(metadata.channelExpiration);
    if (!Number.isNaN(expiry)) {
      updates.channelExpiresAt = new Date(expiry);
    }
  }

  await upsertState(db, config.calendarId, updates);
}

async function performSync(options: SyncOptions): Promise<CalendarSyncResult> {
  const config = getCalendarConfig();
  if (!config) {
    return { ok: true, reason: "disabled" };
  }

  const db = getDb();
  let state = await getOrCreateState(db, config.calendarId);
  const accessToken = await getAccessToken(config);

  if (!accessToken) {
    return { ok: false, reason: "token_error" };
  }

  const watchResult = await ensureWatchForState(db, config, state, accessToken);
  state = watchResult.state;

  let syncToken = options.forceResync ? null : state.syncToken;
  let nextSyncToken: string | null = syncToken ?? null;
  let pageToken: string | undefined;
  let pages = 0;
  let resets = 0;
  let updated = 0;
  let cancelled = 0;

  const timeMin = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  while (pages < MAX_SYNC_ITERATIONS) {
    const result = await fetchEventPage(config, accessToken, {
      syncToken,
      pageToken,
      timeMin: syncToken ? undefined : timeMin
    });

    if (result.kind === "reset") {
      syncToken = null;
      nextSyncToken = null;
      pageToken = undefined;
      resets += 1;
      console.info("[calendar-sync] sync_token_reset", { calendarId: config.calendarId, resets });
      if (resets > 1) {
        break;
      }
      continue;
    }

    if (result.kind === "error") {
      return {
        ok: false,
        reason: "google_error",
        status: result.status,
        details: result.text,
        pages,
        updated,
        cancelled,
        resets,
        watchRegistered: watchResult.registered
      };
    }

    if (result.items.length > 0) {
      const changes = await applyEventsToAppointments(db, result.items);
      updated += changes.updated;
      cancelled += changes.cancelled;
    }

    nextSyncToken = result.nextSyncToken ?? nextSyncToken ?? syncToken;
    pageToken = result.nextPageToken;
    pages += 1;

    if (!pageToken) {
      break;
    }
  }

  await upsertState(db, config.calendarId, {
    syncToken: nextSyncToken,
    lastSyncedAt: new Date(),
    channelId: state.channelId,
    resourceId: state.resourceId,
    channelExpiresAt: state.channelExpiresAt
  });

  return {
    ok: true,
    updated,
    cancelled,
    pages,
    resets,
    watchRegistered: watchResult.registered
  };
}

async function ensureWatchForState(
  db: DatabaseClient,
  config: CalendarConfig,
  state: CalendarSyncStateRow,
  accessToken?: string | null
): Promise<{ state: CalendarSyncStateRow; registered: boolean }> {
  const address = process.env["GOOGLE_CALENDAR_WEBHOOK_URL"];
  if (!address) {
    return { state, registered: false };
  }

  const now = Date.now();
  const expiry = state.channelExpiresAt?.getTime() ?? 0;

  if (state.channelId && expiry - now > WATCH_RENEW_BUFFER_MS) {
    return { state, registered: false };
  }

  const token = accessToken ?? (await getAccessToken(config));
  if (!token) {
    console.warn("[calendar-sync] ensure_watch_failed", { reason: "token_error" });
    return { state, registered: false };
  }

  const registration = await registerWatch(config, token, address);
  if (!registration) {
    return { state, registered: false };
  }

  await upsertState(db, config.calendarId, {
    channelId: registration.channelId,
    resourceId: registration.resourceId ?? state.resourceId ?? null,
    channelExpiresAt: registration.expiresAt ?? null
  });

  const refreshed = await getOrCreateState(db, config.calendarId);
  return { state: refreshed, registered: true };
}

async function registerWatch(
  config: CalendarConfig,
  accessToken: string,
  address: string
): Promise<{ channelId: string; resourceId: string | null; expiresAt: Date | null } | null> {
  const channelId = randomUUID();
  const response = await calendarFetch(config, accessToken, "events/watch", {
    method: "POST",
    body: JSON.stringify({
      id: channelId,
      type: "webhook",
      address,
      params: {
        ttl: WATCH_TTL_SECONDS.toString()
      }
    })
  });

  if (!response) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.warn("[calendar-sync] watch_registration_failed", {
      status: response.status,
      text
    });
    return null;
  }

  const data = (await response.json()) as { resourceId?: string; expiration?: string };
  const expirationMs = data.expiration ? Number.parseInt(data.expiration, 10) : undefined;

  return {
    channelId,
    resourceId: data.resourceId ?? null,
    expiresAt: Number.isFinite(expirationMs) ? new Date(expirationMs!) : null
  };
}

async function fetchEventPage(
  config: CalendarConfig,
  accessToken: string,
  options: { syncToken: string | null; pageToken?: string; timeMin?: string }
): Promise<FetchEventsResult> {
  const params = new URLSearchParams();
  params.set("maxResults", "250");
  params.set("showDeleted", "true");

  if (options.pageToken) {
    params.set("pageToken", options.pageToken);
  }

  if (options.syncToken) {
    params.set("syncToken", options.syncToken);
  } else {
    params.set("timeMin", options.timeMin ?? new Date().toISOString());
    params.set("singleEvents", "false");
    params.set("orderBy", "updated");
  }

  const response = await calendarFetch(config, accessToken, `events?${params.toString()}`, {
    method: "GET"
  });

  if (!response) {
    return { kind: "error", status: 503, text: "request_failed" };
  }

  if (response.status === 410) {
    return { kind: "reset" };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.warn("[calendar-sync] events_list_failed", { status: response.status, text });
    return { kind: "error", status: response.status, text };
  }

  const data = (await response.json()) as CalendarEventsListResponse;
  return {
    kind: "ok",
    items: Array.isArray(data.items) ? data.items : [],
    nextPageToken: data.nextPageToken ?? undefined,
    nextSyncToken: data.nextSyncToken ?? null
  };
}

async function applyEventsToAppointments(
  db: DatabaseClient,
  events: GoogleCalendarEvent[]
): Promise<{ updated: number; cancelled: number }> {
  const appointmentIds = Array.from(
    new Set(
      events
        .map(resolveAppointmentId)
        .filter((id): id is string => Boolean(id))
    )
  );

  if (appointmentIds.length === 0) {
    return { updated: 0, cancelled: 0 };
  }

  const rows = await db
    .select({
      id: appointments.id,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      status: appointments.status,
      calendarEventId: appointments.calendarEventId
    })
    .from(appointments)
    .where(inArray(appointments.id, appointmentIds));

  const map = new Map(rows.map((row) => [row.id, row]));

  let updated = 0;
  let cancelled = 0;

  for (const event of events) {
    const appointmentId = resolveAppointmentId(event);
    if (!appointmentId) {
      continue;
    }

    const existing = map.get(appointmentId);
    if (!existing) {
      continue;
    }

    if (event.status === "cancelled") {
      const updates: Partial<typeof appointments.$inferInsert> = {};
      if (existing.calendarEventId) {
        updates.calendarEventId = null;
      }
      if (existing.status !== "canceled") {
        updates.status = "canceled";
      }

      if (Object.keys(updates).length > 0) {
        await db.update(appointments).set(updates).where(eq(appointments.id, appointmentId));
        cancelled += 1;
      }

      continue;
    }

    const privateProps = event.extendedProperties?.private ?? {};
    const updates: Partial<typeof appointments.$inferInsert> = {};

    if (event.id && existing.calendarEventId !== event.id) {
      updates.calendarEventId = event.id;
    }

    const travelBufferRaw = privateProps["travelBufferMinutes"] ?? privateProps["travel_buffer_minutes"];
    let travelBuffer = parseInteger(travelBufferRaw);
    if (travelBuffer === null || travelBuffer < 0) {
      travelBuffer = existing.travelBufferMinutes ?? 0;
    }

    const startIso = event.start?.dateTime ?? event.start?.date ?? null;
    if (startIso) {
      const baseStart = new Date(startIso);
      if (!Number.isNaN(baseStart.getTime())) {
        const actualStart = new Date(baseStart.getTime() + travelBuffer * 60_000);
        if (!existing.startAt || existing.startAt.getTime() !== actualStart.getTime()) {
          updates.startAt = actualStart;
        }
      }
    }

    if ((existing.travelBufferMinutes ?? 0) !== travelBuffer) {
      updates.travelBufferMinutes = travelBuffer;
    }

    const durationRaw = privateProps["durationMinutes"] ?? privateProps["duration_minutes"];
    let duration = parseInteger(durationRaw);
    if (duration === null || duration <= 0) {
      const endIso = event.end?.dateTime ?? event.end?.date ?? null;
      if (startIso && endIso) {
        const baseStart = new Date(startIso);
        const baseEnd = new Date(endIso);
        if (!Number.isNaN(baseStart.getTime()) && !Number.isNaN(baseEnd.getTime())) {
          const totalMinutes = Math.round((baseEnd.getTime() - baseStart.getTime()) / 60000);
          if (totalMinutes > 0) {
            duration = Math.max(totalMinutes - travelBuffer, 15);
          }
        }
      }
    }

    if (duration !== null && duration > 0) {
      const normalized = Math.max(duration, 15);
      if (existing.durationMinutes !== normalized) {
        updates.durationMinutes = normalized;
      }
    }

    if (Object.keys(updates).length > 0) {
      await db.update(appointments).set(updates).where(eq(appointments.id, appointmentId));
      updated += 1;
    }
  }

  return { updated, cancelled };
}

async function calendarFetch(
  config: CalendarConfig,
  accessToken: string,
  path: string,
  init: RequestInit
): Promise<Response | null> {
  const url = `${GOOGLE_API_BASE}/calendars/${encodeURIComponent(config.calendarId)}/${path}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {})
      },
      signal: controller.signal
    });

    clearTimeout(timeout);
    return response;
  } catch (error) {
    console.warn("[calendar-sync] request_error", { path, error: String(error) });
    return null;
  }
}

function parseInteger(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function resolveAppointmentId(event: GoogleCalendarEvent): string | null {
  const privateProps = event.extendedProperties?.private;

  if (privateProps) {
    const direct =
      privateProps?.["appointmentId"] ??
      privateProps?.["appointmentID"] ??
      privateProps?.["AppointmentId"] ??
      privateProps?.["appointment_id"];

    if (typeof direct === "string" && direct.trim().length > 0) {
      return direct.trim();
    }
  }

  if (typeof event.description === "string") {
    const match = event.description.match(/Appointment ID:\s*([A-Za-z0-9-]+)/);
    if (match && typeof match[1] === "string") {
      return match[1].trim();
    }
  }

  return null;
}

async function getOrCreateState(db: DatabaseClient, calendarId: string): Promise<CalendarSyncStateRow> {
  const existing = await db
    .select()
    .from(calendarSyncState)
    .where(eq(calendarSyncState.calendarId, calendarId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0]!;
  }

  await db.insert(calendarSyncState).values({ calendarId }).onConflictDoNothing();

  const created = await db
    .select()
    .from(calendarSyncState)
    .where(eq(calendarSyncState.calendarId, calendarId))
    .limit(1);

  if (created.length === 0) {
    throw new Error("Failed to initialize calendar sync state");
  }

  return created[0]!;
}

async function upsertState(
  db: DatabaseClient,
  calendarId: string,
  values: Partial<typeof calendarSyncState.$inferInsert>
): Promise<void> {
  await db.insert(calendarSyncState).values({ calendarId }).onConflictDoNothing();

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }
  sanitized["updatedAt"] = new Date();

  await db
    .update(calendarSyncState)
    .set(sanitized)
    .where(eq(calendarSyncState.calendarId, calendarId));
}







