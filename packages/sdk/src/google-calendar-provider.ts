import { isControlledProviderTestRuntime } from "./provider-test-runtime";

export type GoogleCalendarProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type GoogleCalendarApiEndpoint =
  | { kind: "events"; calendarId: string }
  | { kind: "event"; calendarId: string; eventId: string }
  | { kind: "watch"; calendarId: string };

export const DEFAULT_GOOGLE_CALENDAR_API_BASE_URL =
  "https://www.googleapis.com/calendar/v3";
export const DEFAULT_GOOGLE_CALENDAR_TOKEN_URL =
  "https://oauth2.googleapis.com/token";

export type GoogleCalendarProviderEndpoints = {
  apiBaseUrl: URL;
  tokenUrl: URL;
};

export type GoogleCalendarTokenResponse = {
  accessToken: string;
  expiresInSeconds: number;
};

export type GoogleCalendarEventListResponse = {
  items: unknown[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Provider HTTP success is not application success. These parsers reject
 * empty or malformed 2xx payloads before a caller can claim an external
 * Calendar effect or silently convert unavailable data into an empty list.
 */
export function parseGoogleCalendarTokenResponse(
  value: unknown,
): GoogleCalendarTokenResponse | null {
  if (!isRecord(value)) return null;
  const accessToken = nonEmptyString(value["access_token"]);
  const rawExpiresIn = value["expires_in"];
  const expiresInSeconds =
    typeof rawExpiresIn === "number" &&
    Number.isFinite(rawExpiresIn) &&
    rawExpiresIn > 0
      ? Math.floor(rawExpiresIn)
      : 3_000;
  return accessToken ? { accessToken, expiresInSeconds } : null;
}

export function parseGoogleCalendarEventMutationResponse(
  value: unknown,
  expectedEventId?: string,
): { eventId: string } | null {
  if (!isRecord(value)) return null;
  const eventId = nonEmptyString(value["id"]);
  if (!eventId || (expectedEventId && eventId !== expectedEventId)) return null;
  return { eventId };
}

export function parseGoogleCalendarWatchResponse(
  value: unknown,
): { resourceId: string; expiration: string | null } | null {
  if (!isRecord(value)) return null;
  const resourceId = nonEmptyString(value["resourceId"]);
  const rawExpiration = value["expiration"];
  if (!resourceId) return null;
  if (
    rawExpiration !== undefined &&
    (typeof rawExpiration !== "string" || !/^\d{10,17}$/u.test(rawExpiration))
  ) {
    return null;
  }
  return {
    resourceId,
    expiration: typeof rawExpiration === "string" ? rawExpiration : null,
  };
}

export function parseGoogleCalendarEventListResponse(
  value: unknown,
): GoogleCalendarEventListResponse | null {
  if (!isRecord(value) || !Array.isArray(value["items"])) return null;
  const nextPageToken = value["nextPageToken"];
  const nextSyncToken = value["nextSyncToken"];
  if (
    (nextPageToken !== undefined && !nonEmptyString(nextPageToken)) ||
    (nextSyncToken !== undefined && !nonEmptyString(nextSyncToken))
  ) {
    return null;
  }
  return {
    items: value["items"],
    ...(typeof nextPageToken === "string"
      ? { nextPageToken: nextPageToken.trim() }
      : {}),
    ...(typeof nextSyncToken === "string"
      ? { nextSyncToken: nextSyncToken.trim() }
      : {}),
  };
}

export function isLoopbackGoogleProviderHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  ) {
    return true;
  }

  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every(
      (part) => /^\d{1,3}$/u.test(part) && Number.parseInt(part, 10) <= 255,
    )
  );
}

function parseProviderUrl(
  variableName: string,
  configured: string | undefined,
  fallback: string,
): URL {
  let url: URL;
  try {
    url = new URL(configured?.trim() || fallback);
  } catch {
    throw new Error(`${variableName} must be a valid absolute URL.`);
  }

  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${variableName} must not contain credentials, query parameters, or a fragment.`,
    );
  }
  return url;
}

function validateProviderUrl(
  variableName: string,
  url: URL,
  environment: GoogleCalendarProviderEnvironment,
): void {
  const loopback = isLoopbackGoogleProviderHostname(url.hostname);
  const production =
    environment["NODE_ENV"]?.trim().toLowerCase() === "production";
  const controlledTestMode = isControlledProviderTestRuntime(environment);

  if (production && loopback && !controlledTestMode) {
    throw new Error(
      `${variableName} cannot target a loopback host in production.`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      `${variableName} must use HTTPS unless it targets a loopback service.`,
    );
  }
  if (controlledTestMode && !loopback) {
    throw new Error(
      `${variableName} must target a loopback service during E2E or CRM audit runs.`,
    );
  }
}

export function getGoogleCalendarProviderEndpoints(
  environment: GoogleCalendarProviderEnvironment,
): GoogleCalendarProviderEndpoints {
  const apiBaseUrl = parseProviderUrl(
    "GOOGLE_CALENDAR_API_BASE_URL",
    environment["GOOGLE_CALENDAR_API_BASE_URL"],
    DEFAULT_GOOGLE_CALENDAR_API_BASE_URL,
  );
  const tokenUrl = parseProviderUrl(
    "GOOGLE_CALENDAR_TOKEN_URL",
    environment["GOOGLE_CALENDAR_TOKEN_URL"],
    DEFAULT_GOOGLE_CALENDAR_TOKEN_URL,
  );

  validateProviderUrl("GOOGLE_CALENDAR_API_BASE_URL", apiBaseUrl, environment);
  validateProviderUrl("GOOGLE_CALENDAR_TOKEN_URL", tokenUrl, environment);

  if (
    isControlledProviderTestRuntime(environment) &&
    apiBaseUrl.origin !== tokenUrl.origin
  ) {
    throw new Error(
      "GOOGLE_CALENDAR_API_BASE_URL and GOOGLE_CALENDAR_TOKEN_URL must share one loopback origin during E2E or CRM audit runs.",
    );
  }

  return { apiBaseUrl, tokenUrl };
}

function requiredIdentifier(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      `${name} is required to resolve a Google Calendar endpoint.`,
    );
  }
  return trimmed;
}

export function resolveGoogleCalendarApiEndpoint(
  endpoint: GoogleCalendarApiEndpoint,
  environment: GoogleCalendarProviderEnvironment,
  query?: URLSearchParams,
): string {
  const { apiBaseUrl } = getGoogleCalendarProviderEndpoints(environment);
  const calendarId = encodeURIComponent(
    requiredIdentifier("calendarId", endpoint.calendarId),
  );
  const basePath = apiBaseUrl.pathname.replace(/\/+$/u, "");
  let suffix = `/calendars/${calendarId}/events`;
  if (endpoint.kind === "event") {
    suffix += `/${encodeURIComponent(requiredIdentifier("eventId", endpoint.eventId))}`;
  } else if (endpoint.kind === "watch") {
    suffix += "/watch";
  }
  apiBaseUrl.pathname = `${basePath}${suffix}`.replace(/\/{2,}/gu, "/");
  apiBaseUrl.search = query?.toString() ?? "";
  return apiBaseUrl.toString();
}

export function resolveGoogleCalendarTokenEndpoint(
  environment: GoogleCalendarProviderEnvironment,
): string {
  return getGoogleCalendarProviderEndpoints(environment).tokenUrl.toString();
}
