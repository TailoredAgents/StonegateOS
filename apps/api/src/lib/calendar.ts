import { DateTime } from "luxon";

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

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_API_BASE = "https://www.googleapis.com/calendar/v3";

let cachedToken:
  | {
      accessToken: string;
      expiresAt: number;
      configKey: string;
    }
  | undefined;

export function isGoogleCalendarEnabled(): boolean {
  const raw = (process.env["GOOGLE_CALENDAR_ENABLED"] ?? "").trim().toLowerCase();
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

export async function getAccessToken(config: CalendarConfig): Promise<string | null> {
  if (!isGoogleCalendarEnabled()) {
    return null;
  }

  const cacheKey = `${config.clientId}:${config.calendarId}`;
  const now = Date.now();

  if (cachedToken && cachedToken.configKey === cacheKey && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.accessToken;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token"
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn("[calendar] refresh_token_failed", { status: response.status, text });
      return null;
    }

    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      return null;
    }

    cachedToken = {
      accessToken: data.access_token,
      expiresAt: now + (data.expires_in ?? 3_000) * 1000,
      configKey: cacheKey
    };

    return data.access_token;
  } catch (error) {
    console.warn("[calendar] token_error", { error: String(error) });
    return null;
  }
}

function buildEventBody(
  payload: AppointmentCalendarPayload,
  config: CalendarConfig
): { start: DateTime; end: DateTime; bufferStart: DateTime; description: string; travelBufferMinutes: number; durationMinutes: number } | null {
  if (!payload.startAt) {
    return null;
  }

  const start = DateTime.fromJSDate(payload.startAt, { zone: "utc" }).setZone(config.timeZone);
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
    `Location: ${payload.property.addressLine1}, ${payload.property.city}, ${payload.property.state} ${payload.property.postalCode}`
  ].filter((line): line is string => Boolean(line));

  if (payload.notes) {
    lines.push("", `Notes: ${payload.notes}`);
  }

  if (payload.rescheduleUrl) {
    lines.push("", `Reschedule: ${payload.rescheduleUrl}`);
  }

  const description = lines.join("\n");

  return { start, end, bufferStart, description, travelBufferMinutes, durationMinutes };
}

async function googleRequest(
  config: CalendarConfig,
  accessToken: string,
  eventId: string | null,
  init: RequestInit
): Promise<Response | null> {
  const url =
    GOOGLE_API_BASE +
    `/calendars/${encodeURIComponent(config.calendarId)}/events` +
    (eventId ? `/${encodeURIComponent(eventId)}` : "");

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    console.warn("[calendar] request_error", { error: String(error) });
    return null;
  }
}

export async function createCalendarEvent(
  payload: AppointmentCalendarPayload
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

  const response = await googleRequest(config, accessToken, null, {
    method: "POST",
    body: JSON.stringify({
      summary: `Stonegate Junk Removal: ${payload.contact.name}`,
      description: eventBody.description,
      start: {
        dateTime: eventBody.bufferStart.toISO(),
        timeZone: config.timeZone
      },
      end: {
        dateTime: eventBody.end.toISO(),
        timeZone: config.timeZone
      },
      location: `${payload.property.addressLine1}, ${payload.property.city}, ${payload.property.state} ${payload.property.postalCode}`,
      extendedProperties: {
        private: {
          appointmentId: payload.appointmentId,
          travelBufferMinutes: String(eventBody.travelBufferMinutes),
          durationMinutes: String(eventBody.durationMinutes)
        }
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 24 * 60 },
          { method: "popup", minutes: 24 * 60 },
          { method: "popup", minutes: 2 * 60 }
        ]
      }
    })
  });

  if (!response) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.warn("[calendar] create_failed", { status: response.status, text });
    return null;
  }

  const data = (await response.json()) as { id?: string };
  return data.id ?? null;
}

export async function updateCalendarEvent(
  eventId: string,
  payload: AppointmentCalendarPayload
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
        timeZone: config.timeZone
      },
      end: {
        dateTime: eventBody.end.toISO(),
        timeZone: config.timeZone
      },
      location: `${payload.property.addressLine1}, ${payload.property.city}, ${payload.property.state} ${payload.property.postalCode}`,
      extendedProperties: {
        private: {
          appointmentId: payload.appointmentId,
          travelBufferMinutes: String(eventBody.travelBufferMinutes),
          durationMinutes: String(eventBody.durationMinutes)
        }
      }
    })
  });

  if (!response) {
    return false;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.warn("[calendar] update_failed", { status: response.status, text });
    return false;
  }

  return true;
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const config = getCalendarConfig();
  if (!config) {
    return;
  }

  const accessToken = await getAccessToken(config);
  if (!accessToken) {
    return;
  }

  const response = await googleRequest(config, accessToken, eventId, {
    method: "DELETE"
  });

  if (!response) {
    return;
  }

  if (!response.ok && response.status !== 404) {
    const text = await response.text().catch(() => "");
    console.warn("[calendar] delete_failed", { status: response.status, text });
  }
}



