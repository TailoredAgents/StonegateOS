import {
  getEarliestAfterHoursBookingStart,
  isAfterHoursAutonomyActive,
  validateAutonomousBookingStart,
} from "@/lib/after-hours-autonomy";

const timezone = "America/New_York";

describe("after-hours autonomy rules", () => {
  it("activates at 6:30 PM and stops at 7:30 AM on weekdays", () => {
    expect(isAfterHoursAutonomyActive({ at: "2026-06-15T18:29:00-04:00", timezone })).toBe(false);
    expect(isAfterHoursAutonomyActive({ at: "2026-06-15T18:30:00-04:00", timezone })).toBe(true);
    expect(isAfterHoursAutonomyActive({ at: "2026-06-16T07:29:00-04:00", timezone })).toBe(true);
    expect(isAfterHoursAutonomyActive({ at: "2026-06-16T07:30:00-04:00", timezone })).toBe(false);
  });

  it("is active all Sunday", () => {
    expect(isAfterHoursAutonomyActive({ at: "2026-06-14T12:00:00-04:00", timezone })).toBe(true);
  });

  it("blocks Sunday appointments", () => {
    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-14T12:00:00-04:00",
        city: "Woodstock",
        timezone,
      }),
    ).toMatchObject({ ok: false, code: "sunday_blocked" });
  });

  it("allows normal weekday starts through 4:30 PM", () => {
    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-15T16:30:00-04:00",
        city: "Marietta",
        timezone,
      }),
    ).toEqual({ ok: true });
  });

  it("only allows 5:30 PM starts in approved close cities", () => {
    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-15T17:30:00-04:00",
        city: "Marietta",
        timezone,
      }),
    ).toMatchObject({ ok: false, code: "late_city_required" });

    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-15T17:30:00-04:00",
        city: "Kennesaw",
        timezone,
      }),
    ).toEqual({ ok: true });
  });

  it("allows Saturday 1 PM but blocks 2 PM starts", () => {
    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-20T13:00:00-04:00",
        city: "Woodstock",
        timezone,
      }),
    ).toEqual({ ok: true });

    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-20T14:00:00-04:00",
        city: "Woodstock",
        timezone,
      }),
    ).toMatchObject({ ok: false, code: "outside_booking_hours" });
  });

  it("requires 10 AM or later for bookings made by the night agent", () => {
    expect(getEarliestAfterHoursBookingStart({ conversationAt: "2026-06-15T20:00:00-04:00", timezone }).toISOString()).toBe(
      "2026-06-16T14:00:00.000Z",
    );

    expect(
      validateAutonomousBookingStart({
        startAt: "2026-06-16T09:00:00-04:00",
        conversationAt: "2026-06-15T20:00:00-04:00",
        city: "Woodstock",
        timezone,
      }),
    ).toMatchObject({ ok: false, code: "night_minimum_start" });
  });
});
