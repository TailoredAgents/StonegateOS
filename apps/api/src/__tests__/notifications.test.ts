import { formatAppointmentArrivalWindow } from "@/lib/notifications";

describe("notification appointment windows", () => {
  it("formats the selected appointment start as a 30 minute arrival window", () => {
    const startAt = new Date("2026-04-23T14:00:00.000Z");

    expect(
      formatAppointmentArrivalWindow(startAt, 30, "America/New_York"),
    ).toBe("Apr 23, 2026, 10:00 AM - 10:30 AM");
  });

  it("includes both dates when the window crosses midnight", () => {
    const startAt = new Date("2026-04-24T03:45:00.000Z");

    expect(
      formatAppointmentArrivalWindow(startAt, 30, "America/New_York"),
    ).toBe("Apr 23, 2026, 11:45 PM - Apr 24, 2026, 12:15 AM");
  });
});
