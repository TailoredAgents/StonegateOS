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
          totalRateBps: 500,
          splitBps: 5000,
          totalSplitBps: 10000,
        },
      }),
    ).toEqual({
      mathLabel: "5% management pool x 50% split",
      effectivePercentLabel: "2.5%",
    });
  });

  it("describes crew math with pool and split percentages", () => {
    expect(
      describeCommissionMath({
        role: "crew",
        meta: {
          poolRateBps: 3000,
          splitBps: 2,
          totalSplitBps: 3,
          poolSource: "demo",
        },
      }),
    ).toEqual({
      mathLabel: "30% demo pool x 2/3 (66.67%) split",
      effectivePercentLabel: "20%",
    });
  });
});
