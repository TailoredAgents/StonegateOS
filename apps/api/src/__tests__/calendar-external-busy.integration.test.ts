import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  calendarSyncState,
  closeDbForTests,
  getDb,
  scheduleBlocks,
} from "@/db";
import { syncGoogleCalendar } from "@/lib/calendar-sync";

const jest = import.meta.jest;

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;
const CALENDAR_ID = "calendar-external-busy-integration@example.test";
const SOURCE = "google_calendar_external_busy";
const EVENT_ID = "manual-busy-event";
const SOURCE_KEY = createHash("sha256")
  .update("google-calendar-external-busy\0", "utf8")
  .update(CALENDAR_ID, "utf8")
  .update("\0", "utf8")
  .update(EVENT_ID, "utf8")
  .digest("hex");

describeWithDatabase("Google Calendar external-busy persistence", () => {
  const originalEnvironment = {
    enabled: process.env["GOOGLE_CALENDAR_ENABLED"],
    clientId: process.env["GOOGLE_CLIENT_ID"],
    clientSecret: process.env["GOOGLE_CLIENT_SECRET"],
    refreshToken: process.env["GOOGLE_REFRESH_TOKEN"],
    calendarId: process.env["GOOGLE_CALENDAR_ID"],
    apiBase: process.env["GOOGLE_CALENDAR_API_BASE_URL"],
    tokenUrl: process.env["GOOGLE_CALENDAR_TOKEN_URL"],
    webhookUrl: process.env["GOOGLE_CALENDAR_WEBHOOK_URL"],
  };

  beforeAll(async () => {
    process.env["GOOGLE_CALENDAR_ENABLED"] = "true";
    process.env["GOOGLE_CLIENT_ID"] = "integration-client";
    process.env["GOOGLE_CLIENT_SECRET"] = "integration-secret";
    process.env["GOOGLE_REFRESH_TOKEN"] = "integration-refresh";
    process.env["GOOGLE_CALENDAR_ID"] = CALENDAR_ID;
    process.env["GOOGLE_CALENDAR_API_BASE_URL"] =
      "http://127.0.0.1:4012/calendar/v3";
    process.env["GOOGLE_CALENDAR_TOKEN_URL"] = "http://127.0.0.1:4012/token";
    delete process.env["GOOGLE_CALENDAR_WEBHOOK_URL"];
    const db = getDb();
    await db
      .delete(scheduleBlocks)
      .where(
        and(
          eq(scheduleBlocks.source, SOURCE),
          eq(scheduleBlocks.sourceKey, SOURCE_KEY),
        ),
      );
    await db
      .delete(calendarSyncState)
      .where(eq(calendarSyncState.calendarId, CALENDAR_ID));
  });

  afterAll(async () => {
    const db = getDb();
    await db
      .delete(scheduleBlocks)
      .where(
        and(
          eq(scheduleBlocks.source, SOURCE),
          eq(scheduleBlocks.sourceKey, SOURCE_KEY),
        ),
      );
    await db
      .delete(calendarSyncState)
      .where(eq(calendarSyncState.calendarId, CALENDAR_ID));
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("GOOGLE_CALENDAR_ENABLED", originalEnvironment.enabled);
    restore("GOOGLE_CLIENT_ID", originalEnvironment.clientId);
    restore("GOOGLE_CLIENT_SECRET", originalEnvironment.clientSecret);
    restore("GOOGLE_REFRESH_TOKEN", originalEnvironment.refreshToken);
    restore("GOOGLE_CALENDAR_ID", originalEnvironment.calendarId);
    restore("GOOGLE_CALENDAR_API_BASE_URL", originalEnvironment.apiBase);
    restore("GOOGLE_CALENDAR_TOKEN_URL", originalEnvironment.tokenUrl);
    restore("GOOGLE_CALENDAR_WEBHOOK_URL", originalEnvironment.webhookUrl);
    await closeDbForTests();
  });

  it("retains the last durable block and watermark when the next provider fetch fails", async () => {
    let providerFails = false;
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("/token")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: "test-token",
                expires_in: 3_600,
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
          );
        }
        if (providerFails) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "provider_error" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: EVENT_ID,
                  summary: "Must not persist",
                  start: { dateTime: "2026-09-02T09:00:00-04:00" },
                  end: { dateTime: "2026-09-02T10:00:00-04:00" },
                  updated: "2026-08-30T12:00:00.000Z",
                },
              ],
              nextSyncToken: "next-token-1",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      });

    try {
      const first = await syncGoogleCalendar({ forceResync: true });
      expect(first).toEqual(
        expect.objectContaining({
          ok: true,
          externalBusyUpserted: 1,
          externalBusyDeactivated: 0,
        }),
      );
      const db = getDb();
      const [beforeBlock] = await db
        .select()
        .from(scheduleBlocks)
        .where(eq(scheduleBlocks.sourceKey, SOURCE_KEY));
      const [beforeState] = await db
        .select()
        .from(calendarSyncState)
        .where(eq(calendarSyncState.calendarId, CALENDAR_ID));
      expect(beforeBlock).toEqual(
        expect.objectContaining({
          active: true,
          capacityPoolKey: "field_service",
        }),
      );
      expect(beforeBlock?.metadata).not.toHaveProperty("summary");
      expect(beforeState?.externalBusyCoverageSyncedAt).toBeInstanceOf(Date);

      providerFails = true;
      const second = await syncGoogleCalendar({ reason: "failure-test" });
      expect(second).toEqual(
        expect.objectContaining({ ok: false, reason: "google_error" }),
      );
      const [afterBlock] = await db
        .select()
        .from(scheduleBlocks)
        .where(eq(scheduleBlocks.sourceKey, SOURCE_KEY));
      const [afterState] = await db
        .select()
        .from(calendarSyncState)
        .where(eq(calendarSyncState.calendarId, CALENDAR_ID));
      expect(afterBlock?.active).toBe(true);
      expect(afterBlock?.updatedAt).toEqual(beforeBlock?.updatedAt);
      expect(afterState?.externalBusyCoverageSyncedAt).toEqual(
        beforeState?.externalBusyCoverageSyncedAt,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
