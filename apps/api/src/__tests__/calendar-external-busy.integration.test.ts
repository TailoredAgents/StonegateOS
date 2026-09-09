import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  calendarSyncState,
  closeDbForTests,
  getDb,
  scheduleBlocks,
  appointments,
  contacts,
  partnerAccounts,
  scheduleResourcePools,
  scheduleResources,
  properties,
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

  it("rolls back unsafe Google moves after shared weighted validation, disables instant coverage, and preserves partner promises", async () => {
    const db = getDb();
    const contactId = randomUUID(),
      accountId = randomUUID(),
      ordinaryId = randomUUID(),
      partnerId = randomUUID();
    const propertyId = randomUUID();
    const poolKey = `calendar_test_${randomUUID().replaceAll("-", "")}`;
    const originalStart = new Date("2035-12-12T14:00:00Z"),
      partnerStart = new Date("2035-12-12T18:00:00Z");
    await db.insert(partnerAccounts).values({
      id: accountId,
      name: "Disposable calendar partner",
      normalizedName: accountId,
    });
    await db.insert(contacts).values({
      id: contactId,
      firstName: "Calendar",
      lastName: "Integration",
    });
    await db.insert(properties).values({
      id: propertyId,
      contactId,
      addressLine1: "1 Local Calendar Way",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    });
    await db.insert(scheduleResourcePools).values({
      key: poolKey,
      label: "Disposable calendar capacity",
      capacityUnits: 2,
    });
    await db.insert(appointments).values([
      {
        id: ordinaryId,
        contactId,
        propertyId,
        type: "job",
        status: "confirmed",
        startAt: originalStart,
        durationMinutes: 60,
        travelBufferMinutes: 0,
        capacityPoolKey: poolKey,
        capacityUnits: 1,
        rescheduleToken: randomUUID(),
      },
      {
        id: partnerId,
        contactId,
        propertyId,
        partnerAccountId: accountId,
        type: "job",
        status: "confirmed",
        startAt: partnerStart,
        durationMinutes: 60,
        travelBufferMinutes: 0,
        capacityPoolKey: poolKey,
        capacityUnits: 2,
        rescheduleToken: randomUUID(),
      },
    ]);
    let event: Record<string, unknown> = {
      id: "ordinary-mirror",
      start: { dateTime: partnerStart.toISOString() },
      end: { dateTime: "2035-12-12T19:00:00Z" },
      extendedProperties: {
        private: {
          appointmentId: ordinaryId,
          travelBufferMinutes: "0",
          durationMinutes: "60",
        },
      },
    };
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const body = url.includes("/token")
          ? { access_token: "test-token", expires_in: 3600 }
          : { items: [event], nextSyncToken: "guarded-calendar-token" };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      });
    try {
      const [beforeBlock] = await db
        .select()
        .from(scheduleBlocks)
        .where(eq(scheduleBlocks.sourceKey, SOURCE_KEY));
      expect(await syncGoogleCalendar({ forceResync: true })).toMatchObject({
        ok: false,
        reason: "schedule_conflict",
      });
      const [unchanged] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, ordinaryId));
      const [invalidated] = await db
        .select()
        .from(calendarSyncState)
        .where(eq(calendarSyncState.calendarId, CALENDAR_ID));
      const [retainedBlock] = await db
        .select()
        .from(scheduleBlocks)
        .where(eq(scheduleBlocks.sourceKey, SOURCE_KEY));
      expect(unchanged!.startAt).toEqual(originalStart);
      expect(invalidated!.externalBusyCoverageSyncedAt).toBeNull();
      expect(retainedBlock?.active).toBe(beforeBlock?.active);
      expect(retainedBlock?.updatedAt).toEqual(beforeBlock?.updatedAt);

      event = {
        ...event,
        start: { dateTime: "2035-12-12T20:00:00Z" },
        end: { dateTime: "2035-12-12T21:00:00Z" },
      };
      expect(await syncGoogleCalendar({ forceResync: true })).toMatchObject({
        ok: true,
        updated: 1,
      });
      const [moved] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, ordinaryId));
      expect(moved!.startAt!.toISOString()).toBe("2035-12-12T20:00:00.000Z");

      for (const remote of [
        {
          start: { dateTime: "2035-12-12T22:00:00Z" },
          end: { dateTime: "2035-12-12T23:00:00Z" },
        },
        { status: "cancelled" },
      ]) {
        event = {
          id: "partner-mirror",
          ...remote,
          extendedProperties: { private: { appointmentId: partnerId } },
        };
        expect(await syncGoogleCalendar({ forceResync: true })).toMatchObject({
          ok: false,
          reason: "partner_mirror_drift",
        });
        const [preserved] = await db
          .select()
          .from(appointments)
          .where(eq(appointments.id, partnerId));
        const [state] = await db
          .select()
          .from(calendarSyncState)
          .where(eq(calendarSyncState.calendarId, CALENDAR_ID));
        expect(preserved).toMatchObject({
          status: "confirmed",
          startAt: partnerStart,
          durationMinutes: 60,
          capacityUnits: 2,
        });
        expect(state!.externalBusyCoverageSyncedAt).toBeNull();
      }
    } finally {
      fetchMock.mockRestore();
      await db
        .delete(appointments)
        .where(inArray(appointments.id, [ordinaryId, partnerId]));
      await db.delete(properties).where(eq(properties.id, propertyId));
      // Contact retention guards also apply in the disposable database.
      const deletedAt = new Date();
      await db
        .update(contacts)
        .set({
          deletedAt,
          purgeEligibleAt: new Date(deletedAt.getTime() + 30 * 86_400_000),
        })
        .where(eq(contacts.id, contactId));
      await db.delete(partnerAccounts).where(eq(partnerAccounts.id, accountId));
      await db
        .delete(scheduleResources)
        .where(eq(scheduleResources.capacityPoolKey, poolKey));
      await db
        .delete(scheduleResourcePools)
        .where(eq(scheduleResourcePools.key, poolKey));
    }
  });
});
