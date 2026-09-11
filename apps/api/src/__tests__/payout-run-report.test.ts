import {
  describeCommissionMath,
  renderPayoutRunReportHtml,
  type PayoutRunReportData,
} from "@/lib/payout-run-report";

describe("describeCommissionMath", () => {
  it.each([
    { crewCount: 1, poolRateBps: 2000, each: "20%" },
    { crewCount: 2, poolRateBps: 2000, each: "10%" },
    { crewCount: 3, poolRateBps: 3000, each: "10%" },
    { crewCount: 4, poolRateBps: 3000, each: "7.5%" },
  ])(
    "describes the dynamic pool for $crewCount crew",
    ({ crewCount, poolRateBps, each }) => {
      expect(
        describeCommissionMath({
          role: "crew",
          meta: {
            poolRateBps,
            crewCount,
            splitBps: 1,
            totalSplitBps: crewCount,
            poolSource: "crew_size",
          },
        }),
      ).toEqual({
        mathLabel: `${poolRateBps / 100}% crew pool / ${crewCount} crew (equal split)`,
        effectivePercentLabel: each,
      });
    },
  );

  it("does not label a mismatched saved split as equal", () => {
    expect(
      describeCommissionMath({
        role: "crew",
        meta: {
          poolRateBps: 3000,
          crewCount: 4,
          splitBps: 1,
          totalSplitBps: 3,
          poolSource: "crew_size",
        },
      }),
    ).toEqual({
      mathLabel: "30% crew pool x 1/3 (33.33%) split",
      effectivePercentLabel: "10%",
    });
  });

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
          totalRateBps: 1700,
          splitBps: 12000,
          totalSplitBps: 17000,
        },
      }),
    ).toEqual({
      mathLabel: "17% management pool x 70.59% split",
      effectivePercentLabel: "12%",
    });
    expect(
      describeCommissionMath({
        role: "marketing",
        meta: {
          totalRateBps: 1700,
          splitBps: 5000,
          totalSplitBps: 17000,
        },
      }),
    ).toEqual({
      mathLabel: "17% management pool x 29.41% split",
      effectivePercentLabel: "5%",
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
          splitBps: 1000,
          totalSplitBps: 2000,
          poolSource: "default",
        },
      }),
    ).toEqual({
      mathLabel: "20% crew pool x 50% split",
      effectivePercentLabel: "10%",
    });
  });
});

describe("renderPayoutRunReportHtml", () => {
  it("prints per-job dynamic pool rates and earned amounts with management separate", () => {
    const date = new Date("2026-09-11T16:00:00.000Z");
    const detail = {
      memberId: "jeffrey",
      memberName: "Jeffrey",
      baseCents: 100_000,
      scheduledAt: date,
      completedAt: date,
      collectedCents: 100_000,
      contactFirstName: "Customer",
      contactLastName: null,
      addressLine1: null,
      city: null,
      state: null,
      postalCode: null,
    };
    const report: PayoutRunReportData = {
      run: {
        id: "payout",
        timezone: "America/New_York",
        periodStart: new Date("2026-09-07T04:00:00.000Z"),
        periodEnd: new Date("2026-09-14T04:00:00.000Z"),
        scheduledPayoutAt: date,
        status: "locked",
        createdAt: date,
        updatedAt: date,
        lockedAt: date,
        paidAt: null,
        reportHtml: null,
        reportGeneratedAt: null,
      },
      generatedAt: date,
      totalCents: 32_500,
      commissionDetailCount: 4,
      adjustmentCount: 0,
      memberSummaries: [
        {
          memberKey: "member:jeffrey",
          memberId: "jeffrey",
          memberName: "Jeffrey",
          salesCents: 0,
          marketingCents: 5_000,
          crewCents: 27_500,
          reimbursementsCents: 0,
          otherAdjustmentsCents: 0,
          totalCents: 32_500,
          reimbursementDetails: [],
          otherAdjustmentDetails: [],
          commissionDetails: [
            ...[2, 3, 4].map((crewCount) => ({
              ...detail,
              appointmentId: `job-${crewCount}`,
              role: "crew" as const,
              amountCents: crewCount === 4 ? 7_500 : 10_000,
              meta: {
                compensationType: "percentage",
                poolRateBps: crewCount === 2 ? 2000 : 3000,
                crewCount,
                splitBps: 1,
                totalSplitBps: crewCount,
                poolSource: "crew_size",
              },
            })),
            {
              ...detail,
              appointmentId: "job-4",
              role: "marketing",
              amountCents: 5_000,
              meta: { rateBps: 500 },
            },
          ],
        },
      ],
    };

    const html = renderPayoutRunReportHtml(report);
    expect(html).toContain("20% crew pool / 2 crew (equal split)");
    expect(html).toContain("30% crew pool / 3 crew (equal split)");
    expect(html).toContain("30% crew pool / 4 crew (equal split)");
    expect(html).toContain("<td>7.5%</td>");
    expect(html).toContain("<td>$75.00</td>");
    expect(html).toContain("Crew $275.00");
    expect(html).toContain("Management $50.00");
    expect(html).toContain("Total owed: <strong>$325.00</strong>");
  });
});
