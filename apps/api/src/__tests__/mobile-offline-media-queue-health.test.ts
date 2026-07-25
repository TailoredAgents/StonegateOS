import {
  MAX_OFFLINE_MEDIA_QUEUE_COUNT,
  parseMobileOfflineMediaQueueHealthReport,
  parseTeamMemberActorId,
} from "@/lib/mobile-offline-media-queue-health";

const NOW = new Date("2026-07-24T16:00:00.000Z");
const DEVICE_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

describe("mobile offline media queue health validation", () => {
  it("accepts a bounded metadata-only queue report", () => {
    expect(
      parseMobileOfflineMediaQueueHealthReport(
        {
          deviceId: DEVICE_ID,
          queuedCount: 3,
          failedCount: 1,
          oldestQueuedAt: "2026-07-23T12:00:00.000Z",
          reportedAt: "2026-07-24T15:59:00.000Z",
        },
        NOW,
      ),
    ).toEqual({
      ok: true,
      report: {
        deviceId: DEVICE_ID.toLowerCase(),
        queuedCount: 3,
        failedCount: 1,
        oldestQueuedAt: new Date("2026-07-23T12:00:00.000Z"),
        reportedAt: new Date("2026-07-24T15:59:00.000Z"),
      },
    });
  });

  it("clears failure and oldest state whenever the queue is empty", () => {
    expect(
      parseMobileOfflineMediaQueueHealthReport(
        {
          deviceId: DEVICE_ID,
          queuedCount: 0,
          failedCount: 8,
          oldestQueuedAt: "2026-07-20T12:00:00.000Z",
          reportedAt: "2026-07-24T15:59:00.000Z",
        },
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      report: {
        queuedCount: 0,
        failedCount: 0,
        oldestQueuedAt: null,
      },
    });
  });

  it("rejects unbounded counts and inconsistent nonempty queues", () => {
    const shared = {
      deviceId: DEVICE_ID,
      oldestQueuedAt: "2026-07-23T12:00:00.000Z",
      reportedAt: "2026-07-24T15:59:00.000Z",
    };
    expect(
      parseMobileOfflineMediaQueueHealthReport(
        {
          ...shared,
          queuedCount: MAX_OFFLINE_MEDIA_QUEUE_COUNT + 1,
          failedCount: 0,
        },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      parseMobileOfflineMediaQueueHealthReport(
        {
          ...shared,
          queuedCount: 2,
          failedCount: 3,
        },
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "failed_count_exceeds_queue" }],
    });
    expect(
      parseMobileOfflineMediaQueueHealthReport(
        {
          ...shared,
          queuedCount: 2,
          failedCount: 0,
          oldestQueuedAt: null,
        },
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "oldest_timestamp_required" }],
    });
  });

  it("rejects stale/future reports and future queue timestamps", () => {
    const base = {
      deviceId: DEVICE_ID,
      queuedCount: 1,
      failedCount: 0,
      oldestQueuedAt: "2026-07-23T12:00:00.000Z",
    };
    expect(
      parseMobileOfflineMediaQueueHealthReport(
        {
          ...base,
          reportedAt: "2026-07-10T12:00:00.000Z",
        },
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "reportedAt", code: "timestamp_out_of_range" }],
    });
    expect(
      parseMobileOfflineMediaQueueHealthReport(
        {
          ...base,
          oldestQueuedAt: "2026-07-25T12:00:00.000Z",
          reportedAt: "2026-07-24T16:00:00.000Z",
        },
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "oldestQueuedAt", code: "timestamp_out_of_range" }],
    });
  });

  it("rejects photo, blob, filename, and other undeclared fields", () => {
    for (const extra of [
      { filename: "customer.jpg" },
      { blob: "data:image/jpeg;base64,abc" },
      { photos: [] },
    ]) {
      expect(
        parseMobileOfflineMediaQueueHealthReport(
          {
            deviceId: DEVICE_ID,
            queuedCount: 0,
            failedCount: 0,
            oldestQueuedAt: null,
            reportedAt: "2026-07-24T16:00:00.000Z",
            ...extra,
          },
          NOW,
        ).ok,
      ).toBe(false);
    }
  });

  it("accepts only a UUID actor identity", () => {
    expect(parseTeamMemberActorId(DEVICE_ID)).toBe(DEVICE_ID.toLowerCase());
    expect(parseTeamMemberActorId("owner")).toBeNull();
    expect(parseTeamMemberActorId(null)).toBeNull();
  });
});
