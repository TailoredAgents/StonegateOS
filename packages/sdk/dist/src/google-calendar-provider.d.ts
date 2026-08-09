export type GoogleCalendarProviderEnvironment = Readonly<Record<string, string | undefined>>;
export type GoogleCalendarApiEndpoint = {
    kind: "events";
    calendarId: string;
} | {
    kind: "event";
    calendarId: string;
    eventId: string;
} | {
    kind: "watch";
    calendarId: string;
};
export declare const DEFAULT_GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";
export declare const DEFAULT_GOOGLE_CALENDAR_TOKEN_URL = "https://oauth2.googleapis.com/token";
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
/**
 * Provider HTTP success is not application success. These parsers reject
 * empty or malformed 2xx payloads before a caller can claim an external
 * Calendar effect or silently convert unavailable data into an empty list.
 */
export declare function parseGoogleCalendarTokenResponse(value: unknown): GoogleCalendarTokenResponse | null;
export declare function parseGoogleCalendarEventMutationResponse(value: unknown, expectedEventId?: string): {
    eventId: string;
} | null;
export declare function parseGoogleCalendarWatchResponse(value: unknown): {
    resourceId: string;
    expiration: string | null;
} | null;
export declare function parseGoogleCalendarEventListResponse(value: unknown): GoogleCalendarEventListResponse | null;
export declare function isLoopbackGoogleProviderHostname(hostname: string): boolean;
export declare function getGoogleCalendarProviderEndpoints(environment: GoogleCalendarProviderEnvironment): GoogleCalendarProviderEndpoints;
export declare function resolveGoogleCalendarApiEndpoint(endpoint: GoogleCalendarApiEndpoint, environment: GoogleCalendarProviderEnvironment, query?: URLSearchParams): string;
export declare function resolveGoogleCalendarTokenEndpoint(environment: GoogleCalendarProviderEnvironment): string;
//# sourceMappingURL=google-calendar-provider.d.ts.map