import * as React from "react";
import { CircleAlert } from "lucide-react";
import { formatExpenseMoney, formatExpensePercent } from "./spend-v2-utils";

export type MobileExpenseDonutCategory = {
  id: string;
  label: string;
  amountCents: number;
  percentOfExpenses: number | null;
  percentOfRevenue: number | null;
  verified: boolean;
};

export type MobileExpenseDonutSegment = {
  id: string;
  label: string;
  amountCents: number;
  percent: number;
  color: string;
  categoryIds: string[];
  grouped: boolean;
};

const DIRECT_SEGMENT_COLORS = [
  "#67e8f9",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#60a5fa",
  "#f472b6",
  "#a3e635",
] as const;
const OTHER_SEGMENT_COLOR = "#64748b";

function stableCategoryColorIndex(categoryId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < categoryId.length; index += 1) {
    hash ^= categoryId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % DIRECT_SEGMENT_COLORS.length;
}

function sortedCategories(
  categories: readonly MobileExpenseDonutCategory[],
): MobileExpenseDonutCategory[] {
  return [...categories].sort(
    (left, right) =>
      right.amountCents - left.amountCents ||
      left.label.localeCompare(right.label) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Keep the chart readable on a phone: the five largest positive categories
 * receive a slice and every remaining positive category is grouped as Other.
 * The full semantic list remains ungrouped below the chart.
 */
export function buildExpenseDonutSegments(
  categories: readonly MobileExpenseDonutCategory[],
  expectedTotalCents?: number,
): MobileExpenseDonutSegment[] {
  if (
    categories.some(
      (category) =>
        !Number.isSafeInteger(category.amountCents) || category.amountCents < 0,
    )
  ) {
    return [];
  }
  const positive = sortedCategories(categories).filter(
    (category) => category.amountCents > 0,
  );
  const total = positive.reduce(
    (sum, category) => sum + category.amountCents,
    0,
  );
  if (!Number.isSafeInteger(total) || total <= 0) return [];
  if (
    expectedTotalCents !== undefined &&
    (!Number.isSafeInteger(expectedTotalCents) ||
      expectedTotalCents <= 0 ||
      expectedTotalCents !== total)
  ) {
    return [];
  }

  const direct = positive.slice(0, 5);
  const usedColorIndexes = new Set<number>();
  const segments: MobileExpenseDonutSegment[] = direct.map((category) => {
    const preferredIndex = stableCategoryColorIndex(category.id);
    let colorIndex = preferredIndex;
    for (let offset = 0; offset < DIRECT_SEGMENT_COLORS.length; offset += 1) {
      const candidate =
        (preferredIndex + offset) % DIRECT_SEGMENT_COLORS.length;
      if (!usedColorIndexes.has(candidate)) {
        colorIndex = candidate;
        break;
      }
    }
    usedColorIndexes.add(colorIndex);
    return {
      id: category.id,
      label: category.label,
      amountCents: category.amountCents,
      percent: (category.amountCents / total) * 100,
      color: DIRECT_SEGMENT_COLORS[colorIndex] ?? OTHER_SEGMENT_COLOR,
      categoryIds: [category.id],
      grouped: false,
    };
  });
  const remainder = positive.slice(5);
  if (remainder.length) {
    const amountCents = remainder.reduce(
      (sum, category) => sum + category.amountCents,
      0,
    );
    segments.push({
      id: "all-other-categories",
      label: "All other categories",
      amountCents,
      percent: (amountCents / total) * 100,
      color: OTHER_SEGMENT_COLOR,
      categoryIds: remainder.map((category) => category.id),
      grouped: true,
    });
  }
  return segments;
}

export function MobileExpenseDonut({
  categories,
  totalExpensesCents,
}: {
  categories: readonly MobileExpenseDonutCategory[];
  totalExpensesCents: number;
}) {
  const rankedCategories = sortedCategories(categories);
  const segments = buildExpenseDonutSegments(
    rankedCategories,
    totalExpensesCents,
  );
  const hasCategoryValues = rankedCategories.some(
    (category) => category.amountCents !== 0,
  );
  const chartUnavailable = segments.length === 0 && hasCategoryValues;
  const segmentByCategory = new Map(
    segments.flatMap((segment) =>
      segment.categoryIds.map((categoryId) => [categoryId, segment] as const),
    ),
  );
  let offset = 0;

  return (
    <section
      className="rounded-xl border border-white/10 bg-white/[0.07] p-4"
      aria-labelledby="expense-mix-heading"
    >
      <h2 id="expense-mix-heading" className="text-base font-semibold">
        Expense mix
      </h2>
      <p className="mt-1 text-xs leading-5 text-slate-400">
        Each category&apos;s share of this week&apos;s tracked expenses.
      </p>

      {segments.length ? (
        <figure className="relative mx-auto mt-4 size-56 max-w-full">
          <svg
            aria-hidden="true"
            viewBox="0 0 120 120"
            className="size-full -rotate-90"
          >
            <circle
              cx="60"
              cy="60"
              r="44"
              pathLength="100"
              fill="none"
              stroke="#1e293b"
              strokeWidth="17"
            />
            {segments.map((segment) => {
              const dashOffset = offset;
              offset += segment.percent;
              return (
                <circle
                  key={segment.id}
                  cx="60"
                  cy="60"
                  r="44"
                  pathLength="100"
                  fill="none"
                  stroke={segment.color}
                  strokeWidth="17"
                  strokeDasharray={`${segment.percent} ${100 - segment.percent}`}
                  strokeDashoffset={-dashOffset}
                  className="transition-[stroke-dasharray,stroke-dashoffset] duration-500 motion-reduce:transition-none"
                />
              );
            })}
          </svg>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 grid place-content-center text-center"
          >
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              Expenses
            </span>
            <strong className="mt-1 text-xl text-white">
              {formatExpenseMoney(totalExpensesCents)}
            </strong>
          </div>
          <figcaption className="sr-only">
            Expense distribution chart. Exact amounts and percentages are listed
            below.
          </figcaption>
        </figure>
      ) : (
        <div className="mx-auto mt-4 grid size-48 max-w-full place-content-center rounded-full border-[17px] border-slate-800 text-center">
          <span className="text-xs font-semibold text-slate-400">
            {chartUnavailable ? "Mix unavailable" : "No expenses"}
          </span>
          <strong className="mt-1 text-lg">
            {formatExpenseMoney(totalExpensesCents)}
          </strong>
        </div>
      )}

      {chartUnavailable ? (
        <p className="mt-3 text-center text-xs leading-5 text-amber-200">
          Net adjustments cannot be drawn accurately as a pie. The exact
          category amounts remain listed below.
        </p>
      ) : null}

      {rankedCategories.length ? (
        <ol className="mt-5 divide-y divide-white/10">
          {rankedCategories.map((category, index) => {
            const segment = segmentByCategory.get(category.id);
            return (
              <li key={category.id} className="flex gap-3 py-3 first:pt-0">
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: segment?.color ?? "#475569" }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm font-semibold text-white">
                      <span className="mr-1 text-slate-400">{index + 1}.</span>
                      {category.label}
                    </p>
                    <p className="shrink-0 text-sm font-bold text-white">
                      {formatExpenseMoney(category.amountCents)}
                    </p>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    {formatExpensePercent(category.percentOfExpenses)} of
                    expenses · {formatExpensePercent(category.percentOfRevenue)}{" "}
                    of revenue
                  </p>
                  {segment?.grouped ? (
                    <span className="sr-only">
                      Included in the All other categories chart slice.
                    </span>
                  ) : null}
                  {!category.verified ? (
                    <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-amber-200">
                      <CircleAlert aria-hidden="true" className="size-3.5" />
                      Category needs review
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mt-4 text-center text-sm text-slate-400">
          No verified expenses in this week.
        </p>
      )}
    </section>
  );
}
