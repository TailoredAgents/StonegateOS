import {
  buildExpenseOverview,
  type ExpenseOverviewDailyAdInput,
} from "@/lib/expense-overview";
import {
  getExpenseOverviewLoadWindow,
  mapExpenseOverviewRows,
  type ExpenseOverviewRepositoryRows,
} from "@/lib/expense-overview-repository";

const WEEK_START = "2026-08-17";

function completeAdWeek(): ExpenseOverviewRepositoryRows["dailyAdEntries"] {
  const entries: ExpenseOverviewRepositoryRows["dailyAdEntries"] = [];
  for (let day = 17; day <= 23; day += 1) {
    const businessDate = `2026-08-${String(day).padStart(2, "0")}`;
    entries.push({
      platform: "facebook",
      businessDate,
      amountCents: businessDate === "2026-08-19" ? 2_000 : 0,
      currentExpenseId:
        businessDate === "2026-08-19" ? "facebook-expense" : null,
    });
    entries.push({
      platform: "google",
      businessDate,
      amountCents: 0,
      currentExpenseId: null,
    });
  }
  return entries;
}

function baseRows(
  overrides: Partial<ExpenseOverviewRepositoryRows> = {},
): ExpenseOverviewRepositoryRows {
  return {
    jobs: [],
    expenses: [],
    allocations: [],
    dumpDetails: [],
    commissions: [],
    payoutLines: [],
    payoutAdjustments: [],
    dailyAdEntries: [],
    fixedCostVersions: [],
    ...overrides,
  };
}

describe("expense overview repository boundaries", () => {
  it("loads the selected and prior Eastern weeks across DST", () => {
    const window = getExpenseOverviewLoadWindow("2026-03-09");

    expect(window).toEqual({
      currentStartAt: new Date("2026-03-09T04:00:00.000Z"),
      currentEndAtExclusive: new Date("2026-03-16T04:00:00.000Z"),
      priorStartAt: new Date("2026-03-02T05:00:00.000Z"),
      priorStartDate: "2026-03-02",
      endDateExclusive: "2026-03-16",
    });
  });
});

describe("expense overview repository mapping", () => {
  it("maps ledger, allocations, commissions, payout snapshots, ads, and verification state", () => {
    const rows = baseRows({
      jobs: [
        {
          id: "current-job",
          status: "completed",
          appointmentType: "job",
          completedAt: new Date("2026-08-18T14:00:00.000Z"),
          finalTotalCents: 100_000,
        },
        {
          id: "prior-job",
          status: "completed",
          appointmentType: "job",
          completedAt: new Date("2026-08-11T14:00:00.000Z"),
          finalTotalCents: 80_000,
        },
      ],
      expenses: [
        {
          id: "split-expense",
          amountCents: 10_000,
          currency: "USD",
          legacyCategory: "Fuel",
          categoryId: "fuel",
          categoryName: "Fuel",
          categoryNeedsReview: false,
          paidAt: new Date("2026-08-18T14:00:00.000Z"),
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          source: "manual",
          reversalOfExpenseId: null,
        },
        {
          id: "facebook-expense",
          amountCents: 2_000,
          currency: "USD",
          legacyCategory: "Advertising",
          categoryId: "advertising",
          categoryName: "Advertising",
          categoryNeedsReview: false,
          paidAt: new Date("2026-08-19T16:00:00.000Z"),
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          source: "manual_correction",
          reversalOfExpenseId: null,
          correctionOfExpenseId: "original-facebook-expense",
        },
        {
          id: "legacy-expense",
          amountCents: 500,
          currency: "USD",
          legacyCategory: "Mystery charge",
          categoryId: null,
          categoryName: null,
          categoryNeedsReview: true,
          paidAt: new Date("2026-08-20T16:00:00.000Z"),
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          source: "legacy",
          reversalOfExpenseId: null,
        },
        {
          id: "foreign-expense",
          amountCents: 900,
          currency: "CAD",
          legacyCategory: "Fuel",
          categoryId: "fuel",
          categoryName: "Fuel",
          categoryNeedsReview: false,
          paidAt: new Date("2026-08-20T16:00:00.000Z"),
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          source: "legacy",
          reversalOfExpenseId: null,
        },
        {
          id: "reversal",
          amountCents: -1_000,
          currency: "USD",
          legacyCategory: "Fuel",
          categoryId: "fuel",
          categoryName: "Fuel",
          categoryNeedsReview: false,
          paidAt: new Date("2026-08-20T16:00:00.000Z"),
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          source: "manual_correction",
          reversalOfExpenseId: "voided-original",
        },
        {
          id: "pending-expense",
          amountCents: 300,
          currency: "USD",
          legacyCategory: "Meals",
          categoryId: "meals",
          categoryName: "Meals",
          categoryNeedsReview: false,
          paidAt: new Date("2026-08-21T16:00:00.000Z"),
          lifecycleStatus: "draft",
          reviewStatus: "pending",
          source: "receipt_capture",
          reversalOfExpenseId: null,
        },
        {
          id: "payout-expense",
          amountCents: 99_000,
          currency: "USD",
          legacyCategory: "Commissions",
          categoryId: null,
          categoryName: null,
          categoryNeedsReview: true,
          paidAt: new Date("2026-08-21T16:00:00.000Z"),
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          source: "payout_run",
          reversalOfExpenseId: null,
        },
        {
          id: "legacy-reimbursement-expense",
          amountCents: 2_500,
          currency: "USD",
          legacyCategory: "Reimbursements",
          categoryId: "reimbursements",
          categoryName: "Reimbursements",
          categoryNeedsReview: false,
          paidAt: new Date("2026-08-21T16:00:00.000Z"),
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          source: "payout_reimbursement",
          reversalOfExpenseId: null,
        },
        {
          id: "prior-expense",
          amountCents: 1_000,
          currency: "USD",
          legacyCategory: "Fuel",
          categoryId: "fuel",
          categoryName: "Fuel",
          categoryNeedsReview: false,
          paidAt: new Date("2026-08-12T16:00:00.000Z"),
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          source: "manual",
          reversalOfExpenseId: null,
        },
      ],
      allocations: [
        {
          expenseId: "split-expense",
          amountCents: 6_000,
          categoryId: "fuel",
          categoryName: "Fuel",
          expenseCategoryNeedsReview: false,
        },
        {
          expenseId: "split-expense",
          amountCents: 4_000,
          categoryId: "supplies",
          categoryName: "Supplies",
          expenseCategoryNeedsReview: false,
        },
      ],
      commissions: [
        {
          appointmentId: "current-job",
          completedAt: new Date("2026-08-18T14:00:00.000Z"),
          role: "crew",
          amountCents: 1_000,
        },
        {
          appointmentId: "current-job",
          completedAt: new Date("2026-08-18T14:00:00.000Z"),
          role: "sales",
          amountCents: 500,
        },
        {
          appointmentId: "current-job",
          completedAt: new Date("2026-08-18T14:00:00.000Z"),
          role: "marketing",
          amountCents: 300,
        },
        {
          appointmentId: "prior-job",
          completedAt: new Date("2026-08-11T14:00:00.000Z"),
          role: "crew",
          amountCents: 50_000,
        },
      ],
      payoutLines: [
        {
          payoutRunId: "prior-payout",
          status: "locked",
          periodStart: new Date("2026-08-10T04:00:00.000Z"),
          crewCents: 400,
          salesCents: 200,
          marketingCents: 100,
        },
      ],
      payoutAdjustments: [
        {
          payoutRunId: "current-draft",
          status: "draft",
          periodStart: new Date("2026-08-17T04:00:00.000Z"),
          kind: "manual",
          amountCents: 200,
        },
        {
          payoutRunId: "current-draft",
          status: "draft",
          periodStart: new Date("2026-08-17T04:00:00.000Z"),
          kind: "reimbursement",
          amountCents: 700,
        },
        {
          payoutRunId: "prior-payout",
          status: "locked",
          periodStart: new Date("2026-08-10T04:00:00.000Z"),
          kind: "manual",
          amountCents: 50,
        },
        {
          payoutRunId: "prior-payout",
          status: "locked",
          periodStart: new Date("2026-08-10T04:00:00.000Z"),
          kind: "reimbursement",
          amountCents: 900,
        },
      ],
      dailyAdEntries: completeAdWeek(),
      fixedCostVersions: [
        {
          seriesId: "fixed-series",
          version: 1,
          name: "Office lease",
          categoryId: "office_admin",
          categoryName: "Office/Admin",
          monthlyAmountCents: 31_000,
          effectiveStartDate: "2026-08-01",
          state: "active",
        },
      ],
    });

    const mapped = mapExpenseOverviewRows({
      weekStart: WEEK_START,
      rows,
      asOf: "2026-08-24",
    });
    const overview = buildExpenseOverview(mapped);

    expect(mapped.pendingExpenseCount).toBe(1);
    expect(mapped.omittedUnverifiedHistoricalRecordCount).toBe(2);
    expect(mapped.expenses.map((expense) => expense.id)).not.toContain(
      "foreign-expense",
    );
    expect(mapped.expenses.map((expense) => expense.id)).not.toContain(
      "reversal",
    );
    expect(mapped.expenses.map((expense) => expense.id)).toEqual(
      expect.not.arrayContaining([
        "payout-expense",
        "legacy-reimbursement-expense",
        "legacy-expense",
      ]),
    );
    expect(
      mapped.expenses.find((expense) => expense.id === "facebook-expense"),
    ).toMatchObject({ dailyAdPlatform: "facebook" });
    expect(mapped.commissions).toContainEqual(
      expect.objectContaining({ group: "management", amountCents: 300 }),
    );
    expect(mapped.payoutSnapshots).toEqual([
      {
        weekStart: "2026-08-10",
        status: "locked",
        crewCents: 400,
        salesCents: 200,
        managementCents: 100,
        otherPayrollAdjustmentsCents: 50,
      },
    ]);

    expect(overview).toMatchObject({
      revenueCents: 100_000,
      ordinaryExpensesCents: 12_000,
      fixedCostsCents: 7_000,
      laborCents: 2_000,
      totalExpensesCents: 21_000,
      pendingExpenseCount: 1,
      omittedUnverifiedHistoricalRecordCount: 2,
      advertising: {
        amountCents: 2_000,
        subrows: { facebookCents: 2_000, googleCents: 0 },
      },
      priorWeek: {
        revenueCents: 80_000,
        ordinaryExpensesCents: 1_000,
        fixedCostsCents: 7_000,
        laborCents: 750,
      },
    });
    expect(overview.labor.state).toBe("estimated");
    expect(overview.priorWeek.laborCents).toBe(750);
    expect(overview.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fuel", amountCents: 6_000 }),
        expect.objectContaining({ id: "supplies", amountCents: 4_000 }),
        expect.objectContaining({ id: "advertising", amountCents: 2_000 }),
        expect.objectContaining({
          id: "office_admin",
          amountCents: 7_000,
          fixedCostCents: 7_000,
        }),
      ]),
    );
    expect(overview.categories).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ label: "Mystery charge" }),
        expect.objectContaining({ id: "reimbursements" }),
      ]),
    );
  });

  it("shows a current-week unknown label for review but omits it after the week closes", () => {
    const rows = baseRows({
      expenses: [
        {
          id: "unknown-current-week-expense",
          amountCents: 725,
          currency: "USD",
          legacyCategory: "Unmapped vendor charge",
          categoryId: null,
          categoryName: null,
          categoryNeedsReview: true,
          paidAt: new Date("2026-08-18T16:00:00.000Z"),
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          source: "legacy",
          reversalOfExpenseId: null,
        },
      ],
    });

    const current = mapExpenseOverviewRows({
      weekStart: WEEK_START,
      rows,
      asOf: "2026-08-19",
    });
    expect(current.expenses).toHaveLength(1);
    expect(current.expenses[0]?.id).toBe("unknown-current-week-expense");
    expect(current.expenses[0]?.category.verified).toBe(false);
    expect(current.omittedUnverifiedHistoricalRecordCount).toBe(0);

    const historical = mapExpenseOverviewRows({
      weekStart: WEEK_START,
      rows,
      asOf: "2026-08-24",
    });
    expect(historical.expenses).toEqual([]);
    expect(historical.omittedUnverifiedHistoricalRecordCount).toBe(1);
  });

  it("attributes omitted evidence to its own comparison week", () => {
    const rows = baseRows({
      expenses: [
        {
          id: "unknown-prior-week-expense",
          amountCents: 725,
          currency: "USD",
          legacyCategory: "Unmapped prior charge",
          categoryId: null,
          categoryName: null,
          categoryNeedsReview: true,
          paidAt: new Date("2026-08-11T16:00:00.000Z"),
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          source: "legacy",
          reversalOfExpenseId: null,
        },
      ],
    });

    const mapped = mapExpenseOverviewRows({
      weekStart: WEEK_START,
      rows,
      asOf: "2026-08-24",
    });
    expect(mapped.omittedUnverifiedHistoricalRecordCount).toBe(0);
    expect(mapped.priorWeekOmittedUnverifiedHistoricalRecordCount).toBe(1);
  });

  it("omits a daily-ad ledger row that does not reconcile to its authoritative registry value", () => {
    const dailyAdEntries: ExpenseOverviewDailyAdInput[] = [
      {
        platform: "facebook",
        businessDate: "2026-08-18",
        amountCents: 2_000,
      },
    ];
    const mapped = mapExpenseOverviewRows({
      weekStart: WEEK_START,
      asOf: "2026-08-19",
      rows: baseRows({
        expenses: [
          {
            id: "bad-ad-expense",
            amountCents: 1_900,
            currency: "USD",
            legacyCategory: "Advertising",
            categoryId: "advertising",
            categoryName: "Advertising",
            categoryNeedsReview: false,
            paidAt: new Date("2026-08-18T16:00:00.000Z"),
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "daily_ad_spend",
            reversalOfExpenseId: null,
          },
        ],
        dailyAdEntries: dailyAdEntries.map((entry) => ({
          ...entry,
          currentExpenseId: "bad-ad-expense",
        })),
      }),
    });

    expect(mapped.expenses).toEqual([]);
    expect(mapped.omittedUnverifiedHistoricalRecordCount).toBe(1);
    expect(buildExpenseOverview(mapped).ordinaryExpensesCents).toBe(0);
  });

  it("maps fixed-cost coverage as excluded evidence with transparent counts", () => {
    const seriesId = "22222222-2222-4222-8222-222222222222";
    const mapped = mapExpenseOverviewRows({
      weekStart: WEEK_START,
      asOf: "2026-08-24",
      rows: baseRows({
        expenses: [
          {
            id: "covered-receipt",
            amountCents: 31_000,
            currency: "USD",
            legacyCategory: "Office/Admin",
            categoryId: "office_admin",
            categoryName: "Office/Admin",
            categoryNeedsReview: false,
            paidAt: new Date("2026-08-20T16:00:00.000Z"),
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "receipt_scan",
            reversalOfExpenseId: null,
            coveredByFixedCostSeriesId: seriesId,
          },
        ],
        allocations: [
          {
            expenseId: "covered-receipt",
            amountCents: 31_000,
            categoryId: "office_admin",
            categoryName: "Office/Admin",
            expenseCategoryNeedsReview: false,
          },
        ],
        fixedCostVersions: [
          {
            seriesId,
            version: 1,
            name: "Office lease",
            categoryId: "office_admin",
            categoryName: "Office/Admin",
            monthlyAmountCents: 31_000,
            effectiveStartDate: "2026-08-01",
            state: "active",
          },
        ],
      }),
    });

    expect(mapped.expenses[0]).toMatchObject({
      id: "covered-receipt",
      coveredByFixedCostSeriesId: seriesId,
    });
    expect(buildExpenseOverview(mapped)).toMatchObject({
      ordinaryExpensesCents: 0,
      fixedCostsCents: 7_000,
      totalExpensesCents: 7_000,
      fixedCosts: {
        coveredExpenseCount: 1,
        coveredExpenseAmountCents: 31_000,
      },
    });
  });

  it("maps confirmed dump facts for both reporting weeks", () => {
    const mapped = mapExpenseOverviewRows({
      weekStart: WEEK_START,
      asOf: "2026-08-24",
      rows: baseRows({
        expenses: [
          {
            id: "current-dump",
            amountCents: 9_141,
            currency: "USD",
            legacyCategory: "Dump Fees",
            categoryId: "dump_fees",
            categoryName: "Dump Fees",
            categoryNeedsReview: false,
            paidAt: new Date("2026-08-20T16:00:00.000Z"),
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "receipt_scan",
            reversalOfExpenseId: null,
          },
          {
            id: "prior-dump",
            amountCents: 5_000,
            currency: "USD",
            legacyCategory: "Dump Fees",
            categoryId: "dump_fees",
            categoryName: "Dump Fees",
            categoryNeedsReview: false,
            paidAt: new Date("2026-08-12T16:00:00.000Z"),
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            source: "receipt_scan",
            reversalOfExpenseId: null,
          },
        ],
        allocations: [
          {
            expenseId: "current-dump",
            amountCents: 9_141,
            categoryId: "dump_fees",
            categoryName: "Dump Fees",
            expenseCategoryNeedsReview: false,
          },
          {
            expenseId: "prior-dump",
            amountCents: 5_000,
            categoryId: "dump_fees",
            categoryName: "Dump Fees",
            expenseCategoryNeedsReview: false,
          },
        ],
        dumpDetails: [
          {
            expenseId: "current-dump",
            weightStatus: "confirmed",
            netWeightPounds: 2_900,
          },
          {
            expenseId: "prior-dump",
            weightStatus: "confirmed",
            netWeightPounds: 2_000,
          },
        ],
      }),
    });

    expect(mapped.dumpDetails).toEqual([
      {
        expenseId: "current-dump",
        weightStatus: "confirmed",
        netWeightPounds: 2_900,
      },
      {
        expenseId: "prior-dump",
        weightStatus: "confirmed",
        netWeightPounds: 2_000,
      },
    ]);
    expect(buildExpenseOverview(mapped)).toMatchObject({
      dumpActivity: {
        dumpFeeCents: 9_141,
        ticketCount: 1,
        weightedTicketCount: 1,
        netWeightPounds: 2_900,
        averageCostPerTonCents: 6_304,
        missingWeightCount: 0,
      },
      priorWeek: {
        dumpActivity: {
          dumpFeeCents: 5_000,
          ticketCount: 1,
          weightedTicketCount: 1,
          netWeightPounds: 2_000,
          averageCostPerTonCents: 5_000,
          missingWeightCount: 0,
        },
      },
    });
  });
});
