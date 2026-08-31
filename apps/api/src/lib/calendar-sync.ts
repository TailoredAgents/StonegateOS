import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  parseGoogleCalendarEventListResponse,
  parseGoogleCalendarWatchResponse,
  resolveGoogleCalendarApiEndpoint,
  type GoogleCalendarApiEndpoint,
} from "@myst-os/sdk";
import { appointments, calendarSyncState, getDb, scheduleBlocks } from "@/db";
import type { DatabaseClient } from "@/db";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import type { CalendarConfig } from "./calendar";
import {
  getCalendarConfig,
  getAccessToken,
  isGoogleCalendarEnabled,
} from "./calendar";

const WATCH_RENEW_BUFFER_MS = 10 * 60 * 1000;
const WATCH_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SYNC_ITERATIONS = 20;
const EXTERNAL_BUSY_SOURCE = "google_calendar_external_busy";
const EXTERNAL_BUSY_FUTURE_DAYS = 400;
const EXTERNAL_BUSY_COVERAGE_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_LOOKBACK_DAYS = (() => {
  const raw = Number.parseInt(
    process.env["GOOGLE_CALENDAR_SYNC_LOOKBACK_DAYS"] ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 45;
})();

function configuredExternalBusyPoolKey(): string {
  const value = (
    process.env["GOOGLE_CALENDAR_EXTERNAL_BUSY_CAPACITY_POOL_KEY"] ??
    "field_service"
  ).trim();
  return /^[a-z][a-z0-9_-]{0,63}$/u.test(value) ? value : "field_service";
}

function configuredExternalBusyCapacityUnits(): number {
  const value = Number.parseInt(
    process.env["GOOGLE_CALENDAR_EXTERNAL_BUSY_CAPACITY_UNITS"] ?? "1",
    10,
  );
  return Number.isSafeInteger(value) && value >= 1 && value <= 10_000
    ? value
    : 1;
}

type CalendarSyncStateRow = typeof calendarSyncState.$inferSelect;
type CalendarTransaction = Parameters<
  DatabaseClient["transaction"]
>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;

export type GoogleExternalBusyBlockPlan = Readonly<{
  sourceKey: string;
  startAt: Date;
  endAt: Date;
  capacityPoolKey: string;
  capacityUnits: number;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type GoogleExternalBusyReconciliationPlan = Readonly<{
  seenSourceKeys: readonly string[];
  activeBlocks: readonly GoogleExternalBusyBlockPlan[];
  invalidBusyEventCount: number;
}>;

export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  transparency?: string;
  eventType?: string;
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  updated?: string;
  summary?: string;
  description?: string;
  extendedProperties?: {
    private?: Record<string, string | undefined>;
  };
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
  detail: "request_failed" | "provider_rejected" | "malformed_response";
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
  externalBusyUpserted?: number;
  externalBusyDeactivated?: number;
  externalBusyCoverageSyncedAt?: string;
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
let syncFollowUpRequested = false;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function parseEventEndpoint(
  value: unknown,
): GoogleCalendarEvent["start"] | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const dateTime = optionalString(value, "dateTime");
  const date = optionalString(value, "date");
  const timeZone = optionalString(value, "timeZone");
  if (dateTime === null || date === null || timeZone === null) return null;
  return {
    ...(dateTime !== undefined ? { dateTime } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
  };
}

function parseGoogleCalendarEvents(
  items: unknown[],
): GoogleCalendarEvent[] | null {
  const parsed: GoogleCalendarEvent[] = [];
  for (const item of items) {
    if (!isRecord(item)) return null;
    const id = optionalString(item, "id");
    const status = optionalString(item, "status");
    const transparency = optionalString(item, "transparency");
    const eventType = optionalString(item, "eventType");
    const updated = optionalString(item, "updated");
    const summary = optionalString(item, "summary");
    const description = optionalString(item, "description");
    const start = parseEventEndpoint(item["start"]);
    const end = parseEventEndpoint(item["end"]);
    if (
      !id?.trim() ||
      status === null ||
      transparency === null ||
      eventType === null ||
      updated === null ||
      summary === null ||
      description === null ||
      start === null ||
      end === null
    ) {
      return null;
    }
    const rawExtendedProperties = item["extendedProperties"];
    let privateProperties: Record<string, string | undefined> | undefined;
    if (rawExtendedProperties !== undefined) {
      if (!isRecord(rawExtendedProperties)) return null;
      const rawPrivate = rawExtendedProperties["private"];
      if (rawPrivate !== undefined) {
        if (!isRecord(rawPrivate)) return null;
        privateProperties = {};
        for (const [key, value] of Object.entries(rawPrivate)) {
          if (value !== undefined && typeof value !== "string") return null;
          privateProperties[key] = value;
        }
      }
    }
    parsed.push({
      id: id.trim(),
      ...(status !== undefined ? { status } : {}),
      ...(transparency !== undefined ? { transparency } : {}),
      ...(eventType !== undefined ? { eventType } : {}),
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(updated !== undefined ? { updated } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(privateProperties
        ? { extendedProperties: { private: privateProperties } }
        : {}),
    });
  }
  return parsed;
}

async function discardProviderBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

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
    console.warn("[calendar-sync] ensure_watch_failed", {
      reason: "token_error",
    });
    return false;
  }

  const result = await ensureWatchForState(db, config, state, accessToken);
  if (result.registered) {
    console.info("[calendar-sync] watch_registered", { registered: true });
  }

  return result.registered;
}

export async function syncGoogleCalendar(
  options: SyncOptions = {},
): Promise<CalendarSyncResult> {
  if (!isGoogleCalendarEnabled()) {
    return { ok: true, reason: "disabled" };
  }

  if (syncInFlight) {
    // Webhook notifications can arrive while an earlier snapshot is still in
    // flight. Coalesce them into one immediate follow-up instead of silently
    // losing the newest invalidation signal.
    syncFollowUpRequested = true;
    return syncInFlight;
  }

  syncInFlight = (async () => {
    let result = await performSync(options);
    for (let attempt = 0; syncFollowUpRequested && attempt < 3; attempt += 1) {
      syncFollowUpRequested = false;
      result = await performSync({ reason: "coalesced_notification" });
    }
    return result;
  })().finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
}

export async function recordCalendarNotification(
  metadata: CalendarNotificationMetadata,
): Promise<void> {
  const config = getCalendarConfig();
  if (!config) {
    return;
  }

  const db = getDb();
  const state = await getOrCreateState(db, config.calendarId);

  if (
    state.channelId &&
    metadata.channelId &&
    state.channelId !== metadata.channelId
  ) {
    console.warn("[calendar-sync] notification_channel_mismatch", {
      reason: "channel_mismatch",
    });
    return;
  }

  const updates: Partial<typeof calendarSyncState.$inferInsert> = {
    lastNotificationAt: new Date(),
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

  const syncStartedAt = new Date();
  // A bounded authoritative snapshot is intentional. Incremental tokens bind
  // to the original timeMin/timeMax and eventually leave a rolling booking
  // horizon uncovered. Full snapshots keep recurring-event expansion and the
  // supported 365-day booking horizon provable with one freshness watermark.
  const fullSync = true;
  let syncToken: string | null = null;
  let nextSyncToken: string | null = null;
  if (options.forceResync) {
    console.info("[calendar-sync] authoritative_resync_requested", {
      reason: options.reason ?? "manual",
    });
  }
  let pageToken: string | undefined;
  let pages = 0;
  let resets = 0;
  let complete = false;
  const events: GoogleCalendarEvent[] = [];

  const timeMin = new Date(
    syncStartedAt.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const timeMax = new Date(
    syncStartedAt.getTime() + EXTERNAL_BUSY_FUTURE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  while (pages < MAX_SYNC_ITERATIONS) {
    const result = await fetchEventPage(config, accessToken, {
      syncToken,
      pageToken,
      timeMin: syncToken ? undefined : timeMin,
      timeMax: syncToken ? undefined : timeMax,
    });

    if (result.kind === "reset") {
      syncToken = null;
      nextSyncToken = null;
      pageToken = undefined;
      events.length = 0;
      resets += 1;
      console.info("[calendar-sync] sync_token_reset", { resets });
      if (resets > 1) {
        return {
          ok: false,
          reason: "sync_token_reset_exhausted",
          pages,
          resets,
          watchRegistered: watchResult.registered,
        };
      }
      continue;
    }

    if (result.kind === "error") {
      return {
        ok: false,
        reason: "google_error",
        status: result.status,
        details: result.detail,
        pages,
        resets,
        watchRegistered: watchResult.registered,
      };
    }

    events.push(...result.items);

    nextSyncToken = result.nextSyncToken ?? nextSyncToken ?? syncToken;
    pageToken = result.nextPageToken;
    pages += 1;

    if (!pageToken) {
      complete = true;
      break;
    }
  }

  if (!complete) {
    return {
      ok: false,
      reason: "page_limit_exceeded",
      pages,
      resets,
      watchRegistered: watchResult.registered,
    };
  }

  try {
    const persisted = await db.transaction(async (tx) => {
      // Reconciliation mutates the same capacity domain used by every booking
      // writer. This lock prevents a hold/submit from reading between block
      // reconciliation and the coverage watermark commit.
      await acquireScheduleConflictLock(tx);
      const [currentState] = await tx
        .select()
        .from(calendarSyncState)
        .where(eq(calendarSyncState.calendarId, config.calendarId))
        .for("update")
        .limit(1);
      if (!currentState) {
        throw new Error("calendar_sync_state_missing");
      }
      if (!calendarStateVersionMatches(currentState, state)) {
        return { kind: "superseded" as const };
      }

      const appointmentChanges = await applyEventsToAppointments(tx, events);
      const reconciliation = planGoogleExternalBusyBlocks({
        events,
        mirroredEventIds: appointmentChanges.mirroredEventIds,
        calendarId: config.calendarId,
        timeZone: config.timeZone,
        capacityPoolKey: configuredExternalBusyPoolKey(),
        capacityUnits: configuredExternalBusyCapacityUnits(),
      });
      if (reconciliation.invalidBusyEventCount > 0) {
        throw new Error("calendar_external_busy_event_invalid");
      }
      const blockChanges = await reconcileExternalBusyBlocks(tx, {
        plan: reconciliation,
        fullSync,
        now: syncStartedAt,
      });
      const externalBusyCoverageSyncedAt = syncStartedAt;
      await tx
        .update(calendarSyncState)
        .set({
          syncToken: nextSyncToken,
          lastSyncedAt: syncStartedAt,
          externalBusyCoverageSyncedAt,
          channelId: currentState.channelId,
          resourceId: currentState.resourceId,
          channelExpiresAt: currentState.channelExpiresAt,
          updatedAt: syncStartedAt,
        })
        .where(eq(calendarSyncState.calendarId, config.calendarId));
      return {
        kind: "persisted" as const,
        appointmentChanges,
        blockChanges,
        externalBusyCoverageSyncedAt,
      };
    });

    if (persisted.kind === "superseded") {
      return {
        ok: true,
        reason: "superseded",
        pages,
        resets,
        watchRegistered: watchResult.registered,
      };
    }

    return {
      ok: true,
      updated: persisted.appointmentChanges.updated,
      cancelled: persisted.appointmentChanges.cancelled,
      externalBusyUpserted: persisted.blockChanges.upserted,
      externalBusyDeactivated: persisted.blockChanges.deactivated,
      externalBusyCoverageSyncedAt:
        persisted.externalBusyCoverageSyncedAt.toISOString(),
      pages,
      resets,
      watchRegistered: watchResult.registered,
    };
  } catch (error) {
    console.warn("[calendar-sync] persistence_failed", {
      errorName: errorName(error),
    });
    return {
      ok: false,
      reason:
        error instanceof Error &&
        error.message === "calendar_external_busy_event_invalid"
          ? "invalid_external_busy_event"
          : "persistence_error",
      pages,
      resets,
      watchRegistered: watchResult.registered,
    };
  }
}

async function ensureWatchForState(
  db: DatabaseClient,
  config: CalendarConfig,
  state: CalendarSyncStateRow,
  accessToken?: string | null,
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
    console.warn("[calendar-sync] ensure_watch_failed", {
      reason: "token_error",
    });
    return { state, registered: false };
  }

  const registration = await registerWatch(config, token, address);
  if (!registration) {
    return { state, registered: false };
  }

  await upsertState(db, config.calendarId, {
    channelId: registration.channelId,
    resourceId: registration.resourceId ?? state.resourceId ?? null,
    channelExpiresAt: registration.expiresAt ?? null,
  });

  const refreshed = await getOrCreateState(db, config.calendarId);
  return { state: refreshed, registered: true };
}

async function registerWatch(
  config: CalendarConfig,
  accessToken: string,
  address: string,
): Promise<{
  channelId: string;
  resourceId: string | null;
  expiresAt: Date | null;
} | null> {
  const channelId = randomUUID();
  const response = await calendarFetch(
    accessToken,
    { kind: "watch", calendarId: config.calendarId },
    {
      method: "POST",
      body: JSON.stringify({
        id: channelId,
        type: "webhook",
        address,
        params: {
          ttl: WATCH_TTL_SECONDS.toString(),
        },
      }),
    },
  );

  if (!response) {
    return null;
  }

  if (!response.ok) {
    await discardProviderBody(response);
    console.warn("[calendar-sync] watch_registration_failed", {
      status: response.status,
    });
    return null;
  }

  const data = parseGoogleCalendarWatchResponse(
    await response.json().catch(() => null),
  );
  if (!data) {
    console.warn("[calendar-sync] watch_registration_malformed_response", {
      status: response.status,
    });
    return null;
  }
  const expirationMs = data.expiration
    ? Number.parseInt(data.expiration, 10)
    : undefined;

  return {
    channelId,
    resourceId: data.resourceId,
    expiresAt: Number.isFinite(expirationMs) ? new Date(expirationMs!) : null,
  };
}

async function fetchEventPage(
  config: CalendarConfig,
  accessToken: string,
  options: {
    syncToken: string | null;
    pageToken?: string;
    timeMin?: string;
    timeMax?: string;
  },
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
    if (options.timeMax) params.set("timeMax", options.timeMax);
    // Expansion is required for recurring external busy events. The bounded
    // coverage horizon prevents unbounded recurrence materialization.
    params.set("singleEvents", "true");
    params.set("orderBy", "updated");
  }

  const response = await calendarFetch(
    accessToken,
    { kind: "events", calendarId: config.calendarId },
    { method: "GET" },
    params,
  );

  if (!response) {
    return { kind: "error", status: 503, detail: "request_failed" };
  }

  if (response.status === 410) {
    return { kind: "reset" };
  }

  if (!response.ok) {
    await discardProviderBody(response);
    console.warn("[calendar-sync] events_list_failed", {
      status: response.status,
    });
    return {
      kind: "error",
      status: response.status,
      detail: "provider_rejected",
    };
  }

  const data = parseGoogleCalendarEventListResponse(
    await response.json().catch(() => null),
  );
  if (!data) {
    console.warn("[calendar-sync] events_list_malformed_response", {
      status: response.status,
    });
    return {
      kind: "error",
      status: 502,
      detail: "malformed_response",
    };
  }
  const items = parseGoogleCalendarEvents(data.items);
  if (!items) {
    console.warn("[calendar-sync] events_list_malformed_items", {
      status: response.status,
    });
    return {
      kind: "error",
      status: 502,
      detail: "malformed_response",
    };
  }
  return {
    kind: "ok",
    items,
    nextPageToken: data.nextPageToken ?? undefined,
    nextSyncToken: data.nextSyncToken ?? null,
  };
}

function sameNullableDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

function calendarStateVersionMatches(
  current: CalendarSyncStateRow,
  expected: CalendarSyncStateRow,
): boolean {
  return (
    current.syncToken === expected.syncToken &&
    sameNullableDate(current.lastSyncedAt, expected.lastSyncedAt) &&
    sameNullableDate(
      current.externalBusyCoverageSyncedAt,
      expected.externalBusyCoverageSyncedAt,
    )
  );
}

function externalBusySourceKey(calendarId: string, eventId: string): string {
  return createHash("sha256")
    .update("google-calendar-external-busy\0", "utf8")
    .update(calendarId, "utf8")
    .update("\0", "utf8")
    .update(eventId, "utf8")
    .digest("hex");
}

function eventEndpointDate(
  endpoint: { dateTime?: string; date?: string; timeZone?: string } | undefined,
  fallbackTimeZone: string,
): Date | null {
  if (endpoint?.dateTime) {
    const dateTime = DateTime.fromISO(endpoint.dateTime, {
      zone: endpoint.timeZone ?? fallbackTimeZone,
      setZone: true,
    });
    return dateTime.isValid ? dateTime.toUTC().toJSDate() : null;
  }
  if (endpoint?.date) {
    const dateTime = DateTime.fromISO(endpoint.date, {
      zone: endpoint.timeZone ?? fallbackTimeZone,
    }).startOf("day");
    return dateTime.isValid ? dateTime.toUTC().toJSDate() : null;
  }
  return null;
}

function eventBusyInterval(
  event: GoogleCalendarEvent,
  timeZone: string,
): { startAt: Date; endAt: Date } | null {
  const startAt = eventEndpointDate(event.start, timeZone);
  const endAt = eventEndpointDate(event.end, timeZone);
  if (!startAt || !endAt || endAt.getTime() <= startAt.getTime()) return null;
  return { startAt, endAt };
}

/**
 * Produces a metadata-minimized, deterministic reconciliation plan. Events
 * linked to Stonegate appointments are deliberately excluded so the same
 * work never consumes capacity as both an appointment and an external block.
 */
export function planGoogleExternalBusyBlocks(input: {
  events: readonly GoogleCalendarEvent[];
  mirroredEventIds: ReadonlySet<string> | readonly string[];
  calendarId: string;
  timeZone: string;
  capacityPoolKey: string;
  capacityUnits: number;
}): GoogleExternalBusyReconciliationPlan {
  if (
    !/^[a-z][a-z0-9_-]{0,63}$/u.test(input.capacityPoolKey) ||
    !Number.isSafeInteger(input.capacityUnits) ||
    input.capacityUnits < 1 ||
    input.capacityUnits > 10_000 ||
    !input.calendarId.trim() ||
    !input.timeZone.trim()
  ) {
    throw new TypeError("Invalid Google Calendar busy-block configuration.");
  }
  const mirrored = new Set(input.mirroredEventIds);
  const latestById = new Map<string, GoogleCalendarEvent>();
  let invalidBusyEventCount = 0;
  for (const event of input.events) {
    const eventId = event.id.trim();
    if (!eventId) {
      invalidBusyEventCount += 1;
      continue;
    }
    latestById.set(eventId, event);
  }

  const seenSourceKeys: string[] = [];
  const activeBlocks: GoogleExternalBusyBlockPlan[] = [];
  for (const [eventId, event] of latestById) {
    const sourceKey = externalBusySourceKey(input.calendarId, eventId);
    seenSourceKeys.push(sourceKey);
    const inactive =
      mirrored.has(eventId) ||
      event.status === "cancelled" ||
      event.transparency === "transparent" ||
      event.eventType === "workingLocation";
    if (inactive) continue;
    const interval = eventBusyInterval(event, input.timeZone);
    if (!interval) {
      invalidBusyEventCount += 1;
      continue;
    }
    activeBlocks.push(
      Object.freeze({
        sourceKey,
        ...interval,
        capacityPoolKey: input.capacityPoolKey,
        capacityUnits: input.capacityUnits,
        metadata: Object.freeze({
          provider: "google_calendar",
          coverageVersion: EXTERNAL_BUSY_COVERAGE_VERSION,
          allDay: Boolean(event.start?.date),
          eventUpdatedAt:
            typeof event.updated === "string"
              ? event.updated.slice(0, 64)
              : null,
        }),
      }),
    );
  }
  return Object.freeze({
    seenSourceKeys: Object.freeze(seenSourceKeys.sort()),
    activeBlocks: Object.freeze(
      activeBlocks.sort((left, right) =>
        left.sourceKey.localeCompare(right.sourceKey),
      ),
    ),
    invalidBusyEventCount,
  });
}

function chunks<T>(values: readonly T[], maximum: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += maximum) {
    result.push(values.slice(index, index + maximum));
  }
  return result;
}

async function reconcileExternalBusyBlocks(
  tx: CalendarTransaction,
  input: {
    plan: GoogleExternalBusyReconciliationPlan;
    fullSync: boolean;
    now: Date;
  },
): Promise<{ upserted: number; deactivated: number }> {
  const activeKeys = input.plan.activeBlocks.map((block) => block.sourceKey);
  let deactivated = 0;
  if (input.fullSync) {
    const rows = await tx
      .update(scheduleBlocks)
      .set({ active: false, updatedAt: input.now })
      .where(
        and(
          eq(scheduleBlocks.source, EXTERNAL_BUSY_SOURCE),
          eq(scheduleBlocks.active, true),
          ...(activeKeys.length > 0
            ? [
                isNotNull(scheduleBlocks.sourceKey),
                notInArray(scheduleBlocks.sourceKey, activeKeys),
              ]
            : []),
        ),
      )
      .returning({ id: scheduleBlocks.id });
    deactivated += rows.length;
  } else {
    const activeSet = new Set(activeKeys);
    const inactiveKeys = input.plan.seenSourceKeys.filter(
      (sourceKey) => !activeSet.has(sourceKey),
    );
    for (const keyChunk of chunks(inactiveKeys, 500)) {
      const rows = await tx
        .update(scheduleBlocks)
        .set({ active: false, updatedAt: input.now })
        .where(
          and(
            eq(scheduleBlocks.source, EXTERNAL_BUSY_SOURCE),
            eq(scheduleBlocks.active, true),
            inArray(scheduleBlocks.sourceKey, keyChunk),
          ),
        )
        .returning({ id: scheduleBlocks.id });
      deactivated += rows.length;
    }
  }

  let upserted = 0;
  for (const blockChunk of chunks(input.plan.activeBlocks, 500)) {
    const rows = await tx
      .insert(scheduleBlocks)
      .values(
        blockChunk.map((block) => ({
          kind: "external_busy",
          source: EXTERNAL_BUSY_SOURCE,
          sourceKey: block.sourceKey,
          capacityPoolKey: block.capacityPoolKey,
          capacityUnits: block.capacityUnits,
          startAt: block.startAt,
          endAt: block.endAt,
          active: true,
          mirroredAppointmentId: null,
          metadata: { ...block.metadata },
          createdAt: input.now,
          updatedAt: input.now,
        })),
      )
      .onConflictDoUpdate({
        target: [scheduleBlocks.source, scheduleBlocks.sourceKey],
        targetWhere: sql`${scheduleBlocks.sourceKey} IS NOT NULL`,
        set: {
          kind: sql`excluded."kind"`,
          capacityPoolKey: sql`excluded."capacity_pool_key"`,
          capacityUnits: sql`excluded."capacity_units"`,
          startAt: sql`excluded."start_at"`,
          endAt: sql`excluded."end_at"`,
          active: true,
          mirroredAppointmentId: null,
          metadata: sql`excluded."metadata"`,
          updatedAt: input.now,
        },
      })
      .returning({ id: scheduleBlocks.id });
    upserted += rows.length;
  }
  return { upserted, deactivated };
}

async function applyEventsToAppointments(
  db: CalendarTransaction,
  events: GoogleCalendarEvent[],
): Promise<{
  updated: number;
  cancelled: number;
  mirroredEventIds: ReadonlySet<string>;
}> {
  const appointmentIds = Array.from(
    new Set(
      events
        .map(resolveAppointmentId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const eventIds = Array.from(
    new Set(events.map((event) => event.id.trim()).filter(Boolean)),
  );
  const mirroredEventIds = new Set<string>();

  if (appointmentIds.length === 0 && eventIds.length === 0) {
    return { updated: 0, cancelled: 0, mirroredEventIds };
  }

  const rows = await db
    .select({
      id: appointments.id,
      startAt: appointments.startAt,
      durationMinutes: appointments.durationMinutes,
      travelBufferMinutes: appointments.travelBufferMinutes,
      status: appointments.status,
      calendarEventId: appointments.calendarEventId,
    })
    .from(appointments)
    .where(
      appointmentIds.length > 0 && eventIds.length > 0
        ? or(
            inArray(appointments.id, appointmentIds),
            inArray(appointments.calendarEventId, eventIds),
          )
        : appointmentIds.length > 0
          ? inArray(appointments.id, appointmentIds)
          : inArray(appointments.calendarEventId, eventIds),
    );

  const byAppointmentId = new Map(rows.map((row) => [row.id, row]));
  const byCalendarEventId = new Map(
    rows.flatMap((row) =>
      row.calendarEventId ? ([[row.calendarEventId, row]] as const) : [],
    ),
  );

  let updated = 0;
  let cancelled = 0;

  for (const event of events) {
    const appointmentId = resolveAppointmentId(event);
    const existing =
      (appointmentId ? byAppointmentId.get(appointmentId) : undefined) ??
      byCalendarEventId.get(event.id);
    if (!existing) {
      continue;
    }
    if (event.id.trim()) mirroredEventIds.add(event.id.trim());

    if (event.status === "cancelled") {
      const updates: Partial<typeof appointments.$inferInsert> = {};
      if (existing.calendarEventId) {
        updates.calendarEventId = null;
      }
      if (existing.status !== "canceled") {
        updates.status = "canceled";
      }

      if (Object.keys(updates).length > 0) {
        await db
          .update(appointments)
          .set(updates)
          .where(eq(appointments.id, existing.id));
        cancelled += 1;
      }

      continue;
    }

    const privateProps = event.extendedProperties?.private ?? {};
    const updates: Partial<typeof appointments.$inferInsert> = {};

    if (event.id && existing.calendarEventId !== event.id) {
      updates.calendarEventId = event.id;
    }

    const travelBufferRaw =
      privateProps["travelBufferMinutes"] ??
      privateProps["travel_buffer_minutes"];
    let travelBuffer = parseInteger(travelBufferRaw);
    if (travelBuffer === null || travelBuffer < 0) {
      travelBuffer = existing.travelBufferMinutes ?? 0;
    }

    const startIso = event.start?.dateTime ?? event.start?.date ?? null;
    if (startIso) {
      const baseStart = new Date(startIso);
      if (!Number.isNaN(baseStart.getTime())) {
        const actualStart = new Date(
          baseStart.getTime() + travelBuffer * 60_000,
        );
        if (
          !existing.startAt ||
          existing.startAt.getTime() !== actualStart.getTime()
        ) {
          updates.startAt = actualStart;
        }
      }
    }

    if ((existing.travelBufferMinutes ?? 0) !== travelBuffer) {
      updates.travelBufferMinutes = travelBuffer;
    }

    const durationRaw =
      privateProps["durationMinutes"] ?? privateProps["duration_minutes"];
    let duration = parseInteger(durationRaw);
    if (duration === null || duration <= 0) {
      const endIso = event.end?.dateTime ?? event.end?.date ?? null;
      if (startIso && endIso) {
        const baseStart = new Date(startIso);
        const baseEnd = new Date(endIso);
        if (
          !Number.isNaN(baseStart.getTime()) &&
          !Number.isNaN(baseEnd.getTime())
        ) {
          const totalMinutes = Math.round(
            (baseEnd.getTime() - baseStart.getTime()) / 60000,
          );
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
      await db
        .update(appointments)
        .set(updates)
        .where(eq(appointments.id, existing.id));
      updated += 1;
    }
  }

  return { updated, cancelled, mirroredEventIds };
}

async function calendarFetch(
  accessToken: string,
  endpoint: GoogleCalendarApiEndpoint,
  init: RequestInit,
  query?: URLSearchParams,
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = resolveGoogleCalendarApiEndpoint(endpoint, process.env, query);

    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });

    return response;
  } catch (error) {
    console.warn("[calendar-sync] request_error", {
      operation: endpoint.kind,
      errorName: errorName(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseInteger(
  value: string | number | null | undefined,
): number | null {
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

    if (typeof direct === "string" && UUID_PATTERN.test(direct.trim())) {
      return direct.trim();
    }
  }

  if (typeof event.description === "string") {
    const match = event.description.match(/Appointment ID:\s*([A-Za-z0-9-]+)/);
    if (
      match &&
      typeof match[1] === "string" &&
      UUID_PATTERN.test(match[1].trim())
    ) {
      return match[1].trim();
    }
  }

  return null;
}

async function getOrCreateState(
  db: DatabaseClient,
  calendarId: string,
): Promise<CalendarSyncStateRow> {
  const existing = await db
    .select()
    .from(calendarSyncState)
    .where(eq(calendarSyncState.calendarId, calendarId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0]!;
  }

  await db
    .insert(calendarSyncState)
    .values({ calendarId })
    .onConflictDoNothing();

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
  values: Partial<typeof calendarSyncState.$inferInsert>,
): Promise<void> {
  await db
    .insert(calendarSyncState)
    .values({ calendarId })
    .onConflictDoNothing();

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
