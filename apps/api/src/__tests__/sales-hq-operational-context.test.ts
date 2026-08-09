import {
  buildSalesHqSlaContext,
  salesHqAutomationModeLabel,
  salesHqDraftAgeMinutes,
} from "@/lib/sales-hq-operational-context";

describe("Sales HQ operational context", () => {
  it("describes overdue, urgent, on-track, and unscheduled SLA states", () => {
    expect(
      buildSalesHqSlaContext({
        dueAt: "2026-08-08T12:00:00.000Z",
        overdue: true,
        minutesUntilDue: -8,
      }),
    ).toEqual({ state: "overdue", label: "Overdue by 8 minutes" });
    expect(
      buildSalesHqSlaContext({
        dueAt: "2026-08-08T12:08:00.000Z",
        overdue: false,
        minutesUntilDue: 8,
      }),
    ).toEqual({ state: "due_soon", label: "Due in 8 minutes" });
    expect(
      buildSalesHqSlaContext({
        dueAt: "2026-08-08T13:00:00.000Z",
        overdue: false,
        minutesUntilDue: 60,
      }),
    ).toEqual({ state: "on_track", label: "Due in 60 minutes" });
    expect(
      buildSalesHqSlaContext({
        dueAt: null,
        overdue: false,
        minutesUntilDue: null,
      }),
    ).toEqual({ state: "unscheduled", label: "No SLA deadline" });
  });

  it("uses public automation names without leaking storage vocabulary", () => {
    expect(salesHqAutomationModeLabel("off")).toBe("Off");
    expect(salesHqAutomationModeLabel("partial")).toBe("Assist");
    expect(salesHqAutomationModeLabel("full")).toBe("Automatic");
  });

  it("reports deterministic non-negative draft ages", () => {
    const now = new Date("2026-08-08T12:00:00.000Z");
    expect(
      salesHqDraftAgeMinutes(new Date("2026-08-08T10:29:30.000Z"), now),
    ).toBe(90);
    expect(
      salesHqDraftAgeMinutes(new Date("2026-08-08T12:01:00.000Z"), now),
    ).toBe(0);
    expect(salesHqDraftAgeMinutes(null, now)).toBeNull();
  });
});
