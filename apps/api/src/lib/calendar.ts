import { DateTime } from "luxon";
import {
  parseGoogleCalendarEventMutationResponse,
  parseGoogleCalendarTokenResponse,
  resolveGoogleCalendarApiEndpoint,
  resolveGoogleCalendarTokenEndpoint,
} from "@myst-os/sdk";

export interface CalendarConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
  timeZone: string;
}

interface CalendarContact {
  name: string;
  email?: string | null;
  phone?: string | null;
}

interface CalendarProperty {
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface AppointmentCalendarPayload {
  appointmentId: string;
  startAt: Date | null;
  durationMinutes: number;
  travelBufferMinutes: number;
  services: string[];
  notes?: string | null;
  contact: CalendarContact;
  property: CalendarProperty;
  rescheduleUrl?: string;
}

export type AppointmentCalendarContent = Readonly<{
  services: readonly string[];
  notes: string | null;
}>;

function boundedCalendarText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

/**
 * Resolves one safe calendar projection for both lead-backed and canonical
 * partner jobs. Partner jobs do not require a lead, and only their public
 * service key plus quoted scope cross the provider boundary.
 */
export function resolveAppointmentCalendarContent(input: {
  leadServices: unknown;
  leadNotes: unknown;
  partnerServiceKey: unknown;
  quotedScopeText: unknown;
}): AppointmentCalendarContent {
  const leadServices = Array.isArray(input.leadServices)
    ? input.leadServices
        .map((service) => boundedCalendarText(service, 120))
        .filter((service): service is string => service !== null)
        .filter((service, index, values) => values.indexOf(service) === index)
        .slice(0, 20)
    : [];
  const partnerServiceKey = boundedCalendarText(input.partnerServiceKey, 120);
  const services =
    leadServices.length > 0
      ? leadServices
      : partnerServiceKey
        ? [partnerServiceKey]
        : [];

  return Object.freeze({
    services: Object.freeze(services),
    notes:
      boundedCalendarText(input.leadNotes, 4_000) ??
      boundedCalendarText(input.quotedScopeText, 4_000),
  });
}

let cachedToken:
  | {
      accessToken: string;
      expiresAt: number;
      configKey: string;
    }
  | undefined;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

async function discardProviderBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function isGoogleCalendarEnabled(): boolean {
  const raw = (process.env["GOOGLE_CALENDAR_ENABLED"] ?? "")
    .trim()
    .toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

export function getCalendarConfig(): CalendarConfig | null {
  if (!isGoogleCalendarEnabled()) {
    return null;
  }

  const clientId = process.env["GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
  const refreshToken = process.env["GOOGLE_REFRESH_TOKEN"];
  const calendarId = process.env["GOOGLE_CALENDAR_ID"];

  if (!clientId || !clientSecret || !refreshToken || !calendarId) {
    return null;
  }

  const timeZone =
    process.env["GOOGLE_CALENDAR_TIMEZONE"] ??
    process.env["APPOINTMENT_TIMEZONE"] ??
    "America/New_York";

  return { clientId, clientSecret, refreshToken, calendarId, timeZone };
}

export async function getAccessToken(
  config: CalendarConfig,
): Promise<string | null> {
  if (!isGoogleCalendarEnabled()) {
    return null;
  }

  let tokenEndpoint: string;
  try {
    tokenEndpoint = resolveGoogleCalendarTokenEndpoint(process.env);
  } catch (error) {
    console.warn("[calendar] token_endpoint_error", {
      errorName: errorName(error),
    });
    return null;
  }

  const cacheKey = `${config.clientId}:${config.calendarId}:${tokenEndpoint}`;
  const now = Date.now();

  if (
    cachedToken &&
    cachedToken.configKey === cacheKey &&
    cachedToken.expiresAt > now + 30_000
  ) {
    return cachedToken.accessToken;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      await discardProviderBody(response);
      console.warn("[calendar] refresh_token_failed", {
        status: response.status,
      });
      return null;
    }

    const data = parseGoogleCalendarTokenResponse(
      await response.json().catch(() => null),
    );
    if (!data) {
      console.warn("[calendar] refresh_token_malformed_response", {
        status: response.status,
      });
      return null;
    }

    cachedToken = {
      accessToken: data.accessToken,
      expiresAt: now + data.expiresInSeconds * 1000,
      configKey: cacheKey,
    };

    return data.accessToken;
  } catch (error) {
    console.warn("[calendar] token_error", { errorName: errorName(error) });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildEventBody(
  payload: AppointmentCalendarPayload,
  config: CalendarConfig,
): {
  start: DateTime;
  end: DateTime;
  bufferStart: DateTime;
  description: string;
  travelBufferMinutes: number;
  durationMinutes: number;
} | null {
  if (!payload.startAt) {
    return null;
  }

  const start = DateTime.fromJSDate(payload.startAt, { zone: "utc" }).setZone(
    config.timeZone,
  );
  if (!start.isValid) {
    return null;
  }

  const travelBufferMinutes = Math.max(payload.travelBufferMinutes ?? 0, 0);
  const durationMinutes = Math.max(payload.durationMinutes ?? 60, 15);

  const bufferStart = start.minus({ minutes: travelBufferMinutes });
  const end = start.plus({ minutes: durationMinutes });

  const lines: string[] = [
    `Appointment ID: ${payload.appointmentId}`,
    `Contact: ${payload.contact.name}`,
    payload.contact.phone ? `Phone: ${payload.contact.phone}` : null,
    payload.contact.email ? `Email: ${payload.contact.email}` : null,
    `Services: ${payload.services.join(", ") || "Junk removal"}`,
    `Location: ${payload.property.addressLine1}, ${payload.property.city}, ${payload.property.state} ${payload.property.postalCode}`,
  ].filter((line): line is string => Boolean(line));

  if (payload.notes) {
    lines.push("", `Notes: ${payload.notes}`);
  }

  if (payload.rescheduleUrl) {
    lines.push("", `Reschedule: ${payload.rescheduleUrl}`);
  }

  const description = lines.join("\n");

  return {
    start,
    end,
    bufferStart,
    description,
    travelBufferMinutes,
    durationMinutes,
  };
}

async function googleRequest(
  config: CalendarConfig,
  accessToken: string,
  eventId: string | null,
  init: RequestInit,
): Promise<Response | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const url = resolveGoogleCalendarApiEndpoint(
      eventId
        ? { kind: "event", calendarId: config.calendarId, eventId }
        : { kind: "events", calendarId: config.calendarId },
      process.env,
    );

    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });

    return response;
  } catch (error) {
    console.warn("[calendar] request_error", {
      errorName: errorName(error),
    });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Google accepts caller-supplied event IDs made from base32hex characters.
 * Deriving the ID from the immutable appointment UUID makes an outbox retry
 * converge on one provider event even if a worker loses its response.
 */
export function buildGoogleCalendarEventId(
  appointmentId: string,
): string | null {
  const normalized = appointmentId
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(normalized)) return null;
  return `stonegate${normalized}`;
}

export async function createCalendarEvent(
  payload: AppointmentCalendarPayload,
): Promise<string | null> {
  const config = getCalendarConfig();
  if (!config) {
    return null;
  }

  const accessToken = await getAccessToken(config);
  if (!accessToken) {
    return null;
  }

  const eventBody = buildEventBody(payload, config);
  if (!eventBody) {
    return null;
  }
  const deterministicEventId = buildGoogleCalendarEventId(
    payload.appointmentId,
  );
  if (!deterministicEventId) return null;

  const response = await googleRequest(config, accessToken, null, {
    method: "POST",
    body: JSON.stringify({
      id: deterministicEventId,
      summary: `Stonegate Junk Removal: ${payload.contact.name}`,
      description: eventBody.description,
      start: {
        dateTime: eventBody.bufferStart.toISO(),
        timeZone: config.timeZone,
      },
      end: {
        dateTime: eventBody.end.toISO(),
        timeZone: config.timeZone,
      },
      location: `${payload.property.addressLine1}, ${payload.property.city}, ${payload.property.state} ${payload.property.postalCode}`,
      extendedProperties: {
        private: {
          appointmentId: payload.appointmentId,
          travelBufferMinutes: String(eventBody.travelBufferMinutes),
          durationMinutes: String(eventBody.durationMinutes),
        },
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 24 * 60 },
          { method: "popup", minutes: 24 * 60 },
          { method: "popup", minutes: 2 * 60 },
        ],
      },
    }),
  });

  if (!response) {
    return null;
  }

  if (!response.ok) {
    const status = response.status;
    await discardProviderBody(response);
    if (status === 409) {
      const updated = await updateCalendarEvent(deterministicEventId, payload);
      return updated ? deterministicEventId : null;
    }
    console.warn("[calendar] create_failed", { status });
    return null;
  }

  const data = parseGoogleCalendarEventMutationResponse(
    await response.json().catch(() => null),
  );
  if (!data) {
    console.warn("[calendar] create_malformed_response", {
      status: response.status,
    });
    return null;
  }
  return data.eventId === deterministicEventId ? data.eventId : null;
}

export async function updateCalendarEvent(
  eventId: string,
  payload: AppointmentCalendarPayload,
): Promise<boolean> {
  const config = getCalendarConfig();
  if (!config) {
    return false;
  }

  const accessToken = await getAccessToken(config);
  if (!accessToken) {
    return false;
  }

  const eventBody = buildEventBody(payload, config);
  if (!eventBody) {
    return false;
  }

  const response = await googleRequest(config, accessToken, eventId, {
    method: "PATCH",
    body: JSON.stringify({
      summary: `Stonegate Junk Removal: ${payload.contact.name}`,
      description: eventBody.description,
      start: {
        dateTime: eventBody.bufferStart.toISO(),
        timeZone: config.timeZone,
      },
      end: {
        dateTime: eventBody.end.toISO(),
        timeZone: config.timeZone,
      },
      location: `${payload.property.addressLine1}, ${payload.property.city}, ${payload.property.state} ${payload.property.postalCode}`,
      extendedProperties: {
        private: {
          appointmentId: payload.appointmentId,
          travelBufferMinutes: String(eventBody.travelBufferMinutes),
          durationMinutes: String(eventBody.durationMinutes),
        },
      },
    }),
  });

  if (!response) {
    return false;
  }

  if (!response.ok) {
    await discardProviderBody(response);
    console.warn("[calendar] update_failed", { status: response.status });
    return false;
  }

  const data = parseGoogleCalendarEventMutationResponse(
    await response.json().catch(() => null),
    eventId,
  );
  if (!data) {
    console.warn("[calendar] update_malformed_response", {
      status: response.status,
    });
    return false;
  }
  return true;
}

export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  const config = getCalendarConfig();
  if (!config) {
    return false;
  }

  const accessToken = await getAccessToken(config);
  if (!accessToken) {
    return false;
  }

  const response = await googleRequest(config, accessToken, eventId, {
    method: "DELETE",
  });

  if (!response) {
    return false;
  }

  if (!response.ok && response.status !== 404) {
    await discardProviderBody(response);
    console.warn("[calendar] delete_failed", { status: response.status });
    return false;
  }
  return true;
}
