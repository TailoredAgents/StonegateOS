import {
  addCalendarDays,
  calendarDayStartUtc,
  getCalendarUtcRange,
  normalizeCalendarDayKey,
  resolveCalendarDefaultView,
} from "../../../site/src/app/team/lib/calendar-time";
import {
  resolveEasternAppointmentTime,
  resolveEasternDayBoundary,
} from "@/lib/appointment-time";

describe("Calendar Eastern-time integrity", () => {
  it("uses exact local-midnight bounds on the 23-hour spring DST day", () => {
    const range = getCalendarUtcRange("2026-03-08", "day");

    expect(range?.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(range?.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect((range!.end.getTime() - range!.start.getTime()) / 3_600_000).toBe(
      23,
    );
  });

  it("uses exact local-midnight bounds on the 25-hour fall DST day", () => {
    const range = getCalendarUtcRange("2026-11-01", "day");

    expect(range?.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(range?.end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect((range!.end.getTime() - range!.start.getTime()) / 3_600_000).toBe(
      25,
    );
  });

  it("advances date-only navigation without fixed-duration DST drift", () => {
    expect(addCalendarDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addCalendarDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(calendarDayStartUtc("2026-03-09")?.toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
  });

  it("rejects impossible date keys instead of silently rolling them over", () => {
    expect(normalizeCalendarDayKey("2026-02-29")).toBeNull();
    expect(getCalendarUtcRange("not-a-date", "week")).toBeNull();
  });

  it("defaults crew to Day and planning roles to Week", () => {
    expect(resolveCalendarDefaultView("crew")).toBe("day");
    expect(resolveCalendarDefaultView(" CREW ")).toBe("day");
    expect(resolveCalendarDefaultView("owner")).toBe("week");
    expect(resolveCalendarDefaultView("sales")).toBe("week");
    expect(resolveCalendarDefaultView(null)).toBe("week");
  });
});

describe("Appointment wall-clock DST validation", () => {
  it("converts an ordinary Eastern wall-clock time deterministically", () => {
    const result = resolveEasternAppointmentTime("2026-07-15", "09:30");
    expect(result).toEqual({
      ok: true,
      value: new Date("2026-07-15T13:30:00.000Z"),
    });
  });

  it("rejects the nonexistent spring-forward hour", () => {
    expect(resolveEasternAppointmentTime("2026-03-08", "02:30")).toMatchObject({
      ok: false,
      code: "invalid_start_time",
    });
  });

  it("rejects the repeated fall-back hour instead of guessing an offset", () => {
    expect(resolveEasternAppointmentTime("2026-11-01", "01:30")).toMatchObject({
      ok: false,
      code: "ambiguous_start_time",
    });
  });

  it("maps Google all-day boundaries to Eastern midnight across DST", () => {
    expect(resolveEasternDayBoundary("2026-03-08")).toEqual({
      ok: true,
      value: new Date("2026-03-08T05:00:00.000Z"),
    });
    expect(resolveEasternDayBoundary("2026-03-09")).toEqual({
      ok: true,
      value: new Date("2026-03-09T04:00:00.000Z"),
    });
  });
});
