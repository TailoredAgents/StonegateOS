import { DateTime } from "luxon";

export const EXPENSE_OVERVIEW_TIME_ZONE = "America/New_York" as const;
export const EXPENSE_OVERVIEW_LABOR_CATEGORY_ID = "labor" as const;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const AD_PLATFORMS = ["facebook", "google"] as const;

export type ExpenseOverviewDate = Date | string;
export type ExpenseOverviewAdPlatform = (typeof AD_PLATFORMS)[number];
export type ExpenseOverviewLaborGroup = "crew" | "sales" | "management";
export type ExpenseOverviewLaborState = "actual" | "estimated";

export type ExpenseOverviewCategoryInput = {
  /** Stable category identifier. Historical unknowns should retain their own ID. */
  id: string;
  label: string;
  /** Marks categories that must feed the Advertising reporting breakdown. */
  reportingGroup?: "advertising";
  /** Set false for a preserved historical label that has not been mapped. */
  verified?: boolean;
};

export type ExpenseOverviewAllocationInput = {
  amountCents: number;
  category: ExpenseOverviewCategoryInput;
};

export type ExpenseOverviewExpenseInput = {
  id: string;
  amountCents: number;
  purchaseDate: ExpenseOverviewDate;
  lifecycleStatus: "draft" | "posted" | "voided" | "corrected";
  reviewStatus?: "pending" | "approved" | "rejected" | null;
  source: string;
  category: ExpenseOverviewCategoryInput;
  allocations?: readonly ExpenseOverviewAllocationInput[];
  /** True only for a payout/claim adjustment that repays an existing purchase. */
  isReimbursementAdjustment?: boolean;
  /** Set only for an expense created from the manual daily-ad registry. */
  dailyAdPlatform?: ExpenseOverviewAdPlatform | null;
};

export type ExpenseOverviewJobInput = {
  id: string;
  status: string;
  appointmentType: string;
  completedAt: ExpenseOverviewDate | null;
  finalTotalCents: number | null;
  /** False when a completed job is known not to require commission rows. */
  commissionDataExpected?: boolean;
};

export type ExpenseOverviewCommissionInput = {
  appointmentId: string;
  completedAt: ExpenseOverviewDate;
  group: ExpenseOverviewLaborGroup;
  amountCents: number;
};

export type ExpenseOverviewPayrollAdjustmentInput = {
  accruedAt: ExpenseOverviewDate;
  amountCents: number;
  /** Reimbursements are excluded because the underlying purchase is the expense. */
  kind: "payroll" | "reimbursement";
};

export type ExpenseOverviewPayoutSnapshotInput = {
  weekStart: string;
  status: "draft" | "locked" | "paid";
  crewCents: number;
  salesCents: number;
  managementCents: number;
  /** Must exclude reimbursement adjustments. */
  otherPayrollAdjustmentsCents: number;
};

export type ExpenseOverviewDailyAdInput = {
  platform: ExpenseOverviewAdPlatform;
  businessDate: string;
  /** Zero is a confirmed entry and is distinct from an absent row. */
  amountCents: number;
};

export type ExpenseOverviewInput = {
  /** Exact Eastern Monday in YYYY-MM-DD form. */
  weekStart: string;
  jobs: readonly ExpenseOverviewJobInput[];
  expenses: readonly ExpenseOverviewExpenseInput[];
  commissions: readonly ExpenseOverviewCommissionInput[];
  payrollAdjustments: readonly ExpenseOverviewPayrollAdjustmentInput[];
  payoutSnapshots: readonly ExpenseOverviewPayoutSnapshotInput[];
  dailyAdEntries: readonly ExpenseOverviewDailyAdInput[];
  /** Pending submissions whose purchase date falls in the selected week. */
  pendingExpenseCount: number;
  /** Used to avoid flagging future ad dates as missing. */
  asOf?: ExpenseOverviewDate;
  /** Rows excluded by the repository because historical evidence is unverified. */
  omittedUnverifiedHistoricalRecordCount?: number;
};

export type ExpenseOverviewWeekBoundary = {
  timezone: typeof EXPENSE_OVERVIEW_TIME_ZONE;
  startDate: string;
  endDate: string;
  startAt: string;
  endAtExclusive: string;
};

export type ExpenseOverviewCategory = {
  id: string;
  label: string;
  amountCents: number;
  percentOfExpenses: number | null;
  percentOfRevenue: number | null;
  verified: boolean;
};

export type ExpenseOverviewLaborBreakdown = {
  state: ExpenseOverviewLaborState;
  amountCents: number;
  subrows: {
    crewCents: number;
    salesCents: number;
    managementCents: number;
    otherPayrollAdjustmentsCents: number;
  };
};

export type ExpenseOverviewAdvertisingBreakdown = {
  amountCents: number;
  subrows: {
    facebookCents: number;
    googleCents: number;
  };
  /** Advertising allocations not tied to either daily-ad platform. */
  unattributedCents: number;
};

export type ExpenseOverviewPeriodMetrics = {
  revenueCents: number;
  ordinaryExpensesCents: number;
  laborCents: number;
  totalExpensesCents: number;
  operatingProfitCents: number;
  expenseRatioPercent: number | null;
};

export type ExpenseOverviewPriorWeekChange = {
  revenueCents: number;
  revenuePercent: number | null;
  expensesCents: number;
  expensesPercent: number | null;
  operatingProfitCents: number;
  operatingProfitPercent: number | null;
  expenseRatioPercentagePoints: number | null;
};

export type ExpenseOverviewMissingAdEntry = {
  businessDate: string;
  missingPlatforms: ExpenseOverviewAdPlatform[];
};

export type ExpenseOverviewIncompleteReason =
  | "missing_ad_entries"
  | "missing_commission_data"
  | "missing_final_totals"
  | "pending_expenses"
  | "unverified_historical_records"
  | "unverified_expense_categories";

export type ExpenseOverviewResult = ExpenseOverviewPeriodMetrics & {
  week: ExpenseOverviewWeekBoundary;
  priorWeek: ExpenseOverviewWeekBoundary & ExpenseOverviewPeriodMetrics;
  priorWeekChange: ExpenseOverviewPriorWeekChange;
  categories: ExpenseOverviewCategory[];
  labor: ExpenseOverviewLaborBreakdown;
  advertising: ExpenseOverviewAdvertisingBreakdown;
  pendingExpenseCount: number;
  missingAdEntries: ExpenseOverviewMissingAdEntry[];
  missingCommissionDataCount: number;
  missingFinalTotalCount: number;
  omittedUnverifiedHistoricalRecordCount: number;
  unverifiedExpenseCategoryCount: number;
  completeness: {
    state: "complete" | "incomplete";
    reasons: ExpenseOverviewIncompleteReason[];
  };
};

type Period = {
  startDate: string;
  endDate: string;
};

type MutableCategoryTotal = {
  id: string;
  label: string;
  amountCents: number;
  verified: boolean;
};

type CalculatedPeriod = {
  metrics: ExpenseOverviewPeriodMetrics;
  categoryTotals: Map<string, MutableCategoryTotal>;
  labor: ExpenseOverviewLaborBreakdown;
  advertising: ExpenseOverviewAdvertisingBreakdown;
  missingCommissionDataCount: number;
  missingFinalTotalCount: number;
};

function assertSafeCents(
  value: number,
  name: string,
  options: { nonnegative?: boolean } = {},
): void {
  if (
    !Number.isSafeInteger(value) ||
    (options.nonnegative === true && value < 0)
  ) {
    throw new TypeError(`${name} must be a safe integer number of cents.`);
  }
}

function addCents(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${name} exceeds the safe integer range.`);
  }
  return result;
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer.`);
  }
}

function parseBusinessDate(value: string, name: string): DateTime {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new TypeError(`${name} must use YYYY-MM-DD.`);
  }
  const parsed = DateTime.fromISO(value, {
    zone: EXPENSE_OVERVIEW_TIME_ZONE,
  }).startOf("day");
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd") !== value) {
    throw new TypeError(`${name} is not a valid calendar date.`);
  }
  return parsed;
}

function easternDateKey(value: ExpenseOverviewDate, name: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`${name} must be a valid date.`);
    }
    return (
      DateTime.fromJSDate(value, { zone: "utc" })
        .setZone(EXPENSE_OVERVIEW_TIME_ZONE)
        .toISODate() ?? ""
    );
  }

  if (DATE_ONLY_PATTERN.test(value)) {
    return parseBusinessDate(value, name).toFormat("yyyy-MM-dd");
  }

  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid || !parsed.isOffsetFixed) {
    throw new TypeError(
      `${name} must be a date or an ISO timestamp with offset.`,
    );
  }
  return parsed.setZone(EXPENSE_OVERVIEW_TIME_ZONE).toISODate() ?? "";
}

export function getExpenseOverviewWeekBoundary(
  weekStart: string,
): ExpenseOverviewWeekBoundary {
  const start = parseBusinessDate(weekStart, "weekStart");
  if (start.weekday !== 1) {
    throw new TypeError("weekStart must be a Monday in America/New_York.");
  }
  const endExclusive = start.plus({ days: 7 });
  return {
    timezone: EXPENSE_OVERVIEW_TIME_ZONE,
    startDate: start.toFormat("yyyy-MM-dd"),
    endDate: endExclusive.minus({ days: 1 }).toFormat("yyyy-MM-dd"),
    startAt: start.toUTC().toISO() ?? "",
    endAtExclusive: endExclusive.toUTC().toISO() ?? "",
  };
}

function inPeriod(date: string, period: Period): boolean {
  return date >= period.startDate && date <= period.endDate;
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function percentChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return Math.round(((current - prior) / Math.abs(prior)) * 10_000) / 100;
}

function resolveAllocations(
  expense: ExpenseOverviewExpenseInput,
): readonly ExpenseOverviewAllocationInput[] {
  assertSafeCents(expense.amountCents, `expense ${expense.id} amount`, {
    nonnegative: true,
  });
  if (!expense.allocations || expense.allocations.length === 0) {
    return [{ amountCents: expense.amountCents, category: expense.category }];
  }

  let allocationTotal = 0;
  for (const allocation of expense.allocations) {
    assertSafeCents(
      allocation.amountCents,
      `expense ${expense.id} allocation`,
      { nonnegative: true },
    );
    allocationTotal = addCents(
      allocationTotal,
      allocation.amountCents,
      `expense ${expense.id} allocation total`,
    );
  }
  if (allocationTotal !== expense.amountCents) {
    throw new TypeError(
      `Expense ${expense.id} allocations must exactly equal its amount.`,
    );
  }
  return expense.allocations;
}

function isAdvertisingCategory(
  category: ExpenseOverviewCategoryInput,
): boolean {
  return (
    category.reportingGroup === "advertising" || category.id === "advertising"
  );
}

function addCategoryAmount(
  totals: Map<string, MutableCategoryTotal>,
  allocation: ExpenseOverviewAllocationInput,
): void {
  const id = allocation.category.id.trim();
  const label = allocation.category.label.trim();
  if (!id || !label) {
    throw new TypeError("Expense categories require a stable ID and label.");
  }
  const existing = totals.get(id);
  if (existing) {
    existing.amountCents = addCents(
      existing.amountCents,
      allocation.amountCents,
      `category ${id} total`,
    );
    existing.verified =
      existing.verified && allocation.category.verified !== false;
    return;
  }
  totals.set(id, {
    id,
    label,
    amountCents: allocation.amountCents,
    verified: allocation.category.verified !== false,
  });
}

function selectPayoutSnapshot(
  inputs: readonly ExpenseOverviewPayoutSnapshotInput[],
  weekStart: string,
): ExpenseOverviewPayoutSnapshotInput | null {
  const snapshots = inputs.filter(
    (snapshot) =>
      snapshot.weekStart === weekStart && snapshot.status !== "draft",
  );
  if (snapshots.length > 1) {
    throw new TypeError(
      `Multiple finalized payout snapshots exist for week ${weekStart}.`,
    );
  }
  return snapshots[0] ?? null;
}

function calculateLabor(
  input: ExpenseOverviewInput,
  period: Period,
): {
  labor: ExpenseOverviewLaborBreakdown;
  missingCommissionDataCount: number;
} {
  const snapshot = selectPayoutSnapshot(
    input.payoutSnapshots,
    period.startDate,
  );
  if (snapshot) {
    assertSafeCents(snapshot.crewCents, "payout crew", { nonnegative: true });
    assertSafeCents(snapshot.salesCents, "payout sales", { nonnegative: true });
    assertSafeCents(snapshot.managementCents, "payout management", {
      nonnegative: true,
    });
    assertSafeCents(
      snapshot.otherPayrollAdjustmentsCents,
      "payout payroll adjustments",
    );
    const amountCents = [
      snapshot.crewCents,
      snapshot.salesCents,
      snapshot.managementCents,
      snapshot.otherPayrollAdjustmentsCents,
    ].reduce((total, value) => addCents(total, value, "actual labor total"), 0);
    return {
      labor: {
        state: "actual",
        amountCents,
        subrows: {
          crewCents: snapshot.crewCents,
          salesCents: snapshot.salesCents,
          managementCents: snapshot.managementCents,
          otherPayrollAdjustmentsCents: snapshot.otherPayrollAdjustmentsCents,
        },
      },
      missingCommissionDataCount: 0,
    };
  }

  const subrows = {
    crewCents: 0,
    salesCents: 0,
    managementCents: 0,
    otherPayrollAdjustmentsCents: 0,
  };
  const eligibleJobIds = new Set(
    input.jobs
      .filter((job) => {
        if (
          job.status !== "completed" ||
          job.appointmentType !== "job" ||
          job.completedAt === null
        ) {
          return false;
        }
        return inPeriod(
          easternDateKey(job.completedAt, "job completedAt"),
          period,
        );
      })
      .map((job) => job.id),
  );
  const appointmentIdsWithCommissionData = new Set<string>();
  for (const commission of input.commissions) {
    const date = easternDateKey(
      commission.completedAt,
      "commission completedAt",
    );
    if (
      !inPeriod(date, period) ||
      !eligibleJobIds.has(commission.appointmentId)
    ) {
      continue;
    }
    assertSafeCents(commission.amountCents, "commission amount", {
      nonnegative: true,
    });
    appointmentIdsWithCommissionData.add(commission.appointmentId);
    if (commission.group === "crew") {
      subrows.crewCents = addCents(
        subrows.crewCents,
        commission.amountCents,
        "crew labor total",
      );
    } else if (commission.group === "sales") {
      subrows.salesCents = addCents(
        subrows.salesCents,
        commission.amountCents,
        "sales labor total",
      );
    } else {
      subrows.managementCents = addCents(
        subrows.managementCents,
        commission.amountCents,
        "management labor total",
      );
    }
  }
  for (const adjustment of input.payrollAdjustments) {
    const date = easternDateKey(adjustment.accruedAt, "adjustment accruedAt");
    if (!inPeriod(date, period) || adjustment.kind === "reimbursement") {
      continue;
    }
    assertSafeCents(adjustment.amountCents, "payroll adjustment amount");
    subrows.otherPayrollAdjustmentsCents = addCents(
      subrows.otherPayrollAdjustmentsCents,
      adjustment.amountCents,
      "other payroll adjustment total",
    );
  }

  let missingCommissionDataCount = 0;
  for (const job of input.jobs) {
    if (
      job.status !== "completed" ||
      job.appointmentType !== "job" ||
      job.completedAt === null ||
      job.commissionDataExpected === false
    ) {
      continue;
    }
    const date = easternDateKey(job.completedAt, "job completedAt");
    if (
      inPeriod(date, period) &&
      !appointmentIdsWithCommissionData.has(job.id)
    ) {
      missingCommissionDataCount += 1;
    }
  }

  const amountCents = Object.values(subrows).reduce(
    (total, value) => addCents(total, value, "estimated labor total"),
    0,
  );
  return {
    labor: { state: "estimated", amountCents, subrows },
    missingCommissionDataCount,
  };
}

function calculatePeriod(
  input: ExpenseOverviewInput,
  boundary: ExpenseOverviewWeekBoundary,
): CalculatedPeriod {
  const period: Period = {
    startDate: boundary.startDate,
    endDate: boundary.endDate,
  };
  let revenueCents = 0;
  let missingFinalTotalCount = 0;
  for (const job of input.jobs) {
    if (
      job.status !== "completed" ||
      job.appointmentType !== "job" ||
      job.completedAt === null
    ) {
      continue;
    }
    const date = easternDateKey(job.completedAt, "job completedAt");
    if (!inPeriod(date, period)) continue;
    if (job.finalTotalCents === null) {
      missingFinalTotalCount += 1;
      continue;
    }
    assertSafeCents(job.finalTotalCents, "job final total", {
      nonnegative: true,
    });
    revenueCents = addCents(
      revenueCents,
      job.finalTotalCents,
      "completed-job revenue",
    );
  }

  let ordinaryExpensesCents = 0;
  const categoryTotals = new Map<string, MutableCategoryTotal>();
  let totalAdvertisingCents = 0;
  let facebookCents = 0;
  let googleCents = 0;
  for (const expense of input.expenses) {
    if (
      expense.lifecycleStatus !== "posted" ||
      expense.reviewStatus === "rejected" ||
      expense.source === "payout_run" ||
      expense.isReimbursementAdjustment === true
    ) {
      continue;
    }
    const date = easternDateKey(expense.purchaseDate, "expense purchaseDate");
    if (!inPeriod(date, period)) continue;
    const allocations = resolveAllocations(expense);
    ordinaryExpensesCents = addCents(
      ordinaryExpensesCents,
      expense.amountCents,
      "ordinary expense total",
    );
    let expenseAdvertisingCents = 0;
    for (const allocation of allocations) {
      addCategoryAmount(categoryTotals, allocation);
      if (isAdvertisingCategory(allocation.category)) {
        expenseAdvertisingCents = addCents(
          expenseAdvertisingCents,
          allocation.amountCents,
          `expense ${expense.id} advertising allocation`,
        );
      }
    }
    totalAdvertisingCents = addCents(
      totalAdvertisingCents,
      expenseAdvertisingCents,
      "advertising category total",
    );
    if (expense.dailyAdPlatform === "facebook") {
      facebookCents = addCents(
        facebookCents,
        expenseAdvertisingCents,
        "Facebook advertising total",
      );
    } else if (expense.dailyAdPlatform === "google") {
      googleCents = addCents(
        googleCents,
        expenseAdvertisingCents,
        "Google advertising total",
      );
    }
  }

  const laborResult = calculateLabor(input, period);
  if (laborResult.labor.amountCents !== 0) {
    addCategoryAmount(categoryTotals, {
      amountCents: laborResult.labor.amountCents,
      category: {
        id: EXPENSE_OVERVIEW_LABOR_CATEGORY_ID,
        label: "Labor",
        verified: true,
      },
    });
  }

  const attributedAdCents = addCents(
    facebookCents,
    googleCents,
    "attributed advertising total",
  );
  const totalExpensesCents = addCents(
    ordinaryExpensesCents,
    laborResult.labor.amountCents,
    "total expenses",
  );
  const operatingProfitCents = addCents(
    revenueCents,
    -totalExpensesCents,
    "operating profit",
  );
  return {
    metrics: {
      revenueCents,
      ordinaryExpensesCents,
      laborCents: laborResult.labor.amountCents,
      totalExpensesCents,
      operatingProfitCents,
      expenseRatioPercent: percent(totalExpensesCents, revenueCents),
    },
    categoryTotals,
    labor: laborResult.labor,
    advertising: {
      amountCents: totalAdvertisingCents,
      subrows: { facebookCents, googleCents },
      unattributedCents: addCents(
        totalAdvertisingCents,
        -attributedAdCents,
        "unattributed advertising total",
      ),
    },
    missingCommissionDataCount: laborResult.missingCommissionDataCount,
    missingFinalTotalCount,
  };
}

function getMissingAdEntries(
  input: ExpenseOverviewInput,
  boundary: ExpenseOverviewWeekBoundary,
): ExpenseOverviewMissingAdEntry[] {
  const asOfDate = easternDateKey(input.asOf ?? new Date(), "asOf");
  const entries = new Set<string>();
  for (const entry of input.dailyAdEntries) {
    const date = parseBusinessDate(
      entry.businessDate,
      "daily ad businessDate",
    ).toFormat("yyyy-MM-dd");
    assertSafeCents(entry.amountCents, "daily ad amount", {
      nonnegative: true,
    });
    const key = `${entry.platform}:${date}`;
    if (entries.has(key)) {
      throw new TypeError(
        `Duplicate daily ad entry for ${entry.platform} on ${date}.`,
      );
    }
    entries.add(key);
  }

  const start = parseBusinessDate(boundary.startDate, "week start");
  const missing: ExpenseOverviewMissingAdEntry[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const businessDate = start.plus({ days: offset }).toFormat("yyyy-MM-dd");
    // Today's spend is not considered missing until the following day.
    if (businessDate >= asOfDate) continue;
    const missingPlatforms = AD_PLATFORMS.filter(
      (platform) => !entries.has(`${platform}:${businessDate}`),
    );
    if (missingPlatforms.length > 0) {
      missing.push({ businessDate, missingPlatforms: [...missingPlatforms] });
    }
  }
  return missing;
}

function categoryOutput(period: CalculatedPeriod): ExpenseOverviewCategory[] {
  return Array.from(period.categoryTotals.values())
    .filter((category) => category.amountCents !== 0)
    .map((category) => ({
      ...category,
      percentOfExpenses: percent(
        category.amountCents,
        period.metrics.totalExpensesCents,
      ),
      percentOfRevenue: percent(
        category.amountCents,
        period.metrics.revenueCents,
      ),
    }))
    .sort(
      (left, right) =>
        right.amountCents - left.amountCents ||
        left.label.localeCompare(right.label),
    );
}

export function buildExpenseOverview(
  input: ExpenseOverviewInput,
): ExpenseOverviewResult {
  assertCount(input.pendingExpenseCount, "pendingExpenseCount");
  const omittedUnverifiedHistoricalRecordCount =
    input.omittedUnverifiedHistoricalRecordCount ?? 0;
  assertCount(
    omittedUnverifiedHistoricalRecordCount,
    "omittedUnverifiedHistoricalRecordCount",
  );

  const week = getExpenseOverviewWeekBoundary(input.weekStart);
  const priorStart = parseBusinessDate(week.startDate, "weekStart")
    .minus({ days: 7 })
    .toFormat("yyyy-MM-dd");
  const priorWeekBoundary = getExpenseOverviewWeekBoundary(priorStart);
  const current = calculatePeriod(input, week);
  const prior = calculatePeriod(input, priorWeekBoundary);
  const categories = categoryOutput(current);
  const missingAdEntries = getMissingAdEntries(input, week);
  const unverifiedExpenseCategoryCount = categories.filter(
    (category) => !category.verified,
  ).length;

  const reasons: ExpenseOverviewIncompleteReason[] = [];
  if (missingAdEntries.length > 0) reasons.push("missing_ad_entries");
  if (current.missingCommissionDataCount > 0) {
    reasons.push("missing_commission_data");
  }
  if (current.missingFinalTotalCount > 0) {
    reasons.push("missing_final_totals");
  }
  if (input.pendingExpenseCount > 0) reasons.push("pending_expenses");
  if (omittedUnverifiedHistoricalRecordCount > 0) {
    reasons.push("unverified_historical_records");
  }
  if (unverifiedExpenseCategoryCount > 0) {
    reasons.push("unverified_expense_categories");
  }

  return {
    ...current.metrics,
    week,
    priorWeek: { ...priorWeekBoundary, ...prior.metrics },
    priorWeekChange: {
      revenueCents: current.metrics.revenueCents - prior.metrics.revenueCents,
      revenuePercent: percentChange(
        current.metrics.revenueCents,
        prior.metrics.revenueCents,
      ),
      expensesCents:
        current.metrics.totalExpensesCents - prior.metrics.totalExpensesCents,
      expensesPercent: percentChange(
        current.metrics.totalExpensesCents,
        prior.metrics.totalExpensesCents,
      ),
      operatingProfitCents:
        current.metrics.operatingProfitCents -
        prior.metrics.operatingProfitCents,
      operatingProfitPercent: percentChange(
        current.metrics.operatingProfitCents,
        prior.metrics.operatingProfitCents,
      ),
      expenseRatioPercentagePoints:
        current.metrics.expenseRatioPercent === null ||
        prior.metrics.expenseRatioPercent === null
          ? null
          : Math.round(
              (current.metrics.expenseRatioPercent -
                prior.metrics.expenseRatioPercent) *
                100,
            ) / 100,
    },
    categories,
    labor: current.labor,
    advertising: current.advertising,
    pendingExpenseCount: input.pendingExpenseCount,
    missingAdEntries,
    missingCommissionDataCount: current.missingCommissionDataCount,
    missingFinalTotalCount: current.missingFinalTotalCount,
    omittedUnverifiedHistoricalRecordCount,
    unverifiedExpenseCategoryCount,
    completeness: {
      state: reasons.length === 0 ? "complete" : "incomplete",
      reasons,
    },
  };
}
