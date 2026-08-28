import {
  buildExpenseOverview,
  getExpenseOverviewWeekBoundary,
  type ExpenseOverviewDailyAdInput,
  type ExpenseOverviewInput,
} from "@/lib/expense-overview";

const WEEK_START = "2026-08-17";
const PRIOR_WEEK_START = "2026-08-10";

function completeAdWeek(weekStart = WEEK_START): ExpenseOverviewDailyAdInput[] {
  const start = new Date(`${weekStart}T12:00:00.000Z`);
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + offset);
    const businessDate = date.toISOString().slice(0, 10);
    return [
      { platform: "facebook" as const, businessDate, amountCents: 0 },
      { platform: "google" as const, businessDate, amountCents: 0 },
    ];
  }).flat();
}

function baseInput(
  overrides: Partial<ExpenseOverviewInput> = {},
): ExpenseOverviewInput {
  return {
    weekStart: WEEK_START,
    jobs: [],
    expenses: [],
    commissions: [],
    payrollAdjustments: [],
    payoutSnapshots: [],
    dailyAdEntries: [...completeAdWeek(PRIOR_WEEK_START), ...completeAdWeek()],
    pendingExpenseCount: 0,
    asOf: "2026-08-24",
    ...overrides,
  };
}

describe("expense overview week boundaries", () => {
  it("uses exact Eastern Monday/Sunday boundaries through spring DST", () => {
    const boundary = getExpenseOverviewWeekBoundary("2026-03-02");

    expect(boundary).toEqual({
      timezone: "America/New_York",
      startDate: "2026-03-02",
      endDate: "2026-03-08",
      startAt: "2026-03-02T05:00:00.000Z",
      endAtExclusive: "2026-03-09T04:00:00.000Z",
    });
    expect(
      new Date(boundary.endAtExclusive).getTime() -
        new Date(boundary.startAt).getTime(),
    ).toBe(167 * 60 * 60 * 1_000);
  });

  it("uses exact Eastern Monday/Sunday boundaries through fall DST", () => {
    const boundary = getExpenseOverviewWeekBoundary("2026-10-26");

    expect(boundary.startAt).toBe("2026-10-26T04:00:00.000Z");
    expect(boundary.endAtExclusive).toBe("2026-11-02T05:00:00.000Z");
    expect(
      new Date(boundary.endAtExclusive).getTime() -
        new Date(boundary.startAt).getTime(),
    ).toBe(169 * 60 * 60 * 1_000);
  });

  it("rejects a non-Monday or malformed week start", () => {
    expect(() => getExpenseOverviewWeekBoundary("2026-08-18")).toThrow(
      "weekStart must be a Monday",
    );
    expect(() => getExpenseOverviewWeekBoundary("08/17/2026")).toThrow(
      "YYYY-MM-DD",
    );
  });
});

describe("expense overview calculations", () => {
  it("keeps selected and prior completeness separate and suppresses an unsafe comparison", () => {
    const result = buildExpenseOverview(
      baseInput({
        priorWeekOmittedUnverifiedHistoricalRecordCount: 1,
      }),
    );

    expect(result.completeness).toEqual({ state: "complete", reasons: [] });
    expect(result.omittedUnverifiedHistoricalRecordCount).toBe(0);
    expect(result.priorWeek).toMatchObject({
      omittedUnverifiedHistoricalRecordCount: 1,
      completeness: {
        state: "incomplete",
        reasons: ["unverified_historical_records"],
      },
    });
    expect(result.priorWeekChange).toMatchObject({
      available: false,
      states: {
        revenue: "incomplete",
        expenses: "incomplete",
        operatingProfit: "incomplete",
        expenseRatio: "incomplete",
      },
      revenueCents: null,
      revenuePercent: null,
      unavailableReasons: {
        currentWeek: [],
        priorWeek: ["unverified_historical_records"],
      },
    });
  });

  it("calculates completed-job revenue, allocated expenses, accrued labor, ads, and prior-week change", () => {
    const result = buildExpenseOverview(
      baseInput({
        jobs: [
          {
            id: "outside-eastern-boundary",
            status: "completed",
            appointmentType: "job",
            completedAt: "2026-08-17T03:59:59.999Z",
            finalTotalCents: 0,
            commissionDataExpected: false,
          },
          {
            id: "current-1",
            status: "completed",
            appointmentType: "job",
            completedAt: "2026-08-17T04:00:00.000Z",
            finalTotalCents: 100_000,
          },
          {
            id: "current-2",
            status: "completed",
            appointmentType: "job",
            completedAt: "2026-08-24T03:59:59.999Z",
            finalTotalCents: 50_000,
          },
          {
            id: "quote",
            status: "completed",
            appointmentType: "in_person_quote",
            completedAt: "2026-08-20T16:00:00.000Z",
            finalTotalCents: 800_000,
          },
          {
            id: "canceled",
            status: "canceled",
            appointmentType: "job",
            completedAt: "2026-08-20T16:00:00.000Z",
            finalTotalCents: 700_000,
          },
          {
            id: "prior",
            status: "completed",
            appointmentType: "job",
            completedAt: "2026-08-12T16:00:00.000Z",
            finalTotalCents: 80_000,
          },
        ],
        expenses: [
          {
            id: "split",
            amountCents: 10_000,
            purchaseDate: "2026-08-18",
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "manual",
            category: { id: "fuel", label: "Fuel" },
            allocations: [
              {
                amountCents: 6_000,
                category: { id: "fuel", label: "Fuel" },
              },
              {
                amountCents: 4_000,
                category: { id: "supplies", label: "Supplies" },
              },
            ],
          },
          {
            id: "facebook",
            amountCents: 2_000,
            purchaseDate: "2026-08-19",
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "daily_ad_spend",
            category: {
              id: "category-advertising",
              label: "Advertising",
              reportingGroup: "advertising",
            },
            dailyAdPlatform: "facebook",
          },
          {
            id: "google",
            amountCents: 3_000,
            purchaseDate: "2026-08-19",
            lifecycleStatus: "posted",
            source: "daily_ad_spend",
            category: {
              id: "category-advertising",
              label: "Advertising",
              reportingGroup: "advertising",
            },
            dailyAdPlatform: "google",
          },
          {
            id: "personal-purchase",
            amountCents: 500,
            purchaseDate: "2026-08-20",
            lifecycleStatus: "posted",
            source: "receipt_capture",
            category: { id: "meals", label: "Meals" },
          },
          {
            id: "reimbursement-adjustment",
            amountCents: 500,
            purchaseDate: "2026-08-20",
            lifecycleStatus: "posted",
            source: "reimbursement_claim",
            category: { id: "reimbursements", label: "Reimbursements" },
            isReimbursementAdjustment: true,
          },
          {
            id: "prior-expense",
            amountCents: 10_000,
            purchaseDate: "2026-08-11",
            lifecycleStatus: "posted",
            source: "manual",
            category: { id: "fuel", label: "Fuel" },
          },
        ],
        commissions: [
          {
            appointmentId: "current-1",
            completedAt: "2026-08-17T04:00:00.000Z",
            group: "crew",
            amountCents: 10_000,
          },
          {
            appointmentId: "current-1",
            completedAt: "2026-08-17T04:00:00.000Z",
            group: "sales",
            amountCents: 5_000,
          },
          {
            appointmentId: "current-1",
            completedAt: "2026-08-17T04:00:00.000Z",
            group: "management",
            amountCents: 3_000,
          },
          {
            appointmentId: "current-2",
            completedAt: "2026-08-24T03:59:59.999Z",
            group: "crew",
            amountCents: 4_000,
          },
          {
            appointmentId: "prior",
            completedAt: "2026-08-12T16:00:00.000Z",
            group: "crew",
            amountCents: 5_000,
          },
          {
            appointmentId: "canceled",
            completedAt: "2026-08-20T16:00:00.000Z",
            group: "crew",
            amountCents: 99_000,
          },
        ],
        payrollAdjustments: [
          {
            accruedAt: "2026-08-21",
            amountCents: 1_000,
            kind: "payroll",
          },
          {
            accruedAt: "2026-08-21",
            amountCents: 500,
            kind: "reimbursement",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      revenueCents: 150_000,
      ordinaryExpensesCents: 15_500,
      laborCents: 23_000,
      totalExpensesCents: 38_500,
      operatingProfitCents: 111_500,
      expenseRatioPercent: 25.67,
      labor: {
        state: "estimated",
        amountCents: 23_000,
        subrows: {
          crewCents: 14_000,
          salesCents: 5_000,
          managementCents: 3_000,
          otherPayrollAdjustmentsCents: 1_000,
        },
      },
      advertising: {
        amountCents: 5_000,
        subrows: { facebookCents: 2_000, googleCents: 3_000 },
        unattributedCents: 0,
      },
      priorWeek: {
        startDate: PRIOR_WEEK_START,
        revenueCents: 80_000,
        ordinaryExpensesCents: 10_000,
        laborCents: 5_000,
        totalExpensesCents: 15_000,
        operatingProfitCents: 65_000,
        expenseRatioPercent: 18.75,
      },
      priorWeekChange: {
        available: true,
        states: {
          revenue: "available",
          expenses: "available",
          operatingProfit: "available",
          expenseRatio: "available",
        },
        revenueCents: 70_000,
        revenuePercent: 87.5,
        expensesCents: 23_500,
        expensesPercent: 156.67,
        operatingProfitCents: 46_500,
        operatingProfitPercent: 71.54,
        expenseRatioPercentagePoints: 6.92,
      },
      completeness: { state: "complete", reasons: [] },
    });
    expect(
      result.categories.map(({ id, amountCents }) => ({ id, amountCents })),
    ).toEqual([
      { id: "labor", amountCents: 23_000 },
      { id: "fuel", amountCents: 6_000 },
      { id: "category-advertising", amountCents: 5_000 },
      { id: "supplies", amountCents: 4_000 },
      { id: "meals", amountCents: 500 },
    ]);
    expect(result.categories[0]).toMatchObject({
      percentOfExpenses: 59.74,
      percentOfRevenue: 15.33,
    });
  });

  it("uses finalized payout data as Actual and excludes payout expenses", () => {
    const result = buildExpenseOverview(
      baseInput({
        jobs: [
          {
            id: "job",
            status: "completed",
            appointmentType: "job",
            completedAt: "2026-08-20T12:00:00.000Z",
            finalTotalCents: 100_000,
          },
        ],
        expenses: [
          {
            id: "fuel",
            amountCents: 1_000,
            purchaseDate: "2026-08-20",
            lifecycleStatus: "posted",
            source: "manual",
            category: { id: "fuel", label: "Fuel" },
          },
          {
            id: "generated-payroll-expense",
            amountCents: 99_000,
            purchaseDate: "2026-08-20",
            lifecycleStatus: "posted",
            source: "payout_run",
            category: { id: "commissions", label: "Commissions" },
          },
        ],
        commissions: [
          {
            appointmentId: "job",
            completedAt: "2026-08-20T12:00:00.000Z",
            group: "crew",
            amountCents: 88_000,
          },
        ],
        payrollAdjustments: [
          {
            accruedAt: "2026-08-20",
            amountCents: 77_000,
            kind: "payroll",
          },
        ],
        payoutSnapshots: [
          {
            weekStart: WEEK_START,
            status: "locked",
            crewCents: 10_000,
            salesCents: 5_000,
            managementCents: 4_000,
            otherPayrollAdjustmentsCents: 2_000,
          },
        ],
      }),
    );

    expect(result.labor).toEqual({
      state: "actual",
      amountCents: 21_000,
      subrows: {
        crewCents: 10_000,
        salesCents: 5_000,
        managementCents: 4_000,
        otherPayrollAdjustmentsCents: 2_000,
      },
    });
    expect(result.ordinaryExpensesCents).toBe(1_000);
    expect(result.totalExpensesCents).toBe(22_000);
    expect(result.missingCommissionDataCount).toBe(0);
  });

  it("counts only the active correction and excludes drafts, voids, and rejections", () => {
    const expense = (
      id: string,
      amountCents: number,
      lifecycleStatus: "draft" | "posted" | "voided" | "corrected",
      reviewStatus?: "pending" | "approved" | "rejected",
    ) => ({
      id,
      amountCents,
      purchaseDate: "2026-08-18",
      lifecycleStatus,
      reviewStatus,
      source: "manual",
      category: { id: "fuel", label: "Fuel" },
    });
    const result = buildExpenseOverview(
      baseInput({
        expenses: [
          expense("superseded", 10_000, "corrected"),
          expense("replacement", 12_000, "posted", "approved"),
          expense("draft", 20_000, "draft"),
          expense("voided", 30_000, "voided"),
          expense("rejected", 40_000, "posted", "rejected"),
          expense("pending-post-bypass", 50_000, "posted", "pending"),
        ],
      }),
    );

    expect(result.ordinaryExpensesCents).toBe(12_000);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]).toMatchObject({
      id: "fuel",
      amountCents: 12_000,
    });
  });

  it("returns null percentages when revenue or expenses are zero", () => {
    const result = buildExpenseOverview(baseInput());

    expect(result).toMatchObject({
      revenueCents: 0,
      totalExpensesCents: 0,
      operatingProfitCents: 0,
      expenseRatioPercent: null,
      categories: [],
      priorWeekChange: {
        available: true,
        states: {
          revenue: "zero_baseline",
          expenses: "zero_baseline",
          operatingProfit: "zero_baseline",
          expenseRatio: "undefined_ratio",
        },
        revenuePercent: null,
        expensesPercent: null,
        operatingProfitPercent: null,
        expenseRatioPercentagePoints: null,
      },
    });
  });

  it("accrues effective-dated monthly costs exactly across a month boundary", () => {
    const result = buildExpenseOverview(
      baseInput({
        weekStart: "2026-03-30",
        fixedCosts: [
          {
            seriesId: "lease",
            version: 1,
            name: "Office lease",
            category: { id: "office_admin", label: "Office/Admin" },
            monthlyAmountCents: 3_100,
            effectiveStartDate: "2026-03-01",
            state: "active",
          },
          {
            seriesId: "lease",
            version: 2,
            name: "Office software bundle",
            category: { id: "software", label: "Software" },
            monthlyAmountCents: 3_000,
            effectiveStartDate: "2026-04-01",
            state: "active",
          },
          {
            seriesId: "lease",
            version: 3,
            name: "Office software bundle",
            category: { id: "software", label: "Software" },
            monthlyAmountCents: 3_000,
            effectiveStartDate: "2026-04-04",
            state: "ended",
          },
        ],
        asOf: "2026-04-06",
      }),
    );

    expect(result).toMatchObject({
      ordinaryExpensesCents: 0,
      fixedCostsCents: 500,
      laborCents: 0,
      totalExpensesCents: 500,
      operatingProfitCents: -500,
      fixedCosts: { amountCents: 500, activeSeriesCount: 0 },
    });
    expect(result.categories).toEqual([
      expect.objectContaining({
        id: "software",
        amountCents: 300,
        fixedCostCents: 300,
        percentOfExpenses: 60,
      }),
      expect.objectContaining({
        id: "office_admin",
        amountCents: 200,
        fixedCostCents: 200,
        percentOfExpenses: 40,
      }),
    ]);
  });

  it("caps current and future fixed-cost accrual at the Eastern as-of date", () => {
    const fixedCosts: NonNullable<ExpenseOverviewInput["fixedCosts"]> = [
      {
        seriesId: "lease",
        version: 1,
        name: "Office lease",
        category: { id: "office_admin", label: "Office/Admin" },
        monthlyAmountCents: 3_100,
        effectiveStartDate: "2026-08-01",
        state: "active",
      },
    ];
    const current = buildExpenseOverview(
      baseInput({
        weekStart: "2026-08-24",
        fixedCosts,
        asOf: "2026-08-27T23:59:59-04:00",
      }),
    );

    expect(current.fixedCostsCents).toBe(400);
    expect(current.fixedCosts).toEqual({
      amountCents: 400,
      activeSeriesCount: 1,
      coveredExpenseCount: 0,
      coveredExpenseAmountCents: 0,
    });
    // The completed prior week remains a full seven-day reporting period.
    expect(current.priorWeek.fixedCostsCents).toBe(700);

    const future = buildExpenseOverview(
      baseInput({
        weekStart: "2026-08-31",
        fixedCosts,
        asOf: "2026-08-27T23:59:59-04:00",
      }),
    );

    expect(future.fixedCostsCents).toBe(0);
    expect(future.fixedCosts).toEqual({
      amountCents: 0,
      activeSeriesCount: 0,
      coveredExpenseCount: 0,
      coveredExpenseAmountCents: 0,
    });
    expect(future.categories).toEqual([]);
    expect(future.priorWeek.fixedCostsCents).toBe(400);
  });

  it("uses the highest fixed-cost version when corrections share a date", () => {
    const result = buildExpenseOverview(
      baseInput({
        fixedCosts: [
          {
            seriesId: "service-bundle",
            version: 1,
            name: "Original bundle",
            category: { id: "office_admin", label: "Office/Admin" },
            monthlyAmountCents: 3_100,
            effectiveStartDate: "2026-08-01",
            state: "active",
          },
          {
            seriesId: "service-bundle",
            version: 2,
            name: "First correction",
            category: { id: "software", label: "Software" },
            monthlyAmountCents: 6_200,
            effectiveStartDate: WEEK_START,
            state: "active",
          },
          {
            seriesId: "service-bundle",
            version: 3,
            name: "Final correction",
            category: { id: "equipment", label: "Equipment" },
            monthlyAmountCents: 9_300,
            effectiveStartDate: WEEK_START,
            state: "active",
          },
        ],
      }),
    );

    expect(result.fixedCostsCents).toBe(2_100);
    expect(result.categories).toEqual([
      expect.objectContaining({
        id: "equipment",
        amountCents: 2_100,
        fixedCostCents: 2_100,
      }),
    ]);
    expect(result.priorWeek.fixedCostsCents).toBe(700);
  });

  it("preserves tiny monthly cents and reconciles category totals exactly", () => {
    const result = buildExpenseOverview(
      baseInput({
        weekStart: "2026-08-31",
        asOf: "2026-09-07",
        expenses: [
          {
            id: "office-supplies",
            amountCents: 99,
            purchaseDate: "2026-08-31",
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "manual",
            category: { id: "office_admin", label: "Office/Admin" },
          },
        ],
        fixedCosts: [
          {
            seriesId: "one-cent-cost",
            version: 1,
            name: "One-cent monthly cost",
            category: { id: "office_admin", label: "Office/Admin" },
            monthlyAmountCents: 1,
            effectiveStartDate: "2026-08-01",
            state: "active",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      ordinaryExpensesCents: 99,
      fixedCostsCents: 1,
      totalExpensesCents: 100,
    });
    expect(result.categories).toEqual([
      expect.objectContaining({
        id: "office_admin",
        amountCents: 100,
        fixedCostCents: 1,
      }),
    ]);
    expect(
      result.categories.reduce(
        (total, category) => total + category.amountCents,
        0,
      ),
    ).toBe(result.totalExpensesCents);
  });

  it("keeps linked receipt evidence out of ordinary totals without losing fixed accrual", () => {
    const result = buildExpenseOverview(
      baseInput({
        expenses: [
          {
            id: "prior-software-receipt",
            amountCents: 31_000,
            purchaseDate: "2026-08-12",
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "receipt_scan",
            category: { id: "software", label: "Software" },
            coveredByFixedCostSeriesId: "33333333-3333-4333-8333-333333333333",
          },
          {
            id: "monthly-lease-receipt",
            amountCents: 31_000,
            purchaseDate: "2026-08-20",
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "receipt_scan",
            category: { id: "office_admin", label: "Office/Admin" },
            coveredByFixedCostSeriesId: "22222222-2222-4222-8222-222222222222",
          },
        ],
        fixedCosts: [
          {
            seriesId: "22222222-2222-4222-8222-222222222222",
            version: 1,
            name: "Office lease",
            category: { id: "office_admin", label: "Office/Admin" },
            monthlyAmountCents: 31_000,
            effectiveStartDate: "2026-08-01",
            state: "active",
          },
          {
            seriesId: "33333333-3333-4333-8333-333333333333",
            version: 1,
            name: "Software subscription",
            category: { id: "software", label: "Software" },
            monthlyAmountCents: 31_000,
            effectiveStartDate: "2026-08-01",
            state: "active",
          },
          {
            seriesId: "33333333-3333-4333-8333-333333333333",
            version: 2,
            name: "Software subscription",
            category: { id: "software", label: "Software" },
            monthlyAmountCents: 31_000,
            effectiveStartDate: WEEK_START,
            state: "ended",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      ordinaryExpensesCents: 0,
      fixedCostsCents: 7_000,
      totalExpensesCents: 7_000,
      fixedCosts: {
        amountCents: 7_000,
        activeSeriesCount: 1,
        coveredExpenseCount: 1,
        coveredExpenseAmountCents: 31_000,
      },
    });
    expect(result.categories).toEqual([
      expect.objectContaining({
        id: "office_admin",
        amountCents: 7_000,
        fixedCostCents: 7_000,
      }),
    ]);
    expect(
      result.categories.reduce(
        (total, category) => total + category.amountCents,
        0,
      ),
    ).toBe(result.totalExpensesCents);
    expect(result.priorWeek.fixedCosts).toEqual({
      amountCents: 14_000,
      activeSeriesCount: 2,
      coveredExpenseCount: 1,
      coveredExpenseAmountCents: 31_000,
    });
  });

  it("distinguishes a defined amount comparison from an undefined current ratio", () => {
    const result = buildExpenseOverview(
      baseInput({
        jobs: [
          {
            id: "prior-revenue",
            status: "completed",
            appointmentType: "job",
            completedAt: "2026-08-12T12:00:00.000Z",
            finalTotalCents: 100_000,
            commissionDataExpected: false,
          },
        ],
      }),
    );

    expect(result.priorWeekChange).toMatchObject({
      available: true,
      states: {
        revenue: "available",
        expenses: "zero_baseline",
        operatingProfit: "available",
        expenseRatio: "undefined_ratio",
      },
      revenuePercent: -100,
      expensesPercent: null,
      operatingProfitPercent: -100,
      expenseRatioPercentagePoints: null,
    });
  });

  it("flags missing persisted records while treating an explicit zero ad entry as complete", () => {
    const result = buildExpenseOverview(
      baseInput({
        jobs: [
          {
            id: "missing-data-job",
            status: "completed",
            appointmentType: "job",
            completedAt: "2026-08-18T12:00:00.000Z",
            finalTotalCents: null,
          },
        ],
        expenses: [
          {
            id: "legacy-unknown",
            amountCents: 500,
            purchaseDate: "2026-08-18",
            lifecycleStatus: "posted",
            source: "legacy",
            category: {
              id: "legacy:mystery",
              label: "Mystery charge",
              verified: false,
            },
          },
        ],
        dailyAdEntries: [
          {
            platform: "facebook",
            businessDate: WEEK_START,
            amountCents: 0,
          },
        ],
        pendingExpenseCount: 2,
        omittedUnverifiedHistoricalRecordCount: 3,
      }),
    );

    expect(result.missingCommissionDataCount).toBe(1);
    expect(result.missingFinalTotalCount).toBe(1);
    expect(result.missingAdEntries).toHaveLength(7);
    expect(result.missingAdEntries[0]).toEqual({
      businessDate: WEEK_START,
      missingPlatforms: ["google"],
    });
    expect(result.missingAdEntries[1]).toEqual({
      businessDate: "2026-08-18",
      missingPlatforms: ["facebook", "google"],
    });
    expect(result.categories[0]?.percentOfRevenue).toBeNull();
    expect(result.completeness).toEqual({
      state: "incomplete",
      reasons: [
        "missing_ad_entries",
        "missing_commission_data",
        "missing_final_totals",
        "pending_expenses",
        "unverified_historical_records",
        "unverified_expense_categories",
      ],
    });
  });

  it("does not flag today or future dates in the current week as missing", () => {
    const result = buildExpenseOverview(
      baseInput({
        asOf: "2026-08-19",
        dailyAdEntries: completeAdWeek().filter(
          (entry) => entry.businessDate <= "2026-08-18",
        ),
      }),
    );

    expect(result.missingAdEntries).toEqual([]);
  });

  it("reports dump weight and effective cost per ton without overstating partial coverage", () => {
    const result = buildExpenseOverview(
      baseInput({
        expenses: [
          {
            id: "weighted-split-dump",
            amountCents: 10_000,
            purchaseDate: "2026-08-18",
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "receipt_scan",
            category: { id: "dump_fees", label: "Dump Fees" },
            allocations: [
              {
                amountCents: 8_000,
                category: { id: "dump_fees", label: "Dump Fees" },
              },
              {
                amountCents: 2_000,
                category: { id: "supplies", label: "Supplies" },
              },
            ],
          },
          {
            id: "unweighted-dump",
            amountCents: 6_000,
            purchaseDate: "2026-08-19",
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "receipt_scan",
            category: { id: "dump_fees", label: "Dump Fees" },
          },
          {
            id: "corrected-original",
            amountCents: 50_000,
            purchaseDate: "2026-08-20",
            lifecycleStatus: "corrected",
            reviewStatus: "approved",
            source: "receipt_scan",
            category: { id: "dump_fees", label: "Dump Fees" },
          },
          {
            id: "prior-weighted-dump",
            amountCents: 5_000,
            purchaseDate: "2026-08-11",
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "receipt_scan",
            category: { id: "dump_fees", label: "Dump Fees" },
          },
        ],
        dumpDetails: [
          {
            expenseId: "weighted-split-dump",
            weightStatus: "confirmed",
            netWeightPounds: 2_900,
          },
          {
            expenseId: "unweighted-dump",
            weightStatus: "unreadable",
            netWeightPounds: null,
          },
          {
            expenseId: "corrected-original",
            weightStatus: "confirmed",
            netWeightPounds: 9_000,
          },
          {
            expenseId: "prior-weighted-dump",
            weightStatus: "confirmed",
            netWeightPounds: 2_000,
          },
        ],
      }),
    );

    expect(result.dumpActivity).toEqual({
      dumpFeeCents: 14_000,
      ticketCount: 2,
      weightedTicketCount: 1,
      netWeightPounds: 2_900,
      // Only the tracked $80 dump allocation is divided by 1.45 short tons.
      averageCostPerTonCents: 5_517,
      missingWeightCount: 1,
    });
    expect(result.priorWeek.dumpActivity).toEqual({
      dumpFeeCents: 5_000,
      ticketCount: 1,
      weightedTicketCount: 1,
      netWeightPounds: 2_000,
      averageCostPerTonCents: 5_000,
      missingWeightCount: 0,
    });
  });

  it("keeps fixed-cost-covered dump evidence in operational activity without double-counting spend", () => {
    const seriesId = "44444444-4444-4444-8444-444444444444";
    const result = buildExpenseOverview(
      baseInput({
        expenses: [
          {
            id: "covered-dump-ticket",
            amountCents: 31_000,
            purchaseDate: "2026-08-20",
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "receipt_scan",
            category: { id: "dump_fees", label: "Dump Fees" },
            coveredByFixedCostSeriesId: seriesId,
          },
        ],
        dumpDetails: [
          {
            expenseId: "covered-dump-ticket",
            weightStatus: "confirmed",
            netWeightPounds: 6_200,
          },
        ],
        fixedCosts: [
          {
            seriesId,
            version: 1,
            name: "Monthly transfer-station plan",
            category: { id: "dump_fees", label: "Dump Fees" },
            monthlyAmountCents: 31_000,
            effectiveStartDate: "2026-08-01",
            state: "active",
          },
        ],
      }),
    );

    expect(result.ordinaryExpensesCents).toBe(0);
    expect(result.fixedCosts.coveredExpenseCount).toBe(1);
    expect(result.dumpActivity).toEqual({
      dumpFeeCents: 31_000,
      ticketCount: 1,
      weightedTicketCount: 1,
      netWeightPounds: 6_200,
      averageCostPerTonCents: 10_000,
      missingWeightCount: 0,
    });
  });

  it("returns a null dump cost at zero weight and rejects unverified weight shapes", () => {
    expect(buildExpenseOverview(baseInput()).dumpActivity).toEqual({
      dumpFeeCents: 0,
      ticketCount: 0,
      weightedTicketCount: 0,
      netWeightPounds: 0,
      averageCostPerTonCents: null,
      missingWeightCount: 0,
    });

    expect(() =>
      buildExpenseOverview(
        baseInput({
          dumpDetails: [
            {
              expenseId: "bad-confirmed-weight",
              weightStatus: "confirmed",
              netWeightPounds: null,
            },
          ],
        }),
      ),
    ).toThrow("must be positive pounds");
    expect(() =>
      buildExpenseOverview(
        baseInput({
          dumpDetails: [
            {
              expenseId: "duplicate-weight",
              weightStatus: "unreadable",
              netWeightPounds: null,
            },
            {
              expenseId: "duplicate-weight",
              weightStatus: "unreadable",
              netWeightPounds: null,
            },
          ],
        }),
      ),
    ).toThrow("Duplicate dump-ticket facts");
  });

  it("rejects allocation drift and duplicate daily-ad rows", () => {
    expect(() =>
      buildExpenseOverview(
        baseInput({
          expenses: [
            {
              id: "bad-split",
              amountCents: 1_000,
              purchaseDate: "2026-08-18",
              lifecycleStatus: "posted",
              source: "manual",
              category: { id: "fuel", label: "Fuel" },
              allocations: [
                {
                  amountCents: 999,
                  category: { id: "fuel", label: "Fuel" },
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow("allocations must exactly equal");

    expect(() =>
      buildExpenseOverview(
        baseInput({
          dailyAdEntries: [
            {
              platform: "facebook",
              businessDate: WEEK_START,
              amountCents: 0,
            },
            {
              platform: "facebook",
              businessDate: WEEK_START,
              amountCents: 100,
            },
          ],
        }),
      ),
    ).toThrow("Duplicate daily ad entry");
  });
});
