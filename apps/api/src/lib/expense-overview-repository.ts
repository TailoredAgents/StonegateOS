import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  appointmentCommissions,
  appointments,
  dailyAdSpend,
  expenseAllocations,
  expenseCategories,
  expenses,
  payoutRunAdjustments,
  payoutRunLines,
  payoutRuns,
  type DatabaseClient,
} from "@/db";
import {
  EXPENSE_OVERVIEW_TIME_ZONE,
  getExpenseOverviewWeekBoundary,
  type ExpenseOverviewAdPlatform,
  type ExpenseOverviewCategoryInput,
  type ExpenseOverviewInput,
  type ExpenseOverviewLaborGroup,
} from "@/lib/expense-overview";

type ExpenseLifecycleStatus =
  | "draft"
  | "posted"
  | "voided"
  | "corrected";
type ExpenseReviewStatus = "draft" | "pending" | "approved" | "rejected";
type PayoutRunStatus = "draft" | "locked" | "paid";
type CommissionRole = "sales" | "marketing" | "crew";

export type ExpenseOverviewRepositoryRows = {
  jobs: Array<{
    id: string;
    status: string;
    appointmentType: string;
    completedAt: Date | null;
    finalTotalCents: number | null;
  }>;
  expenses: Array<{
    id: string;
    amountCents: number;
    currency: string;
    legacyCategory: string | null;
    categoryId: string | null;
    categoryName: string | null;
    categoryNeedsReview: boolean;
    paidAt: Date;
    lifecycleStatus: ExpenseLifecycleStatus;
    reviewStatus: ExpenseReviewStatus;
    source: string;
    reversalOfExpenseId: string | null;
  }>;
  allocations: Array<{
    expenseId: string;
    amountCents: number;
    categoryId: string;
    categoryName: string;
    expenseCategoryNeedsReview: boolean;
  }>;
  commissions: Array<{
    appointmentId: string;
    completedAt: Date;
    role: CommissionRole;
    amountCents: number;
  }>;
  payoutLines: Array<{
    payoutRunId: string;
    status: PayoutRunStatus;
    periodStart: Date;
    crewCents: number | null;
    salesCents: number | null;
    marketingCents: number | null;
  }>;
  payoutAdjustments: Array<{
    payoutRunId: string;
    status: PayoutRunStatus;
    periodStart: Date;
    kind: string;
    amountCents: number;
  }>;
  dailyAdEntries: Array<{
    platform: ExpenseOverviewAdPlatform;
    businessDate: string;
    amountCents: number;
    currentExpenseId: string | null;
  }>;
};

export type ExpenseOverviewLoadWindow = {
  currentStartAt: Date;
  currentEndAtExclusive: Date;
  priorStartAt: Date;
  priorStartDate: string;
  endDateExclusive: string;
};

function addCents(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${field} exceeds the safe integer range.`);
  }
  return result;
}

function easternDate(value: Date): string {
  return (
    DateTime.fromJSDate(value, { zone: "utc" })
      .setZone(EXPENSE_OVERVIEW_TIME_ZONE)
      .toISODate() ?? ""
  );
}

export function getExpenseOverviewLoadWindow(
  weekStart: string,
): ExpenseOverviewLoadWindow {
  const current = getExpenseOverviewWeekBoundary(weekStart);
  const priorStart = DateTime.fromISO(current.startDate, {
    zone: EXPENSE_OVERVIEW_TIME_ZONE,
  }).minus({ days: 7 });
  const endExclusive = DateTime.fromISO(current.endDate, {
    zone: EXPENSE_OVERVIEW_TIME_ZONE,
  }).plus({ days: 1 });

  return {
    currentStartAt: new Date(current.startAt),
    currentEndAtExclusive: new Date(current.endAtExclusive),
    priorStartAt: priorStart.toUTC().toJSDate(),
    priorStartDate: priorStart.toFormat("yyyy-MM-dd"),
    endDateExclusive: endExclusive.toFormat("yyyy-MM-dd"),
  };
}

function categoryInput(input: {
  categoryId: string | null;
  categoryName: string | null;
  legacyCategory: string | null;
  needsReview: boolean;
}): ExpenseOverviewCategoryInput {
  const categoryId = input.categoryId?.trim() ?? "";
  const categoryName = input.categoryName?.trim() ?? "";
  if (categoryId && categoryName) {
    return {
      id: categoryId,
      label: categoryName,
      ...(categoryId === "advertising"
        ? { reportingGroup: "advertising" as const }
        : {}),
      verified: !input.needsReview,
    };
  }

  const legacyLabel = input.legacyCategory?.trim() || "Uncategorized";
  const stableLegacyKey = Buffer.from(
    legacyLabel.normalize("NFKC").toLocaleLowerCase("en-US"),
    "utf8",
  ).toString("base64url");
  return {
    id: `legacy:${stableLegacyKey}`,
    label: legacyLabel,
    verified: false,
  };
}

function commissionGroup(role: CommissionRole): ExpenseOverviewLaborGroup {
  if (role === "crew") return "crew";
  if (role === "sales") return "sales";
  // The persisted marketing commission is management compensation in the
  // payout contract and is reported under that user-facing labor subrow.
  return "management";
}

type MutablePayoutSnapshot = {
  weekStart: string;
  status: "locked" | "paid";
  crewCents: number;
  salesCents: number;
  managementCents: number;
  otherPayrollAdjustmentsCents: number;
};

function isCurrentWeekDate(
  date: Date,
  window: ExpenseOverviewLoadWindow,
): boolean {
  const timestamp = date.getTime();
  return (
    timestamp >= window.currentStartAt.getTime() &&
    timestamp < window.currentEndAtExclusive.getTime()
  );
}

/**
 * Convert repository-shaped rows into the calculator's deliberately small,
 * storage-agnostic contract. Exported for deterministic mapping tests.
 */
export function mapExpenseOverviewRows(input: {
  weekStart: string;
  rows: ExpenseOverviewRepositoryRows;
  asOf?: Date | string;
}): ExpenseOverviewInput {
  const window = getExpenseOverviewLoadWindow(input.weekStart);
  const allocationRowsByExpense = new Map<
    string,
    ExpenseOverviewRepositoryRows["allocations"]
  >();
  for (const allocation of input.rows.allocations) {
    const existing = allocationRowsByExpense.get(allocation.expenseId) ?? [];
    existing.push(allocation);
    allocationRowsByExpense.set(allocation.expenseId, existing);
  }

  const rawExpenseById = new Map(
    input.rows.expenses.map((expense) => [expense.id, expense] as const),
  );
  const dailyPlatformByExpenseId = new Map<
    string,
    ExpenseOverviewAdPlatform
  >();
  const excludedExpenseIds = new Set<string>();
  let omittedUnverifiedHistoricalRecordCount = 0;

  for (const entry of input.rows.dailyAdEntries) {
    if (entry.amountCents === 0) continue;
    const linked = entry.currentExpenseId
      ? rawExpenseById.get(entry.currentExpenseId)
      : undefined;
    const linkedCategory = linked
      ? categoryInput({
          categoryId: linked.categoryId,
          categoryName: linked.categoryName,
          legacyCategory: linked.legacyCategory,
          needsReview: linked.categoryNeedsReview,
        })
      : null;
    const linkedAllocations = linked
      ? (allocationRowsByExpense.get(linked.id) ?? [])
      : [];
    const advertisingAllocationCents = linkedAllocations.reduce(
      (total, allocation) =>
        allocation.categoryId === "advertising"
          ? addCents(total, allocation.amountCents, "advertising allocations")
          : total,
      0,
    );
    const linkedAdvertisingCents =
      linkedAllocations.length > 0
        ? advertisingAllocationCents
        : linkedCategory?.id === "advertising"
          ? (linked?.amountCents ?? 0)
          : 0;
    const validLink =
      linked !== undefined &&
      linked.reversalOfExpenseId === null &&
      linked.currency === "USD" &&
      linked.amountCents === entry.amountCents &&
      linked.source === "daily_ad_spend" &&
      linked.lifecycleStatus === "posted" &&
      linked.reviewStatus === "approved" &&
      easternDate(linked.paidAt) === entry.businessDate &&
      linkedAdvertisingCents === entry.amountCents;

    if (!validLink) {
      if (linked) excludedExpenseIds.add(linked.id);
      omittedUnverifiedHistoricalRecordCount += 1;
      continue;
    }
    dailyPlatformByExpenseId.set(linked.id, entry.platform);
  }

  const mappedExpenses: ExpenseOverviewInput["expenses"][number][] = [];
  for (const expense of input.rows.expenses) {
    if (expense.reversalOfExpenseId !== null) continue;
    if (
      excludedExpenseIds.has(expense.id) ||
      expense.currency !== "USD" ||
      !Number.isSafeInteger(expense.amountCents) ||
      expense.amountCents <= 0
    ) {
      if (!excludedExpenseIds.has(expense.id)) {
        omittedUnverifiedHistoricalRecordCount += 1;
      }
      continue;
    }
    const category = categoryInput({
      categoryId: expense.categoryId,
      categoryName: expense.categoryName,
      legacyCategory: expense.legacyCategory,
      needsReview: expense.categoryNeedsReview,
    });
    const allocationRows = allocationRowsByExpense.get(expense.id) ?? [];
    mappedExpenses.push({
      id: expense.id,
      amountCents: expense.amountCents,
      purchaseDate: expense.paidAt,
      lifecycleStatus: expense.lifecycleStatus,
      reviewStatus:
        expense.reviewStatus === "draft" ? null : expense.reviewStatus,
      source: expense.source,
      category,
      ...(allocationRows.length > 0
        ? {
            allocations: allocationRows.map((allocation) => ({
              amountCents: allocation.amountCents,
              category: categoryInput({
                categoryId: allocation.categoryId,
                categoryName: allocation.categoryName,
                legacyCategory: null,
                needsReview: allocation.expenseCategoryNeedsReview,
              }),
            })),
          }
        : {}),
      dailyAdPlatform: dailyPlatformByExpenseId.get(expense.id) ?? null,
    });
  }

  const payoutSnapshotsByRun = new Map<string, MutablePayoutSnapshot>();
  for (const line of input.rows.payoutLines) {
    if (line.status === "draft") continue;
    const existing = payoutSnapshotsByRun.get(line.payoutRunId) ?? {
      weekStart: easternDate(line.periodStart),
      status: line.status,
      crewCents: 0,
      salesCents: 0,
      managementCents: 0,
      otherPayrollAdjustmentsCents: 0,
    };
    existing.status = line.status;
    existing.crewCents = addCents(
      existing.crewCents,
      line.crewCents ?? 0,
      "payout crew total",
    );
    existing.salesCents = addCents(
      existing.salesCents,
      line.salesCents ?? 0,
      "payout sales total",
    );
    existing.managementCents = addCents(
      existing.managementCents,
      line.marketingCents ?? 0,
      "payout management total",
    );
    payoutSnapshotsByRun.set(line.payoutRunId, existing);
  }

  const payrollAdjustments: ExpenseOverviewInput["payrollAdjustments"][number][] =
    [];
  for (const adjustment of input.rows.payoutAdjustments) {
    const isReimbursement = adjustment.kind === "reimbursement";
    if (adjustment.status === "draft") {
      payrollAdjustments.push({
        accruedAt: adjustment.periodStart,
        amountCents: adjustment.amountCents,
        kind: isReimbursement ? "reimbursement" : "payroll",
      });
      continue;
    }
    if (isReimbursement) continue;
    const snapshot = payoutSnapshotsByRun.get(adjustment.payoutRunId);
    if (!snapshot) {
      // A finalized run must be present even when it contains zero payout
      // lines. The loader's left join normally creates that row.
      omittedUnverifiedHistoricalRecordCount += 1;
      continue;
    }
    snapshot.otherPayrollAdjustmentsCents = addCents(
      snapshot.otherPayrollAdjustmentsCents,
      adjustment.amountCents,
      "payout payroll adjustment total",
    );
  }

  const pendingExpenseCount = input.rows.expenses.filter(
    (expense) =>
      expense.reviewStatus === "pending" &&
      isCurrentWeekDate(expense.paidAt, window),
  ).length;

  return {
    weekStart: input.weekStart,
    jobs: input.rows.jobs.map((job) => ({
      ...job,
      commissionDataExpected: true,
    })),
    expenses: mappedExpenses,
    commissions: input.rows.commissions.map((commission) => ({
      appointmentId: commission.appointmentId,
      completedAt: commission.completedAt,
      group: commissionGroup(commission.role),
      amountCents: commission.amountCents,
    })),
    payrollAdjustments,
    payoutSnapshots: [...payoutSnapshotsByRun.values()],
    dailyAdEntries: input.rows.dailyAdEntries.map((entry) => ({
      platform: entry.platform,
      businessDate: entry.businessDate,
      amountCents: entry.amountCents,
    })),
    pendingExpenseCount,
    asOf: input.asOf ?? new Date(),
    omittedUnverifiedHistoricalRecordCount,
  };
}

/** Load the selected and prior Eastern weeks from one repeatable-read view. */
export async function loadExpenseOverviewInput(
  db: DatabaseClient,
  weekStart: string,
  options: { asOf?: Date | string } = {},
): Promise<ExpenseOverviewInput> {
  const window = getExpenseOverviewLoadWindow(weekStart);

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);

    const jobs = await tx
      .select({
        id: appointments.id,
        status: appointments.status,
        appointmentType: appointments.type,
        completedAt: appointments.completedAt,
        finalTotalCents: appointments.finalTotalCents,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.status, "completed"),
          eq(appointments.type, "job"),
          gte(appointments.completedAt, window.priorStartAt),
          lt(appointments.completedAt, window.currentEndAtExclusive),
        ),
      );

    const expenseRows = await tx
      .select({
        id: expenses.id,
        amountCents: expenses.amount,
        currency: expenses.currency,
        legacyCategory: expenses.category,
        categoryId: expenses.categoryId,
        categoryName: expenseCategories.name,
        categoryNeedsReview: expenses.categoryNeedsReview,
        paidAt: expenses.paidAt,
        lifecycleStatus: expenses.lifecycleStatus,
        reviewStatus: expenses.reviewStatus,
        source: expenses.source,
        reversalOfExpenseId: expenses.reversalOfExpenseId,
      })
      .from(expenses)
      .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
      .where(
        and(
          isNull(expenses.reversalOfExpenseId),
          gte(expenses.paidAt, window.priorStartAt),
          lt(expenses.paidAt, window.currentEndAtExclusive),
        ),
      );

    const allocations = await tx
      .select({
        expenseId: expenseAllocations.expenseId,
        amountCents: expenseAllocations.amountCents,
        categoryId: expenseAllocations.categoryId,
        categoryName: expenseCategories.name,
        expenseCategoryNeedsReview: expenses.categoryNeedsReview,
      })
      .from(expenseAllocations)
      .innerJoin(expenses, eq(expenseAllocations.expenseId, expenses.id))
      .innerJoin(
        expenseCategories,
        eq(expenseAllocations.categoryId, expenseCategories.id),
      )
      .where(
        and(
          isNull(expenses.reversalOfExpenseId),
          gte(expenses.paidAt, window.priorStartAt),
          lt(expenses.paidAt, window.currentEndAtExclusive),
        ),
      );

    const commissions = await tx
      .select({
        appointmentId: appointmentCommissions.appointmentId,
        completedAt: appointments.completedAt,
        role: appointmentCommissions.role,
        amountCents: appointmentCommissions.amountCents,
      })
      .from(appointmentCommissions)
      .innerJoin(
        appointments,
        eq(appointmentCommissions.appointmentId, appointments.id),
      )
      .where(
        and(
          eq(appointments.status, "completed"),
          eq(appointments.type, "job"),
          gte(appointments.completedAt, window.priorStartAt),
          lt(appointments.completedAt, window.currentEndAtExclusive),
        ),
      );

    const payoutLines = await tx
      .select({
        payoutRunId: payoutRuns.id,
        status: payoutRuns.status,
        periodStart: payoutRuns.periodStart,
        crewCents: payoutRunLines.crewCents,
        salesCents: payoutRunLines.salesCents,
        marketingCents: payoutRunLines.marketingCents,
      })
      .from(payoutRuns)
      .leftJoin(payoutRunLines, eq(payoutRuns.id, payoutRunLines.payoutRunId))
      .where(
        and(
          eq(payoutRuns.periodCanonical, true),
          eq(payoutRuns.timezone, EXPENSE_OVERVIEW_TIME_ZONE),
          gte(payoutRuns.periodStart, window.priorStartAt),
          lt(payoutRuns.periodStart, window.currentEndAtExclusive),
        ),
      );

    const payoutAdjustments = await tx
      .select({
        payoutRunId: payoutRuns.id,
        status: payoutRuns.status,
        periodStart: payoutRuns.periodStart,
        kind: payoutRunAdjustments.kind,
        amountCents: payoutRunAdjustments.amountCents,
      })
      .from(payoutRunAdjustments)
      .innerJoin(payoutRuns, eq(payoutRunAdjustments.payoutRunId, payoutRuns.id))
      .where(
        and(
          eq(payoutRuns.periodCanonical, true),
          eq(payoutRuns.timezone, EXPENSE_OVERVIEW_TIME_ZONE),
          gte(payoutRuns.periodStart, window.priorStartAt),
          lt(payoutRuns.periodStart, window.currentEndAtExclusive),
        ),
      );

    const dailyAdEntries = await tx
      .select({
        platform: dailyAdSpend.platform,
        businessDate: dailyAdSpend.businessDate,
        amountCents: dailyAdSpend.amountCents,
        currentExpenseId: dailyAdSpend.currentExpenseId,
      })
      .from(dailyAdSpend)
      .where(
        and(
          gte(dailyAdSpend.businessDate, window.priorStartDate),
          lt(dailyAdSpend.businessDate, window.endDateExclusive),
        ),
      );

    return {
      jobs,
      expenses: expenseRows,
      allocations,
      commissions: commissions.map((commission) => ({
        ...commission,
        // The joined time range proves this is non-null; keep the assertion at
        // the storage boundary instead of weakening the calculator contract.
        completedAt: commission.completedAt!,
      })),
      payoutLines,
      payoutAdjustments,
      dailyAdEntries,
    } satisfies ExpenseOverviewRepositoryRows;
  });

  return mapExpenseOverviewRows({
    weekStart,
    rows,
    asOf: options.asOf,
  });
}
