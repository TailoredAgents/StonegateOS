import { and, eq } from "drizzle-orm";
import { expenseCategories, expenseCategoryAliases } from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

export type ResolvedExpenseCategory = {
  category: string;
  categoryId: string | null;
  categoryNeedsReview: boolean;
};

export function normalizeExpenseCategoryAlias(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

/**
 * Resolve only explicit, seeded aliases. Unknown historical/user labels remain
 * unchanged and marked for review; this function never guesses a category.
 */
export async function resolveExpenseCategoryAlias(
  tx: TeamMutationTransaction,
  requestedLabel: string,
): Promise<ResolvedExpenseCategory> {
  const normalized = normalizeExpenseCategoryAlias(requestedLabel);
  const [resolved] = await tx
    .select({
      categoryId: expenseCategories.id,
      categoryName: expenseCategories.name,
    })
    .from(expenseCategoryAliases)
    .innerJoin(
      expenseCategories,
      eq(expenseCategoryAliases.categoryId, expenseCategories.id),
    )
    .where(
      and(
        eq(expenseCategoryAliases.normalizedAlias, normalized),
        eq(expenseCategories.isActive, true),
      ),
    )
    .limit(1);

  return resolved
    ? {
        category: resolved.categoryName,
        categoryId: resolved.categoryId,
        categoryNeedsReview: false,
      }
    : {
        category: requestedLabel,
        categoryId: null,
        categoryNeedsReview: true,
      };
}
