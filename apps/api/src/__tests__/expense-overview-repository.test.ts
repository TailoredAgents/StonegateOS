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
    commissions: [],
    payoutLines: [],
    payoutAdjustments: [],
    dailyAdEntries: [],
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
          source: "daily_ad_spend",
          reversalOfExpenseId: null,
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
    });

    const mapped = mapExpenseOverviewRows({
      weekStart: WEEK_START,
      rows,
      asOf: "2026-08-24",
    });
    const overview = buildExpenseOverview(mapped);

    expect(mapped.pendingExpenseCount).toBe(1);
    expect(mapped.omittedUnverifiedHistoricalRecordCount).toBe(1);
    expect(mapped.expenses.map((expense) => expense.id)).not.toContain(
      "foreign-expense",
    );
    expect(mapped.expenses.map((expense) => expense.id)).not.toContain(
      "reversal",
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
      ordinaryExpensesCents: 12_500,
      laborCents: 2_000,
      totalExpensesCents: 14_500,
      pendingExpenseCount: 1,
      omittedUnverifiedHistoricalRecordCount: 1,
      advertising: {
        amountCents: 2_000,
        subrows: { facebookCents: 2_000, googleCents: 0 },
      },
      priorWeek: {
        revenueCents: 80_000,
        ordinaryExpensesCents: 1_000,
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
          label: "Mystery charge",
          amountCents: 500,
          verified: false,
        }),
      ]),
    );
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
});
