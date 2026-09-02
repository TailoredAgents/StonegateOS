import {
  buildPartnerPortalOperationsReport,
  PARTNER_OPERATIONS_RANGE_DAYS,
} from "@/lib/partner-portal-operations-reporting";

describe("Partner Portal operations report", () => {
  test("builds bounded privacy-safe persona and reliability funnels", () => {
    const report = buildPartnerPortalOperationsReport({
      rangeDays: 7,
      generatedAt: new Date("2026-09-02T14:00:00.000Z"),
      rows: [
        { key: "booking_started:contractor", count: 10 },
        { key: "booking_submitted:contractor", count: 7 },
        { key: "booking_abandoned:contractor", count: 3 },
        { key: "availability_requested:contractor", count: 8 },
        { key: "availability_available:contractor", count: 6 },
        { key: "availability_slot_full:contractor", count: 2 },
        { key: "upload_started:property_manager", count: 4 },
        { key: "upload_completed:property_manager", count: 3 },
        { key: "upload_interrupted:property_manager", count: 1 },
        { key: "booking_started:user@example.com", count: 999 },
        { key: "private_notes:contractor", count: 999 },
      ],
    });

    expect(PARTNER_OPERATIONS_RANGE_DAYS).toEqual([1, 7, 14, 30]);
    expect(report.rates).toEqual({
      availabilitySuccessPercent: 75,
      slotFullPercent: 25,
      bookingCompletionPercent: 70,
      bookingAbandonmentPercent: 30,
      uploadCompletionPercent: 75,
    });
    expect(
      report.personas.find((item) => item.persona === "contractor"),
    ).toMatchObject({
      started: 10,
      submitted: 7,
      abandoned: 3,
    });
    expect(JSON.stringify(report)).not.toContain("user@example.com");
  });

  test("caps malformed/unsafe counts and never divides by zero", () => {
    const report = buildPartnerPortalOperationsReport({
      rangeDays: 1,
      generatedAt: new Date("2026-09-02T14:00:00.000Z"),
      rows: [
        { key: "booking_started:unknown", count: -4 },
        { key: "booking_submitted:unknown", count: Number.MAX_VALUE },
      ],
    });
    expect(report.rates.bookingCompletionPercent).toBeNull();
    expect(report.rates.bookingAbandonmentPercent).toBeNull();
  });

  test("saturates repeated long-lived aggregate rows at a safe integer", () => {
    const report = buildPartnerPortalOperationsReport({
      rangeDays: 30,
      generatedAt: new Date("2026-09-02T14:00:00.000Z"),
      rows: [
        {
          key: "booking_started:commercial_client",
          count: Number.MAX_SAFE_INTEGER,
        },
        { key: "booking_started:commercial_client", count: 10 },
      ],
    });
    expect(
      report.personas.find((item) => item.persona === "commercial_client")
        ?.started,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});
