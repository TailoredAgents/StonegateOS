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
          splitBps: 11250,
          totalSplitBps: 17500,
        },
      }),
    ).toEqual({
      mathLabel: "17.5% management pool x 64.29% split",
      effectivePercentLabel: "11.25%",
    });
    expect(
      describeCommissionMath({
        role: "marketing",
        meta: {
          totalRateBps: 1750,
          splitBps: 6250,
          totalSplitBps: 17500,
        },
      }),
    ).toEqual({
      mathLabel: "17.5% management pool x 35.71% split",
      effectivePercentLabel: "6.25%",
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

  it("describes the adjusted Austin, Jeffrey, and Devon crew split", () => {
    expect(
      describeCommissionMath({
        role: "crew",
        meta: {
          poolRateBps: 2000,
          splitBps: 875,
          totalSplitBps: 2000,
          poolSource: "default",
        },
      }),
    ).toEqual({
      mathLabel: "20% crew pool x 43.75% split",
      effectivePercentLabel: "8.75%",
    });
  });
});
