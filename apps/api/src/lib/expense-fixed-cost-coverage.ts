import { and, desc, eq, gte, inArray, isNull, lte, lt, ne } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  expenseAllocations,
  expenseFixedCostSeries,
  expenseFixedCostVersions,
  expenses,
} from "@/db";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";
import { isExpenseFixedCostsEnabled } from "@/lib/expense-feature-flags";

const TIME_ZONE = "America/New_York";
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export type ExpenseFixedCostCoverageMatch = {
  seriesId: string;
  version: number;
  monthlyAmountCents: number;
  categoryId: string;
};

type CoverageAllocation = {
  categoryId: string;
  amountCents: number;
};

export function assertFixedCostCoverageLinkCanBeEstablished(input: {
  existingSeriesId: string | null;
  requestedSeriesId: string | null;
  canManageCoverage?: boolean;
}): void {
  const changesLink = input.requestedSeriesId !== input.existingSeriesId;
  if (!changesLink) return;

  if (!input.canManageCoverage) {
    throw new TeamMutationFailure(
      "forbidden",
      "Owner approval and financial access are required to link a fixed cost.",
      {
        fieldErrors: {
          coveredByFixedCostSeriesId:
            "Ask an owner with financial access to add this link.",
        },
      },
    );
  }

  // Disabling the feature blocks new/relinked coverage, but an authorized
  // financial owner can still clear a bad link through immutable correction.
  if (input.requestedSeriesId && !isExpenseFixedCostsEnabled()) {
    throw new TeamMutationFailure(
      "forbidden",
      "Fixed-cost coverage is temporarily unavailable.",
      {
        fieldErrors: {
          coveredByFixedCostSeriesId:
            "Remove the fixed-cost link and try again.",
        },
      },
    );
  }
}

export function expenseFixedCostCoverageBusinessDate(
  value: Date | string,
): string {
  const parsed =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone: "utc" }).setZone(TIME_ZONE)
      : DATE_ONLY_PATTERN.test(value)
        ? DateTime.fromISO(value, { zone: TIME_ZONE })
        : DateTime.fromISO(value, { setZone: true }).setZone(TIME_ZONE);
  const businessDate = parsed.toISODate();
  if (!parsed.isValid || !businessDate) {
    throw new TeamMutationFailure(
      "invalid",
      "The fixed-cost coverage purchase date is invalid.",
      { fieldErrors: { purchaseDate: "Choose a valid purchase date." } },
    );
  }
  return businessDate;
}

/**
 * Validate an owner-selected coverage link while holding the same series lock
 * used by schedule revisions. This prevents a concurrent revision from
 * changing the accounting schedule between validation and expense insertion.
 */
export async function assertExpenseFixedCostCoverageLink(
  tx: TeamMutationTransaction,
  input: {
    seriesId: string;
    purchaseDate: Date | string;
    amountCents: number;
    categoryId: string | null;
    allocations: readonly CoverageAllocation[];
    replacesExpenseId?: string | null;
  },
): Promise<ExpenseFixedCostCoverageMatch> {
  const [series] = await tx
    .select({ id: expenseFixedCostSeries.id })
    .from(expenseFixedCostSeries)
    .where(eq(expenseFixedCostSeries.id, input.seriesId))
    .for("update", { of: expenseFixedCostSeries })
    .limit(1);
  if (!series) {
    throw new TeamMutationFailure(
      "invalid",
      "The selected fixed cost could not be found.",
      {
        fieldErrors: {
          coveredByFixedCostSeriesId: "Choose an existing fixed cost.",
        },
      },
    );
  }

  const purchaseDate = expenseFixedCostCoverageBusinessDate(input.purchaseDate);
  const [schedule] = await tx
    .select({
      version: expenseFixedCostVersions.version,
      monthlyAmountCents: expenseFixedCostVersions.monthlyAmountCents,
      categoryId: expenseFixedCostVersions.categoryId,
      state: expenseFixedCostVersions.state,
    })
    .from(expenseFixedCostVersions)
    .where(
      and(
        eq(expenseFixedCostVersions.seriesId, input.seriesId),
        lte(expenseFixedCostVersions.effectiveStartDate, purchaseDate),
      ),
    )
    .orderBy(
      desc(expenseFixedCostVersions.effectiveStartDate),
      desc(expenseFixedCostVersions.version),
    )
    .limit(1);
  if (!schedule || schedule.state !== "active") {
    throw new TeamMutationFailure(
      "invalid",
      "The selected fixed cost was not active on the purchase date.",
      {
        fieldErrors: {
          coveredByFixedCostSeriesId:
            "Choose a fixed cost active on this purchase date.",
        },
      },
    );
  }
  if (input.amountCents !== schedule.monthlyAmountCents) {
    throw new TeamMutationFailure(
      "invalid",
      "The receipt total must exactly match the fixed monthly amount.",
      {
        fieldErrors: {
          amountCents: `Enter exactly ${schedule.monthlyAmountCents} cents or remove the fixed-cost link.`,
        },
      },
    );
  }
  if (input.categoryId !== schedule.categoryId) {
    throw new TeamMutationFailure(
      "invalid",
      "The expense category must match the fixed-cost category.",
      {
        fieldErrors: {
          categoryId:
            "Use the fixed cost's category or remove the fixed-cost link.",
        },
      },
    );
  }
  if (
    input.allocations.length !== 1 ||
    input.allocations[0]?.categoryId !== schedule.categoryId ||
    input.allocations[0]?.amountCents !== schedule.monthlyAmountCents
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "An expense covered by a fixed cost cannot be split across categories.",
      {
        fieldErrors: {
          allocations:
            "Use one exact allocation matching the fixed cost or remove the link.",
        },
      },
    );
  }

  const purchaseMonth = DateTime.fromISO(purchaseDate, {
    zone: TIME_ZONE,
  }).startOf("month");
  const duplicateConditions = [
    eq(expenses.coveredByFixedCostSeriesId, input.seriesId),
    eq(expenses.lifecycleStatus, "posted"),
    isNull(expenses.reversalOfExpenseId),
    gte(expenses.paidAt, purchaseMonth.toUTC().toJSDate()),
    lt(expenses.paidAt, purchaseMonth.plus({ months: 1 }).toUTC().toJSDate()),
  ];
  if (input.replacesExpenseId) {
    duplicateConditions.push(ne(expenses.id, input.replacesExpenseId));
  }
  const [existingCoverage] = await tx
    .select({ id: expenses.id })
    .from(expenses)
    .where(and(...duplicateConditions))
    .limit(1);
  if (existingCoverage) {
    throw new TeamMutationFailure(
      "conflict",
      "This fixed cost already has linked receipt evidence for the month.",
      {
        fieldErrors: {
          coveredByFixedCostSeriesId:
            "Review the existing monthly receipt before linking another.",
        },
      },
    );
  }

  return {
    seriesId: series.id,
    version: schedule.version,
    monthlyAmountCents: schedule.monthlyAmountCents,
    categoryId: schedule.categoryId,
  };
}

/** Prevent a backdated schedule revision from invalidating posted evidence. */
export async function assertFixedCostRevisionPreservesCoverageLinks(
  tx: TeamMutationTransaction,
  input: {
    seriesId: string;
    effectiveStartDate: string;
    state: "active" | "ended";
    monthlyAmountCents: number;
    categoryId: string;
  },
): Promise<void> {
  const effectiveStartAt = DateTime.fromISO(input.effectiveStartDate, {
    zone: TIME_ZONE,
  })
    .startOf("day")
    .toUTC()
    .toJSDate();
  const linkedExpenses = await tx
    .select({
      id: expenses.id,
      amountCents: expenses.amount,
      categoryId: expenses.categoryId,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.coveredByFixedCostSeriesId, input.seriesId),
        eq(expenses.lifecycleStatus, "posted"),
        isNull(expenses.reversalOfExpenseId),
        gte(expenses.paidAt, effectiveStartAt),
      ),
    );
  if (linkedExpenses.length === 0) return;

  const allocations = await tx
    .select({
      expenseId: expenseAllocations.expenseId,
      categoryId: expenseAllocations.categoryId,
      amountCents: expenseAllocations.amountCents,
    })
    .from(expenseAllocations)
    .where(
      inArray(
        expenseAllocations.expenseId,
        linkedExpenses.map((expense) => expense.id),
      ),
    );
  const byExpense = new Map<string, CoverageAllocation[]>();
  for (const allocation of allocations) {
    const rows = byExpense.get(allocation.expenseId) ?? [];
    rows.push(allocation);
    byExpense.set(allocation.expenseId, rows);
  }

  const incompatible = linkedExpenses.some((expense) => {
    const expenseAllocations = byExpense.get(expense.id) ?? [];
    return (
      input.state !== "active" ||
      expense.amountCents !== input.monthlyAmountCents ||
      expense.categoryId !== input.categoryId ||
      expenseAllocations.length !== 1 ||
      expenseAllocations[0]?.categoryId !== input.categoryId ||
      expenseAllocations[0]?.amountCents !== input.monthlyAmountCents
    );
  });
  if (incompatible) {
    throw new TeamMutationFailure(
      "conflict",
      "This change would invalidate an expense already covered by the fixed cost.",
      {
        fieldErrors: {
          effectiveStartDate:
            "Choose a date after the linked receipt, or unlink/correct that expense first.",
        },
      },
    );
  }
}
