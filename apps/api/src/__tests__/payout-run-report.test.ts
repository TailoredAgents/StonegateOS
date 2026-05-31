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
          totalRateBps: 1500,
          splitBps: 5000,
          totalSplitBps: 10000,
        },
      }),
    ).toEqual({
      mathLabel: "15% management pool x 50% split",
      effectivePercentLabel: "7.5%",
    });
  });

  it("describes crew math with pool and split percentages", () => {
    expect(
      describeCommissionMath({
        role: "crew",
        meta: {
          poolRateBps: 2250,
          splitBps: 1,
          totalSplitBps: 3,
          poolSource: "default",
        },
      }),
    ).toEqual({
      mathLabel: "22.5% crew pool x 1/3 (33.33%) split",
      effectivePercentLabel: "7.5%",
    });
  });
});
