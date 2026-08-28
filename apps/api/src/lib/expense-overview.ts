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
  /** Receipt evidence already represented by virtual fixed-cost accrual. */
  coveredByFixedCostSeriesId?: string | null;
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

export type ExpenseOverviewFixedCostInput = {
  seriesId: string;
  version: number;
  name: string;
  category: ExpenseOverviewCategoryInput;
  monthlyAmountCents: number;
  /** Inclusive Eastern business date. Same-date corrections use the version. */
  effectiveStartDate: string;
  state: "active" | "ended";
};

export type ExpenseOverviewDumpDetailInput = {
  expenseId: string;
  weightStatus: "confirmed" | "unreadable";
  /** Canonical US-pound measure. Null is allowed only when explicitly unreadable. */
  netWeightPounds: number | null;
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
  /** Human-confirmed dump-ticket facts; raw AI extraction is never reported. */
  dumpDetails?: readonly ExpenseOverviewDumpDetailInput[];
  /** Append-only effective-dated monthly overhead facts. */
  fixedCosts?: readonly ExpenseOverviewFixedCostInput[];
  /** Pending submissions whose purchase date falls in the selected week. */
  pendingExpenseCount: number;
  /** Used to avoid flagging future ad dates as missing. */
  asOf?: ExpenseOverviewDate;
  /** Rows excluded by the repository because historical evidence is unverified. */
  omittedUnverifiedHistoricalRecordCount?: number;
  /** Pending submissions whose purchase date falls in the prior week. */
  priorWeekPendingExpenseCount?: number;
  /** Prior-week rows excluded because historical evidence is unverified. */
  priorWeekOmittedUnverifiedHistoricalRecordCount?: number;
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
  /** Portion of this category accrued from owner-verified monthly costs. */
  fixedCostCents: number;
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

export type ExpenseOverviewDumpActivity = {
  /** All positive Dump Fees allocations included in the selected period. */
  dumpFeeCents: number;
  /** Posted, approved expenses with a positive Dump Fees allocation. */
  ticketCount: number;
  /** Tickets whose human-confirmed net weight is available. */
  weightedTicketCount: number;
  /** Sum of confirmed net weights in US pounds. */
  netWeightPounds: number;
  /** Effective final dump cost per US short ton for weighted tickets only. */
  averageCostPerTonCents: number | null;
  /** Dump expenses omitted from weight-based metrics because weight is absent. */
  missingWeightCount: number;
};

export type ExpenseOverviewPeriodMetrics = {
  revenueCents: number;
  ordinaryExpensesCents: number;
  fixedCostsCents: number;
  laborCents: number;
  totalExpensesCents: number;
  operatingProfitCents: number;
  expenseRatioPercent: number | null;
  dumpActivity: ExpenseOverviewDumpActivity;
};

export type ExpenseOverviewPercentChangeState =
  | "available"
  | "zero_baseline"
  | "incomplete";

export type ExpenseOverviewRatioChangeState =
  | "available"
  | "undefined_ratio"
  | "incomplete";

export type ExpenseOverviewPriorWeekChange = {
  /** True when both weeks have complete records; individual math may still be undefined. */
  available: boolean;
  states: {
    /** Percentage change is undefined when the prior amount is zero. */
    revenue: ExpenseOverviewPercentChangeState;
    /** Percentage change is undefined when the prior amount is zero. */
    expenses: ExpenseOverviewPercentChangeState;
    /** Percentage change is undefined when the prior amount is zero. */
    operatingProfit: ExpenseOverviewPercentChangeState;
    /** Percentage-point change requires a defined expense ratio in both weeks. */
    expenseRatio: ExpenseOverviewRatioChangeState;
  };
  revenueCents: number | null;
  revenuePercent: number | null;
  expensesCents: number | null;
  expensesPercent: number | null;
  operatingProfitCents: number | null;
  operatingProfitPercent: number | null;
  expenseRatioPercentagePoints: number | null;
  unavailableReasons: {
    currentWeek: ExpenseOverviewIncompleteReason[];
    priorWeek: ExpenseOverviewIncompleteReason[];
  };
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
  priorWeek: ExpenseOverviewWeekBoundary &
    ExpenseOverviewPeriodMetrics & {
      pendingExpenseCount: number;
      missingAdEntries: ExpenseOverviewMissingAdEntry[];
      missingCommissionDataCount: number;
      missingFinalTotalCount: number;
      omittedUnverifiedHistoricalRecordCount: number;
      unverifiedExpenseCategoryCount: number;
      fixedCosts: {
        amountCents: number;
        activeSeriesCount: number;
        coveredExpenseCount: number;
        coveredExpenseAmountCents: number;
      };
      completeness: {
        state: "complete" | "incomplete";
        reasons: ExpenseOverviewIncompleteReason[];
      };
    };
  priorWeekChange: ExpenseOverviewPriorWeekChange;
  categories: ExpenseOverviewCategory[];
  labor: ExpenseOverviewLaborBreakdown;
  advertising: ExpenseOverviewAdvertisingBreakdown;
  fixedCosts: {
    amountCents: number;
    activeSeriesCount: number;
    coveredExpenseCount: number;
    coveredExpenseAmountCents: number;
  };
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
  fixedCostCents: number;
  verified: boolean;
};

type CalculatedPeriod = {
  metrics: ExpenseOverviewPeriodMetrics;
  categoryTotals: Map<string, MutableCategoryTotal>;
  labor: ExpenseOverviewLaborBreakdown;
  advertising: ExpenseOverviewAdvertisingBreakdown;
  fixedCosts: {
    amountCents: number;
    activeSeriesCount: number;
    coveredExpenseCount: number;
    coveredExpenseAmountCents: number;
  };
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

function dumpDetailsByExpense(
  input: ExpenseOverviewInput,
): Map<string, ExpenseOverviewDumpDetailInput> {
  const byExpense = new Map<string, ExpenseOverviewDumpDetailInput>();
  for (const detail of input.dumpDetails ?? []) {
    const expenseId = detail.expenseId.trim();
    if (!expenseId) {
      throw new TypeError("Dump-ticket facts require an expense ID.");
    }
    if (byExpense.has(expenseId)) {
      throw new TypeError(
        `Duplicate dump-ticket facts for expense ${expenseId}.`,
      );
    }
    if (detail.weightStatus === "confirmed") {
      if (
        !Number.isSafeInteger(detail.netWeightPounds) ||
        (detail.netWeightPounds ?? 0) <= 0
      ) {
        throw new TypeError(
          `Confirmed dump-ticket weight for expense ${expenseId} must be positive pounds.`,
        );
      }
    } else if (
      detail.weightStatus !== "unreadable" ||
      detail.netWeightPounds !== null
    ) {
      throw new TypeError(
        `Unreadable dump-ticket weight for expense ${expenseId} must be null.`,
      );
    }
    byExpense.set(expenseId, { ...detail, expenseId });
  }
  return byExpense;
}

/** Round an effective final cost to the nearest cent per US short ton. */
function costPerShortTonCents(
  trackedDumpFeeCents: number,
  netWeightPounds: number,
): number | null {
  if (netWeightPounds === 0) return null;
  assertSafeCents(trackedDumpFeeCents, "tracked dump fees", {
    nonnegative: true,
  });
  assertCount(netWeightPounds, "dump net weight pounds");
  const numerator = BigInt(trackedDumpFeeCents) * 2_000n;
  const denominator = BigInt(netWeightPounds);
  const rounded = (numerator + denominator / 2n) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Dump cost per ton exceeds the safe integer range.");
  }
  return Number(rounded);
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
  options: { fixedCost?: boolean } = {},
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
    if (options.fixedCost === true) {
      existing.fixedCostCents = addCents(
        existing.fixedCostCents,
        allocation.amountCents,
        `category ${id} fixed-cost total`,
      );
    }
    existing.verified =
      existing.verified && allocation.category.verified !== false;
    return;
  }
  totals.set(id, {
    id,
    label,
    amountCents: allocation.amountCents,
    fixedCostCents: options.fixedCost === true ? allocation.amountCents : 0,
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

/** Exact-cent allocation of a monthly amount to one Eastern calendar day. */
export function expenseOverviewFixedCostDailyCents(
  monthlyAmountCents: number,
  businessDate: string,
): number {
  assertSafeCents(monthlyAmountCents, "fixed monthly amount", {
    nonnegative: true,
  });
  if (monthlyAmountCents === 0) {
    throw new TypeError("Fixed monthly amount must be greater than zero.");
  }
  const date = parseBusinessDate(businessDate, "fixed-cost business date");
  const daysInMonth = date.daysInMonth;
  if (!daysInMonth) throw new TypeError("Fixed-cost month is invalid.");
  const amount = BigInt(monthlyAmountCents);
  const day = BigInt(date.day);
  const days = BigInt(daysInMonth);
  return Number((amount * day) / days - (amount * (day - 1n)) / days);
}

function fixedCostEffectiveOnDate(
  input: ExpenseOverviewInput,
  seriesId: string,
  businessDate: string,
): ExpenseOverviewFixedCostInput | null {
  let effective: ExpenseOverviewFixedCostInput | null = null;
  for (const candidate of input.fixedCosts ?? []) {
    if (
      candidate.seriesId !== seriesId ||
      candidate.effectiveStartDate > businessDate
    ) {
      continue;
    }
    if (
      !effective ||
      candidate.effectiveStartDate > effective.effectiveStartDate ||
      (candidate.effectiveStartDate === effective.effectiveStartDate &&
        candidate.version > effective.version)
    ) {
      effective = candidate;
    }
  }
  return effective;
}

function calculateFixedCosts(
  input: ExpenseOverviewInput,
  period: Period,
  categoryTotals: Map<string, MutableCategoryTotal>,
): {
  amountCents: number;
  activeSeriesCount: number;
  advertisingCents: number;
} {
  const bySeries = new Map<string, ExpenseOverviewFixedCostInput[]>();
  const versionKeys = new Set<string>();
  for (const fixedCost of input.fixedCosts ?? []) {
    const seriesId = fixedCost.seriesId.trim();
    if (!seriesId) throw new TypeError("Fixed costs require a series ID.");
    if (!Number.isSafeInteger(fixedCost.version) || fixedCost.version < 1) {
      throw new TypeError("Fixed-cost versions must be positive integers.");
    }
    const versionKey = `${seriesId}:${fixedCost.version}`;
    if (versionKeys.has(versionKey)) {
      throw new TypeError(`Duplicate fixed-cost version ${versionKey}.`);
    }
    versionKeys.add(versionKey);
    assertSafeCents(fixedCost.monthlyAmountCents, "fixed monthly amount", {
      nonnegative: true,
    });
    if (fixedCost.monthlyAmountCents === 0) {
      throw new TypeError("Fixed monthly amount must be greater than zero.");
    }
    parseBusinessDate(
      fixedCost.effectiveStartDate,
      "fixed-cost effectiveStartDate",
    );
    const versions = bySeries.get(seriesId) ?? [];
    versions.push(fixedCost);
    bySeries.set(seriesId, versions);
  }
  for (const versions of bySeries.values()) {
    versions.sort(
      (left, right) =>
        left.effectiveStartDate.localeCompare(right.effectiveStartDate) ||
        left.version - right.version,
    );
  }

  let amountCents = 0;
  let advertisingCents = 0;
  const start = parseBusinessDate(period.startDate, "period start");
  const periodEnd = parseBusinessDate(period.endDate, "period end");
  const asOfDate = parseBusinessDate(
    easternDateKey(input.asOf ?? new Date(), "asOf"),
    "asOf",
  );
  // Historical weeks are complete reporting periods. The current week stops
  // at today, and a future week has no accrued fixed cost yet. This keeps
  // actual completed-job revenue from being compared with future overhead.
  const end = DateTime.min(periodEnd, asOfDate);
  if (end < start) {
    return { amountCents: 0, activeSeriesCount: 0, advertisingCents: 0 };
  }
  const dayCount = Math.round(end.diff(start, "days").days) + 1;
  for (let offset = 0; offset < dayCount; offset += 1) {
    const businessDate = start.plus({ days: offset }).toFormat("yyyy-MM-dd");
    for (const versions of bySeries.values()) {
      let effective: ExpenseOverviewFixedCostInput | null = null;
      // Ascending effective date and version make the final assignment the
      // authoritative row; the highest version wins same-day corrections.
      for (const version of versions) {
        if (version.effectiveStartDate > businessDate) break;
        effective = version;
      }
      if (!effective || effective.state === "ended") continue;
      const dailyCents = expenseOverviewFixedCostDailyCents(
        effective.monthlyAmountCents,
        businessDate,
      );
      amountCents = addCents(
        amountCents,
        dailyCents,
        "fixed-cost period total",
      );
      addCategoryAmount(
        categoryTotals,
        { amountCents: dailyCents, category: effective.category },
        { fixedCost: true },
      );
      if (isAdvertisingCategory(effective.category)) {
        advertisingCents = addCents(
          advertisingCents,
          dailyCents,
          "fixed advertising total",
        );
      }
    }
  }
  let activeSeriesCount = 0;
  const cutoffDate = end.toFormat("yyyy-MM-dd");
  for (const versions of bySeries.values()) {
    let effective: ExpenseOverviewFixedCostInput | null = null;
    for (const version of versions) {
      if (version.effectiveStartDate > cutoffDate) break;
      effective = version;
    }
    if (effective?.state === "active") activeSeriesCount += 1;
  }
  return {
    amountCents,
    activeSeriesCount,
    advertisingCents,
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
  let coveredExpenseCount = 0;
  let coveredExpenseAmountCents = 0;
  let dumpFeeCents = 0;
  let trackedDumpFeeCents = 0;
  let dumpTicketCount = 0;
  let weightedDumpTicketCount = 0;
  let dumpNetWeightPounds = 0;
  const dumpDetails = dumpDetailsByExpense(input);
  for (const expense of input.expenses) {
    if (
      expense.lifecycleStatus !== "posted" ||
      (expense.reviewStatus !== null &&
        expense.reviewStatus !== undefined &&
        expense.reviewStatus !== "approved") ||
      expense.source === "payout_run" ||
      expense.isReimbursementAdjustment === true
    ) {
      continue;
    }
    const date = easternDateKey(expense.purchaseDate, "expense purchaseDate");
    if (!inPeriod(date, period)) continue;
    const allocations = resolveAllocations(expense);
    let coveredByFixedCost = false;
    if (expense.coveredByFixedCostSeriesId) {
      if (expense.reviewStatus !== "approved") {
        throw new TypeError(
          "Expenses covered by fixed costs must be owner-approved.",
        );
      }
      const schedule = fixedCostEffectiveOnDate(
        input,
        expense.coveredByFixedCostSeriesId,
        date,
      );
      if (
        !schedule ||
        schedule.state !== "active" ||
        schedule.monthlyAmountCents !== expense.amountCents ||
        allocations.length !== 1 ||
        allocations[0]?.category.id !== schedule.category.id ||
        allocations[0]?.amountCents !== schedule.monthlyAmountCents
      ) {
        throw new TypeError(
          `Expense ${expense.id} does not reconcile to its fixed-cost coverage.`,
        );
      }
      coveredExpenseCount += 1;
      coveredExpenseAmountCents = addCents(
        coveredExpenseAmountCents,
        expense.amountCents,
        "fixed-cost covered evidence total",
      );
      coveredByFixedCost = true;
    }
    let expenseDumpFeeCents = 0;
    for (const allocation of allocations) {
      if (allocation.category.id === "dump_fees") {
        expenseDumpFeeCents = addCents(
          expenseDumpFeeCents,
          allocation.amountCents,
          `expense ${expense.id} dump allocation`,
        );
      }
    }
    if (expenseDumpFeeCents > 0) {
      dumpFeeCents = addCents(
        dumpFeeCents,
        expenseDumpFeeCents,
        "dump fee total",
      );
      dumpTicketCount += 1;
      const detail = dumpDetails.get(expense.id);
      if (
        detail?.weightStatus === "confirmed" &&
        detail.netWeightPounds !== null
      ) {
        trackedDumpFeeCents = addCents(
          trackedDumpFeeCents,
          expenseDumpFeeCents,
          "weighted dump fee total",
        );
        dumpNetWeightPounds = addCents(
          dumpNetWeightPounds,
          detail.netWeightPounds,
          "dump net weight pounds",
        );
        weightedDumpTicketCount += 1;
      }
    }
    if (coveredByFixedCost) continue;

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

  const fixedCostResult = calculateFixedCosts(input, period, categoryTotals);
  totalAdvertisingCents = addCents(
    totalAdvertisingCents,
    fixedCostResult.advertisingCents,
    "advertising category total with fixed costs",
  );

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
  const nonLaborExpensesCents = addCents(
    ordinaryExpensesCents,
    fixedCostResult.amountCents,
    "ordinary and fixed expenses",
  );
  const totalExpensesCents = addCents(
    nonLaborExpensesCents,
    laborResult.labor.amountCents,
    "total expenses including labor",
  );
  let categorizedExpensesCents = 0;
  let categorizedFixedCostsCents = 0;
  for (const category of categoryTotals.values()) {
    categorizedExpensesCents = addCents(
      categorizedExpensesCents,
      category.amountCents,
      "categorized expense total",
    );
    categorizedFixedCostsCents = addCents(
      categorizedFixedCostsCents,
      category.fixedCostCents,
      "categorized fixed-cost total",
    );
  }
  if (categorizedExpensesCents !== totalExpensesCents) {
    throw new TypeError("Expense category totals must equal total expenses.");
  }
  if (categorizedFixedCostsCents !== fixedCostResult.amountCents) {
    throw new TypeError(
      "Fixed-cost category totals must equal fixed-cost expenses.",
    );
  }
  const operatingProfitCents = addCents(
    revenueCents,
    -totalExpensesCents,
    "operating profit",
  );
  return {
    metrics: {
      revenueCents,
      ordinaryExpensesCents,
      fixedCostsCents: fixedCostResult.amountCents,
      laborCents: laborResult.labor.amountCents,
      totalExpensesCents,
      operatingProfitCents,
      expenseRatioPercent: percent(totalExpensesCents, revenueCents),
      dumpActivity: {
        dumpFeeCents,
        ticketCount: dumpTicketCount,
        weightedTicketCount: weightedDumpTicketCount,
        netWeightPounds: dumpNetWeightPounds,
        averageCostPerTonCents: costPerShortTonCents(
          trackedDumpFeeCents,
          dumpNetWeightPounds,
        ),
        missingWeightCount: dumpTicketCount - weightedDumpTicketCount,
      },
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
    fixedCosts: {
      amountCents: fixedCostResult.amountCents,
      activeSeriesCount: fixedCostResult.activeSeriesCount,
      coveredExpenseCount,
      coveredExpenseAmountCents,
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
  const priorWeekPendingExpenseCount = input.priorWeekPendingExpenseCount ?? 0;
  assertCount(priorWeekPendingExpenseCount, "priorWeekPendingExpenseCount");
  const omittedUnverifiedHistoricalRecordCount =
    input.omittedUnverifiedHistoricalRecordCount ?? 0;
  assertCount(
    omittedUnverifiedHistoricalRecordCount,
    "omittedUnverifiedHistoricalRecordCount",
  );
  const priorWeekOmittedUnverifiedHistoricalRecordCount =
    input.priorWeekOmittedUnverifiedHistoricalRecordCount ?? 0;
  assertCount(
    priorWeekOmittedUnverifiedHistoricalRecordCount,
    "priorWeekOmittedUnverifiedHistoricalRecordCount",
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
  const priorMissingAdEntries = getMissingAdEntries(input, priorWeekBoundary);
  const unverifiedExpenseCategoryCount = categories.filter(
    (category) => !category.verified,
  ).length;
  const priorUnverifiedExpenseCategoryCount = categoryOutput(prior).filter(
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

  const priorReasons: ExpenseOverviewIncompleteReason[] = [];
  if (priorMissingAdEntries.length > 0) {
    priorReasons.push("missing_ad_entries");
  }
  if (prior.missingCommissionDataCount > 0) {
    priorReasons.push("missing_commission_data");
  }
  if (prior.missingFinalTotalCount > 0) {
    priorReasons.push("missing_final_totals");
  }
  if (priorWeekPendingExpenseCount > 0) {
    priorReasons.push("pending_expenses");
  }
  if (priorWeekOmittedUnverifiedHistoricalRecordCount > 0) {
    priorReasons.push("unverified_historical_records");
  }
  if (priorUnverifiedExpenseCategoryCount > 0) {
    priorReasons.push("unverified_expense_categories");
  }
  const comparisonAvailable = reasons.length === 0 && priorReasons.length === 0;

  return {
    ...current.metrics,
    week,
    priorWeek: {
      ...priorWeekBoundary,
      ...prior.metrics,
      pendingExpenseCount: priorWeekPendingExpenseCount,
      missingAdEntries: priorMissingAdEntries,
      missingCommissionDataCount: prior.missingCommissionDataCount,
      missingFinalTotalCount: prior.missingFinalTotalCount,
      omittedUnverifiedHistoricalRecordCount:
        priorWeekOmittedUnverifiedHistoricalRecordCount,
      unverifiedExpenseCategoryCount: priorUnverifiedExpenseCategoryCount,
      fixedCosts: prior.fixedCosts,
      completeness: {
        state: priorReasons.length === 0 ? "complete" : "incomplete",
        reasons: priorReasons,
      },
    },
    priorWeekChange: {
      available: comparisonAvailable,
      states: {
        revenue: !comparisonAvailable
          ? "incomplete"
          : prior.metrics.revenueCents === 0
            ? "zero_baseline"
            : "available",
        expenses: !comparisonAvailable
          ? "incomplete"
          : prior.metrics.totalExpensesCents === 0
            ? "zero_baseline"
            : "available",
        operatingProfit: !comparisonAvailable
          ? "incomplete"
          : prior.metrics.operatingProfitCents === 0
            ? "zero_baseline"
            : "available",
        expenseRatio: !comparisonAvailable
          ? "incomplete"
          : current.metrics.expenseRatioPercent === null ||
              prior.metrics.expenseRatioPercent === null
            ? "undefined_ratio"
            : "available",
      },
      revenueCents: comparisonAvailable
        ? current.metrics.revenueCents - prior.metrics.revenueCents
        : null,
      revenuePercent: comparisonAvailable
        ? percentChange(
            current.metrics.revenueCents,
            prior.metrics.revenueCents,
          )
        : null,
      expensesCents: comparisonAvailable
        ? current.metrics.totalExpensesCents - prior.metrics.totalExpensesCents
        : null,
      expensesPercent: comparisonAvailable
        ? percentChange(
            current.metrics.totalExpensesCents,
            prior.metrics.totalExpensesCents,
          )
        : null,
      operatingProfitCents: comparisonAvailable
        ? current.metrics.operatingProfitCents -
          prior.metrics.operatingProfitCents
        : null,
      operatingProfitPercent: comparisonAvailable
        ? percentChange(
            current.metrics.operatingProfitCents,
            prior.metrics.operatingProfitCents,
          )
        : null,
      expenseRatioPercentagePoints:
        !comparisonAvailable ||
        current.metrics.expenseRatioPercent === null ||
        prior.metrics.expenseRatioPercent === null
          ? null
          : Math.round(
              (current.metrics.expenseRatioPercent -
                prior.metrics.expenseRatioPercent) *
                100,
            ) / 100,
      unavailableReasons: {
        currentWeek: reasons,
        priorWeek: priorReasons,
      },
    },
    categories,
    labor: current.labor,
    advertising: current.advertising,
    fixedCosts: current.fixedCosts,
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
