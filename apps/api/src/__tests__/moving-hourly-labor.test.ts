import {
  calculateHourlyLaborCents,
  CompletionCrewMembersSchema,
  hasValidCrewCompensationMode,
  isMovingCommissionJob,
  normalizeCompletionCrew,
} from "@/lib/hourly-labor";
import { describeCommissionMath } from "@/lib/payout-run-report";

const memberId = "5ac5217e-3905-4ea3-bdeb-65456982f5e3";

describe("moving hourly labor", () => {
  it("pays each member by their rate and actual minutes, rounding once", () => {
    expect(calculateHourlyLaborCents(3_000, 150)).toBe(7_500);
    expect(calculateHourlyLaborCents(2_525, 95)).toBe(3_998);
    expect(calculateHourlyLaborCents(3_001, 30)).toBe(1_501);
  });

  it.each([
    [0, 60],
    [-1, 60],
    [2500.5, 60],
    [2500, 0],
    [2500, 1.5],
    [Infinity, 60],
    [2147483647, 120],
  ])("rejects invalid hourly pay (%s cents, %s minutes)", (rate, minutes) => {
    expect(() => calculateHourlyLaborCents(rate, minutes)).toThrow();
  });

  it("requires complete, unique, exclusively hourly or percentage entries", () => {
    const hourly = { memberId, hourlyRateCents: 3000, workedMinutes: 150 };
    expect(CompletionCrewMembersSchema.safeParse([hourly]).success).toBe(true);
    for (const entries of [
      [hourly, hourly],
      [{ memberId, hourlyRateCents: 3000 }],
      [{ ...hourly, splitBps: 1 }],
      [{ ...hourly, workedMinutes: -30 }],
    ]) {
      expect(CompletionCrewMembersSchema.safeParse(entries).success).toBe(
        false,
      );
    }
    const movingCrew = normalizeCompletionCrew([hourly]);
    const percentageCrew = normalizeCompletionCrew([{ memberId, splitBps: 1 }]);
    expect(hasValidCrewCompensationMode(true, movingCrew)).toBe(true);
    expect(hasValidCrewCompensationMode(false, movingCrew)).toBe(false);
    expect(hasValidCrewCompensationMode(true, percentageCrew)).toBe(false);
    expect(hasValidCrewCompensationMode(false, percentageCrew)).toBe(true);
  });

  it("uses the saved job type and describes hourly payout math", () => {
    expect(
      isMovingCommissionJob({ bookingDetails: { serviceType: "moving" } }),
    ).toBe(true);
    expect(
      isMovingCommissionJob({
        bookingDetails: { serviceType: "junk_removal" },
      }),
    ).toBe(false);
    expect(isMovingCommissionJob({ bookingDetails: null })).toBe(false);
    expect(
      describeCommissionMath({
        role: "crew",
        meta: {
          compensationType: "hourly",
          hourlyRateCents: 3000,
          workedMinutes: 150,
        },
      }),
    ).toEqual({
      mathLabel: "$30.00/hr x 2h 30m",
      effectivePercentLabel: "Hourly",
    });
    expect(
      describeCommissionMath({
        role: "crew",
        meta: {
          compensationType: "hourly",
          hourlyRateCents: 4000,
          workedMinutes: 61,
        },
      }).mathLabel,
    ).toBe("$40.00/hr x 1h 1m");
  });
});
