import { describeCommissionMath } from "@/lib/payout-run-report";

describe("describeCommissionMath", () => {
  it("describes sales percentages directly from rate bps", () => {
    expect(
      describeCommissionMath({
        role: "sales",
        meta: { rateBps: 500 },
      }),
    ).toEqual({
      mathLabel: "5% of base",
      effectivePercentLabel: "5%",
    });
  });

  it("describes management math with a shared pool split", () => {
    expect(
      describeCommissionMath({
        role: "marketing",
        meta: {
          totalRateBps: 1750,
          splitBps: 10000,
          totalSplitBps: 17500,
        },
      }),
    ).toEqual({
      mathLabel: "17.5% management pool x 57.14% split",
      effectivePercentLabel: "10%",
    });
  });

  it("describes crew math with pool and split percentages", () => {
    expect(
      describeCommissionMath({
        role: "crew",
        meta: {
          poolRateBps: 2000,
          splitBps: 1,
          totalSplitBps: 3,
          poolSource: "default",
        },
      }),
    ).toEqual({
      mathLabel: "20% crew pool x 1/3 (33.33%) split",
      effectivePercentLabel: "6.67%",
    });
  });
});
