import {
  DEFAULT_GOOGLE_CALENDAR_API_BASE_URL,
  DEFAULT_GOOGLE_CALENDAR_TOKEN_URL,
  getGoogleCalendarProviderEndpoints,
  parseGoogleCalendarEventListResponse,
  parseGoogleCalendarEventMutationResponse,
  parseGoogleCalendarTokenResponse,
  parseGoogleCalendarWatchResponse,
  resolveGoogleCalendarApiEndpoint,
  resolveGoogleCalendarTokenEndpoint,
} from "@myst-os/sdk";

const loopbackEnvironment = {
  E2E_RUN_ID: "calendar-audit",
  GOOGLE_CALENDAR_API_BASE_URL: "http://127.0.0.1:4012/calendar/v3",
  GOOGLE_CALENDAR_TOKEN_URL: "http://127.0.0.1:4012/token",
};

describe("Google Calendar provider endpoint safety", () => {
  it("preserves Google's HTTPS endpoints as the normal production default", () => {
    const endpoints = getGoogleCalendarProviderEndpoints({});
    expect(endpoints.apiBaseUrl.toString()).toBe(
      DEFAULT_GOOGLE_CALENDAR_API_BASE_URL,
    );
    expect(endpoints.tokenUrl.toString()).toBe(
      DEFAULT_GOOGLE_CALENDAR_TOKEN_URL,
    );
    expect(
      resolveGoogleCalendarApiEndpoint(
        { kind: "events", calendarId: "primary" },
        { NODE_ENV: "production" },
      ),
    ).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(resolveGoogleCalendarTokenEndpoint({ NODE_ENV: "production" })).toBe(
      "https://oauth2.googleapis.com/token",
    );
  });

  it("preserves configured API paths and safely encodes identifiers and query values", () => {
    const query = new URLSearchParams({
      timeMin: "2026-08-08T00:00:00.000Z",
      orderBy: "startTime",
    });
    const url = new URL(
      resolveGoogleCalendarApiEndpoint(
        {
          kind: "event",
          calendarId: "team/calendar@example.test",
          eventId: "event/id ?",
        },
        {
          GOOGLE_CALENDAR_API_BASE_URL:
            "https://gateway.example.test/google/calendar/v3/",
          GOOGLE_CALENDAR_TOKEN_URL: "https://auth.example.test/google/token",
        },
        query,
      ),
    );

    expect(url.origin).toBe("https://gateway.example.test");
    expect(url.pathname).toBe(
      "/google/calendar/v3/calendars/team%2Fcalendar%40example.test/events/event%2Fid%20%3F",
    );
    expect(url.searchParams.get("timeMin")).toBe("2026-08-08T00:00:00.000Z");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
  });

  it("resolves every active Calendar API operation through the same base", () => {
    expect(
      resolveGoogleCalendarApiEndpoint(
        { kind: "events", calendarId: "e2e" },
        loopbackEnvironment,
      ),
    ).toBe("http://127.0.0.1:4012/calendar/v3/calendars/e2e/events");
    expect(
      resolveGoogleCalendarApiEndpoint(
        { kind: "event", calendarId: "e2e", eventId: "event-1" },
        loopbackEnvironment,
      ),
    ).toBe("http://127.0.0.1:4012/calendar/v3/calendars/e2e/events/event-1");
    expect(
      resolveGoogleCalendarApiEndpoint(
        { kind: "watch", calendarId: "e2e" },
        loopbackEnvironment,
      ),
    ).toBe("http://127.0.0.1:4012/calendar/v3/calendars/e2e/events/watch");
    expect(resolveGoogleCalendarTokenEndpoint(loopbackEnvironment)).toBe(
      "http://127.0.0.1:4012/token",
    );
  });

  it.each([
    ["not a URL", "valid absolute URL"],
    ["ftp://provider.example/calendar/v3", "must use HTTPS"],
    ["http://provider.example/calendar/v3", "must use HTTPS"],
    [
      "https://user:secret@provider.example/calendar/v3",
      "must not contain credentials",
    ],
    ["https://provider.example/calendar/v3?secret=value", "query parameters"],
    ["https://provider.example/calendar/v3#fragment", "fragment"],
  ])("rejects unsafe Calendar API base %s", (baseUrl, message) => {
    expect(() =>
      getGoogleCalendarProviderEndpoints({
        GOOGLE_CALENDAR_API_BASE_URL: baseUrl,
      }),
    ).toThrow(message);
  });

  it.each([
    ["not a URL", "valid absolute URL"],
    ["http://provider.example/token", "must use HTTPS"],
    ["https://user:secret@provider.example/token", "credentials"],
    ["https://provider.example/token?secret=value", "query parameters"],
  ])("rejects unsafe OAuth token endpoint %s", (tokenUrl, message) => {
    expect(() =>
      getGoogleCalendarProviderEndpoints({
        GOOGLE_CALENDAR_TOKEN_URL: tokenUrl,
      }),
    ).toThrow(message);
  });

  it("allows HTTP only for loopback development and E2E providers", () => {
    expect(
      getGoogleCalendarProviderEndpoints(loopbackEnvironment).apiBaseUrl.origin,
    ).toBe("http://127.0.0.1:4012");
    expect(() =>
      getGoogleCalendarProviderEndpoints({
        GOOGLE_CALENDAR_API_BASE_URL:
          "http://google-calendar-fake:4012/calendar/v3",
        GOOGLE_CALENDAR_TOKEN_URL: "http://google-calendar-fake:4012/token",
      }),
    ).toThrow("must use HTTPS");
  });

  it("rejects every loopback provider endpoint in production", () => {
    expect(() =>
      getGoogleCalendarProviderEndpoints({
        ...loopbackEnvironment,
        E2E_RUN_ID: undefined,
        NODE_ENV: "production",
      }),
    ).toThrow("cannot target a loopback host in production");
  });

  it("allows loopback endpoints for a controlled production-build E2E run", () => {
    const endpoints = getGoogleCalendarProviderEndpoints({
      ...loopbackEnvironment,
      NODE_ENV: "production",
      TEAM_CRM_AUDIT_MODE: "1",
    });
    expect(endpoints.apiBaseUrl.origin).toBe("http://127.0.0.1:4012");
    expect(endpoints.tokenUrl.origin).toBe("http://127.0.0.1:4012");
  });

  it.each([
    { E2E_RUN_ID: "production-build-audit" },
    { TEAM_CRM_AUDIT_MODE: "1" },
    {
      E2E_RUN_ID: "production-build-audit",
      TEAM_CRM_AUDIT_MODE: "true",
    },
  ])("rejects a partial production-build sentinel %j", (sentinels) => {
    expect(() =>
      getGoogleCalendarProviderEndpoints({
        NODE_ENV: "production",
        ...sentinels,
      }),
    ).toThrow("Production provider-test runtime requires both");
  });

  it("fails closed unless both E2E endpoints are loopback and share one origin", () => {
    expect(() =>
      getGoogleCalendarProviderEndpoints({ E2E_RUN_ID: "calendar-audit" }),
    ).toThrow("must target a loopback service");
    expect(() =>
      getGoogleCalendarProviderEndpoints({
        ...loopbackEnvironment,
        GOOGLE_CALENDAR_TOKEN_URL: "http://127.0.0.1:4999/token",
      }),
    ).toThrow("must share one loopback origin");
  });

  it("rejects empty Calendar and event identifiers before building a URL", () => {
    expect(() =>
      resolveGoogleCalendarApiEndpoint(
        { kind: "events", calendarId: " " },
        loopbackEnvironment,
      ),
    ).toThrow("calendarId is required");
    expect(() =>
      resolveGoogleCalendarApiEndpoint(
        { kind: "event", calendarId: "e2e", eventId: "" },
        loopbackEnvironment,
      ),
    ).toThrow("eventId is required");
  });

  it("requires typed provider evidence before treating a 2xx response as success", () => {
    expect(parseGoogleCalendarTokenResponse({})).toBeNull();
    expect(
      parseGoogleCalendarTokenResponse({
        access_token: " access-token ",
        expires_in: 3600,
      }),
    ).toEqual({ accessToken: "access-token", expiresInSeconds: 3600 });

    expect(parseGoogleCalendarEventMutationResponse({})).toBeNull();
    expect(
      parseGoogleCalendarEventMutationResponse({ id: "event-1" }, "event-2"),
    ).toBeNull();
    expect(
      parseGoogleCalendarEventMutationResponse({ id: "event-1" }, "event-1"),
    ).toEqual({ eventId: "event-1" });

    expect(parseGoogleCalendarWatchResponse({})).toBeNull();
    expect(
      parseGoogleCalendarWatchResponse({
        resourceId: "resource-1",
        expiration: "1786204800000",
      }),
    ).toEqual({
      resourceId: "resource-1",
      expiration: "1786204800000",
    });

    expect(parseGoogleCalendarEventListResponse({})).toBeNull();
    expect(
      parseGoogleCalendarEventListResponse({ items: [], nextPageToken: 42 }),
    ).toBeNull();
    expect(
      parseGoogleCalendarEventListResponse({
        items: [],
        nextSyncToken: "sync-1",
      }),
    ).toEqual({ items: [], nextSyncToken: "sync-1" });
  });
});
