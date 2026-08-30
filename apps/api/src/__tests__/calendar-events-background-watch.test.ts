import type { AppointmentCalendarPayload } from "@/lib/calendar";

const mockCreateCalendarEvent = jest.fn();
const mockUpdateCalendarEvent = jest.fn();
const mockEnsureCalendarWatch = jest.fn();
const mockRecordProviderFailure = jest.fn();
const mockRecordProviderSuccess = jest.fn();

jest.mock("@/lib/calendar", () => ({
  createCalendarEvent: mockCreateCalendarEvent,
  isGoogleCalendarEnabled: () => true,
  updateCalendarEvent: mockUpdateCalendarEvent,
}));

jest.mock("@/lib/calendar-sync", () => ({
  ensureCalendarWatch: mockEnsureCalendarWatch,
}));

jest.mock("@/lib/provider-health", () => ({
  recordProviderFailure: mockRecordProviderFailure,
  recordProviderSuccess: mockRecordProviderSuccess,
}));

import {
  createCalendarEventWithRetry,
  updateCalendarEventWithRetry,
} from "@/lib/calendar-events";

const payload: AppointmentCalendarPayload = {
  appointmentId: "appointment-1",
  startAt: new Date("2026-08-30T14:00:00.000Z"),
  durationMinutes: 60,
  travelBufferMinutes: 15,
  services: ["Junk removal"],
  contact: { name: "Test Customer" },
  property: {
    addressLine1: "1 Main Street",
    city: "Buffalo",
    state: "NY",
    postalCode: "14201",
  },
};

async function flushBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("calendar event background watch registration", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockCreateCalendarEvent.mockResolvedValue("calendar-event-1");
    mockUpdateCalendarEvent.mockResolvedValue(true);
    mockRecordProviderFailure.mockResolvedValue(undefined);
    mockRecordProviderSuccess.mockResolvedValue(undefined);
    mockEnsureCalendarWatch.mockRejectedValue(
      new Error("watch endpoint unavailable"),
    );
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("contains watch-registration rejection after a successful create", async () => {
    await expect(
      createCalendarEventWithRetry(payload, { attempts: 1, delayMs: 0 }),
    ).resolves.toBe("calendar-event-1");
    await flushBackgroundWork();

    expect(mockEnsureCalendarWatch).toHaveBeenCalledTimes(1);
    expect(mockRecordProviderSuccess).toHaveBeenCalledWith("calendar");
    expect(warn).toHaveBeenCalledWith("[calendar] ensure_watch_failed", {
      error: "watch endpoint unavailable",
    });
  });

  it("contains watch-registration rejection after a successful update", async () => {
    await expect(
      updateCalendarEventWithRetry("calendar-event-1", payload, {
        attempts: 1,
        delayMs: 0,
      }),
    ).resolves.toBe(true);
    await flushBackgroundWork();

    expect(mockEnsureCalendarWatch).toHaveBeenCalledTimes(1);
    expect(mockRecordProviderSuccess).toHaveBeenCalledWith("calendar");
    expect(warn).toHaveBeenCalledWith("[calendar] ensure_watch_failed", {
      error: "watch endpoint unavailable",
    });
  });
});
