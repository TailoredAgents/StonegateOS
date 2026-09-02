import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  planGoogleExternalBusyBlocks,
  type GoogleCalendarEvent,
} from "@/lib/calendar-sync";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
}

const BASE_INPUT = {
  calendarId: "operations@example.test",
  timeZone: "America/New_York",
  capacityPoolKey: "field_service",
  capacityUnits: 1,
} as const;

describe("Google Calendar external-busy safety", () => {
  it("imports only unmatched opaque busy events and minimizes persisted metadata", () => {
    const events: GoogleCalendarEvent[] = [
      {
        id: "manual-timed",
        start: { dateTime: "2026-09-01T09:00:00-04:00" },
        end: { dateTime: "2026-09-01T10:00:00-04:00" },
        summary: "Private customer name",
        description: "Private access details",
        updated: "2026-08-30T12:00:00.000Z",
      },
      {
        id: "manual-all-day",
        start: { date: "2026-11-01" },
        end: { date: "2026-11-02" },
      },
      {
        id: "stonegate-mirror",
        start: { dateTime: "2026-09-01T11:00:00-04:00" },
        end: { dateTime: "2026-09-01T12:00:00-04:00" },
      },
      { id: "canceled", status: "cancelled" },
      { id: "transparent", transparency: "transparent" },
      { id: "working-location", eventType: "workingLocation" },
    ];

    const plan = planGoogleExternalBusyBlocks({
      ...BASE_INPUT,
      events,
      mirroredEventIds: new Set(["stonegate-mirror"]),
    });

    expect(plan.invalidBusyEventCount).toBe(0);
    expect(plan.seenSourceKeys).toHaveLength(events.length);
    expect(plan.activeBlocks).toHaveLength(2);
    expect(
      plan.activeBlocks.every((block) => block.sourceKey.length === 64),
    ).toBe(true);
    expect(plan.activeBlocks[0]?.metadata).not.toHaveProperty("summary");
    expect(plan.activeBlocks[0]?.metadata).not.toHaveProperty("description");

    const allDay = plan.activeBlocks.find(
      (block) => block.metadata["allDay"] === true,
    );
    expect(allDay?.startAt.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(allDay?.endAt.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("deduplicates provider changes by event id and lets the latest cancellation win", () => {
    const plan = planGoogleExternalBusyBlocks({
      ...BASE_INPUT,
      mirroredEventIds: [],
      events: [
        {
          id: "same-event",
          start: { dateTime: "2026-09-01T09:00:00Z" },
          end: { dateTime: "2026-09-01T10:00:00Z" },
        },
        { id: "same-event", status: "cancelled" },
      ],
    });

    expect(plan.seenSourceKeys).toHaveLength(1);
    expect(plan.activeBlocks).toEqual([]);
    expect(plan.invalidBusyEventCount).toBe(0);
  });

  it("rejects an opaque busy event without a trustworthy interval", () => {
    const plan = planGoogleExternalBusyBlocks({
      ...BASE_INPUT,
      mirroredEventIds: [],
      events: [
        {
          id: "missing-end",
          start: { dateTime: "2026-09-01T09:00:00Z" },
        },
      ],
    });

    expect(plan.activeBlocks).toEqual([]);
    expect(plan.invalidBusyEventCount).toBe(1);
  });

  it("persists blocks and coverage atomically behind the global schedule lock", () => {
    const sync = source("apps/api/src/lib/calendar-sync.ts");
    const transaction = sync.indexOf("db.transaction(async (tx)");
    const lock = sync.indexOf("acquireScheduleConflictLock(tx)", transaction);
    const reconcile = sync.indexOf("reconcileExternalBusyBlocks(tx", lock);
    const watermark = sync.indexOf("externalBusyCoverageSyncedAt", reconcile);
    expect(transaction).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(transaction);
    expect(reconcile).toBeGreaterThan(lock);
    expect(watermark).toBeGreaterThan(reconcile);
    expect(sync.indexOf("if (!complete)")).toBeLessThan(transaction);
    expect(sync).toContain('params.set("singleEvents", "true")');
    expect(sync).toContain('params.set("timeMax", options.timeMax)');

    const migration = source(
      "apps/api/src/db/migrations/0113_partner_calendar_external_busy_coverage.sql",
    );
    expect(migration).toContain('"external_busy_coverage_synced_at"');
  });

  it("retires raw-appointment cancellation and serializes V2 job cancellation", () => {
    const legacyRoute = source(
      "apps/api/app/api/portal/bookings/[appointmentId]/cancel/route.ts",
    );
    const route = source(
      "apps/api/app/api/portal/v2/jobs/[jobId]/cancel/route.ts",
    );
    expect(legacyRoute).toContain('error: "legacy_route_retired"');
    expect(legacyRoute).not.toContain("partnerUsers.phoneE164");
    expect(route).toContain("acquireScheduleConflictLock(tx)");
    expect(route).toContain("createPartnerJobAccessCondition(principal, jobId)");
    expect(route).toContain('type: "appointment.calendar_sync_requested"');
  });
});
