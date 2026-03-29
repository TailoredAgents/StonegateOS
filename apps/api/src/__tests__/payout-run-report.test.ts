import { describeCommissionMath } from "@/lib/payout-run-report";

describe("describeCommissionMath", () => {
  it("describes sales percentages directly from rate bps", () => {
    expect(
      describeCommissionMath({
        role: "sales",
        meta: { rateBps: 750 },
      }),
    ).toEqual({
      mathLabel: "7.5% of base",
      effectivePercentLabel: "7.5%",
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
