import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  expenseCategories,
  expenseFixedCostSeries,
  expenseFixedCostVersions,
  type DatabaseClient,
} from "@/db";
import { MAX_EXPENSE_CENTS } from "@/lib/expense-lifecycle";
import { assertFixedCostRevisionPreservesCoverageLinks } from "@/lib/expense-fixed-cost-coverage";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export const EXPENSE_FIXED_COST_TIME_ZONE = "America/New_York" as const;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const EARLIEST_EFFECTIVE_DATE = "2000-01-01";

export type ExpenseFixedCostState = "active" | "ended";

export type ExpenseFixedCostCreateInput = {
  name: string;
  monthlyAmountCents: number;
  categoryId: string;
  effectiveStartDate: string;
};

export type ExpenseFixedCostRevisionInput =
  | (ExpenseFixedCostCreateInput & {
      action: "revise";
      expectedVersion: number;
    })
  | {
      action: "end";
      expectedVersion: number;
      effectiveStartDate: string;
    };

export type ExpenseFixedCostDto = {
  seriesId: string;
  version: number;
  name: string;
  categoryId: string;
  category: string;
  monthlyAmountCents: number;
  effectiveStartDate: string;
  state: ExpenseFixedCostState;
  createdAt: string;
};

export type ExpenseFixedCostList = {
  asOf: string;
  timezone: typeof EXPENSE_FIXED_COST_TIME_ZONE;
  summary: {
    activeCount: number;
    monthlyAmountCents: number;
    dailyAccrualCents: number;
  };
  costs: ExpenseFixedCostDto[];
};

const CreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    monthlyAmountCents: z.number().int().min(1).max(MAX_EXPENSE_CENTS),
    categoryId: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,63}$/u),
    effectiveStartDate: z.string(),
  })
  .strict();

const RevisionSchema = z.discriminatedUnion("action", [
  CreateSchema.extend({
    action: z.literal("revise"),
    expectedVersion: z.number().int().min(1),
  }).strict(),
  z
    .object({
      action: z.literal("end"),
      expectedVersion: z.number().int().min(1),
      effectiveStartDate: z.string(),
    })
    .strict(),
]);

function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    errors[issue.path.join(".") || "request"] ??= issue.message;
  }
  return errors;
}

function easternDate(value: Date): string {
  return (
    DateTime.fromJSDate(value, { zone: "utc" })
      .setZone(EXPENSE_FIXED_COST_TIME_ZONE)
      .toISODate() ?? ""
  );
}

function parseEffectiveDate(value: string, now: Date): string {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a valid fixed-cost start date.",
      { fieldErrors: { effectiveStartDate: "Use YYYY-MM-DD." } },
    );
  }
  const date = DateTime.fromISO(value, {
    zone: EXPENSE_FIXED_COST_TIME_ZONE,
  }).startOf("day");
  if (!date.isValid || date.toFormat("yyyy-MM-dd") !== value) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a real fixed-cost start date.",
      {
        fieldErrors: {
          effectiveStartDate: "Choose a real calendar date.",
        },
      },
    );
  }
  if (value < EARLIEST_EFFECTIVE_DATE) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a supported fixed-cost start date.",
      {
        fieldErrors: {
          effectiveStartDate: `Choose ${EARLIEST_EFFECTIVE_DATE} or later.`,
        },
      },
    );
  }
  if (value > easternDate(now)) {
    throw new TeamMutationFailure(
      "invalid",
      "Fixed-cost changes cannot be dated in the future.",
      {
        fieldErrors: {
          effectiveStartDate: "Choose today or an earlier date.",
        },
      },
    );
  }
  return value;
}

export function validateExpenseFixedCostAsOf(value: unknown): string {
  if (typeof value !== "string" || !DATE_ONLY_PATTERN.test(value)) {
    throw new TeamMutationFailure("invalid", "Choose a valid as-of date.", {
      fieldErrors: { asOf: "Use YYYY-MM-DD." },
    });
  }
  const parsed = DateTime.fromISO(value, {
    zone: EXPENSE_FIXED_COST_TIME_ZONE,
  });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd") !== value) {
    throw new TeamMutationFailure("invalid", "Choose a real as-of date.", {
      fieldErrors: { asOf: "Choose a real calendar date." },
    });
  }
  return value;
}

export function parseExpenseFixedCostCreateInput(
  value: unknown,
  now = new Date(),
): ExpenseFixedCostCreateInput {
  const parsed = CreateSchema.safeParse(value);
  if (!parsed.success) {
    throw new TeamMutationFailure(
      "invalid",
      "Review the fixed monthly cost and try again.",
      { fieldErrors: zodFieldErrors(parsed.error) },
    );
  }
  return {
    ...parsed.data,
    name: parsed.data.name.normalize("NFKC"),
    effectiveStartDate: parseEffectiveDate(parsed.data.effectiveStartDate, now),
  };
}

export function parseExpenseFixedCostRevisionInput(
  value: unknown,
  now = new Date(),
): ExpenseFixedCostRevisionInput {
  const parsed = RevisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new TeamMutationFailure(
      "invalid",
      "Review the fixed-cost change and try again.",
      { fieldErrors: zodFieldErrors(parsed.error) },
    );
  }
  const effectiveStartDate = parseEffectiveDate(
    parsed.data.effectiveStartDate,
    now,
  );
  return parsed.data.action === "end"
    ? { ...parsed.data, effectiveStartDate }
    : {
        ...parsed.data,
        name: parsed.data.name.normalize("NFKC"),
        effectiveStartDate,
      };
}

/**
 * Allocates one monthly amount to one calendar day. The cumulative-floor
 * formula distributes remainder cents smoothly and reconciles a full month
 * exactly to the entered amount.
 */
export function expenseFixedCostDailyCents(
  monthlyAmountCents: number,
  businessDate: string,
): number {
  if (
    !Number.isSafeInteger(monthlyAmountCents) ||
    monthlyAmountCents < 1 ||
    monthlyAmountCents > MAX_EXPENSE_CENTS
  ) {
    throw new TypeError("monthlyAmountCents must be supported positive cents.");
  }
  const date = DateTime.fromISO(validateExpenseFixedCostAsOf(businessDate), {
    zone: EXPENSE_FIXED_COST_TIME_ZONE,
  });
  const daysInMonth = date.daysInMonth;
  if (!daysInMonth) throw new TypeError("businessDate month is invalid.");
  const amount = BigInt(monthlyAmountCents);
  const day = BigInt(date.day);
  const days = BigInt(daysInMonth);
  const todayCumulative = (amount * day) / days;
  const priorCumulative = (amount * (day - 1n)) / days;
  return Number(todayCumulative - priorCumulative);
}

async function activeCategory(
  tx: TeamMutationTransaction,
  categoryId: string,
): Promise<{ id: string; name: string }> {
  const [category] = await tx
    .select({
      id: expenseCategories.id,
      name: expenseCategories.name,
      active: expenseCategories.isActive,
    })
    .from(expenseCategories)
    .where(eq(expenseCategories.id, categoryId))
    .limit(1);
  if (!category || !category.name) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose an available expense category.",
      { fieldErrors: { categoryId: "Choose an available category." } },
    );
  }
  if (category.active !== true) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose an active expense category.",
      { fieldErrors: { categoryId: "Choose an active category." } },
    );
  }
  return { id: category.id, name: category.name };
}

function dto(input: {
  seriesId: string;
  version: number;
  name: string;
  categoryId: string;
  category: string;
  monthlyAmountCents: number;
  effectiveStartDate: string;
  state: string;
  createdAt: Date;
}): ExpenseFixedCostDto {
  if (input.state !== "active" && input.state !== "ended") {
    throw new TypeError("Fixed cost state is invalid.");
  }
  return {
    ...input,
    state: input.state,
    createdAt: input.createdAt.toISOString(),
  };
}

export async function readExpenseFixedCosts(
  db: DatabaseClient,
  asOf = easternDate(new Date()),
): Promise<ExpenseFixedCostList> {
  const businessDate = validateExpenseFixedCostAsOf(asOf);
  const rows = await db
    .select({
      seriesId: expenseFixedCostVersions.seriesId,
      version: expenseFixedCostVersions.version,
      name: expenseFixedCostVersions.name,
      categoryId: expenseFixedCostVersions.categoryId,
      category: expenseCategories.name,
      monthlyAmountCents: expenseFixedCostVersions.monthlyAmountCents,
      effectiveStartDate: expenseFixedCostVersions.effectiveStartDate,
      state: expenseFixedCostVersions.state,
      createdAt: expenseFixedCostVersions.createdAt,
    })
    .from(expenseFixedCostVersions)
    .innerJoin(
      expenseCategories,
      eq(expenseFixedCostVersions.categoryId, expenseCategories.id),
    )
    .orderBy(
      asc(expenseFixedCostVersions.seriesId),
      desc(expenseFixedCostVersions.version),
    );

  const latest = new Map<string, ExpenseFixedCostDto>();
  for (const row of rows) {
    // A later revision or end marker must not rewrite what an owner would have
    // seen on an earlier business date. Rows are version-descending, so the
    // first row that was effective by `businessDate` is authoritative.
    if (row.effectiveStartDate > businessDate) continue;
    if (!latest.has(row.seriesId)) latest.set(row.seriesId, dto(row));
  }
  const costs = [...latest.values()].sort((left, right) => {
    if (left.state !== right.state) return left.state === "active" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  const active = costs.filter((cost) => cost.state === "active");
  const monthlyAmountCents = active.reduce((total, cost) => {
    const next = total + cost.monthlyAmountCents;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("Fixed monthly total exceeds the safe range.");
    }
    return next;
  }, 0);
  const dailyAccrualCents = active.reduce((total, cost) => {
    const next =
      total + expenseFixedCostDailyCents(cost.monthlyAmountCents, businessDate);
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("Fixed daily total exceeds the safe range.");
    }
    return next;
  }, 0);
  return {
    asOf: businessDate,
    timezone: EXPENSE_FIXED_COST_TIME_ZONE,
    summary: {
      activeCount: active.length,
      monthlyAmountCents,
      dailyAccrualCents,
    },
    costs,
  };
}

export async function createExpenseFixedCost(
  tx: TeamMutationTransaction,
  input: ExpenseFixedCostCreateInput & { actorId: string; now: Date },
): Promise<ExpenseFixedCostDto> {
  const category = await activeCategory(tx, input.categoryId);
  const seriesId = randomUUID();
  await tx.insert(expenseFixedCostSeries).values({
    id: seriesId,
    createdBy: input.actorId,
    createdAt: input.now,
  });
  const [created] = await tx
    .insert(expenseFixedCostVersions)
    .values({
      seriesId,
      version: 1,
      name: input.name,
      categoryId: input.categoryId,
      monthlyAmountCents: input.monthlyAmountCents,
      effectiveStartDate: input.effectiveStartDate,
      state: "active",
      createdBy: input.actorId,
      createdAt: input.now,
    })
    .returning({
      seriesId: expenseFixedCostVersions.seriesId,
      version: expenseFixedCostVersions.version,
      name: expenseFixedCostVersions.name,
      categoryId: expenseFixedCostVersions.categoryId,
      monthlyAmountCents: expenseFixedCostVersions.monthlyAmountCents,
      effectiveStartDate: expenseFixedCostVersions.effectiveStartDate,
      state: expenseFixedCostVersions.state,
      createdAt: expenseFixedCostVersions.createdAt,
    });
  if (!created) throw new Error("fixed_cost_create_failed");
  return dto({ ...created, category: category.name });
}

export async function reviseExpenseFixedCost(
  tx: TeamMutationTransaction,
  input: ExpenseFixedCostRevisionInput & {
    seriesId: string;
    actorId: string;
    now: Date;
  },
): Promise<{ before: ExpenseFixedCostDto; after: ExpenseFixedCostDto }> {
  const [series] = await tx
    .select({ id: expenseFixedCostSeries.id })
    .from(expenseFixedCostSeries)
    .where(eq(expenseFixedCostSeries.id, input.seriesId))
    .for("update", { of: expenseFixedCostSeries })
    .limit(1);
  if (!series) {
    throw new TeamMutationFailure("invalid", "Fixed cost not found.", {
      status: 404,
    });
  }
  const [latest] = await tx
    .select({
      seriesId: expenseFixedCostVersions.seriesId,
      version: expenseFixedCostVersions.version,
      name: expenseFixedCostVersions.name,
      categoryId: expenseFixedCostVersions.categoryId,
      category: expenseCategories.name,
      monthlyAmountCents: expenseFixedCostVersions.monthlyAmountCents,
      effectiveStartDate: expenseFixedCostVersions.effectiveStartDate,
      state: expenseFixedCostVersions.state,
      createdAt: expenseFixedCostVersions.createdAt,
    })
    .from(expenseFixedCostVersions)
    .innerJoin(
      expenseCategories,
      eq(expenseFixedCostVersions.categoryId, expenseCategories.id),
    )
    .where(eq(expenseFixedCostVersions.seriesId, input.seriesId))
    .orderBy(desc(expenseFixedCostVersions.version))
    .limit(1);
  if (!latest) throw new Error("fixed_cost_version_missing");
  if (latest.version !== input.expectedVersion) {
    throw new TeamMutationFailure(
      "conflict",
      "This fixed cost changed after it was loaded. Refresh and try again.",
      { retryable: true },
    );
  }
  if (latest.state === "ended") {
    throw new TeamMutationFailure(
      "conflict",
      "This fixed cost has already ended.",
    );
  }
  if (input.effectiveStartDate < latest.effectiveStartDate) {
    throw new TeamMutationFailure(
      "invalid",
      "The change date cannot be earlier than the current version.",
      {
        fieldErrors: {
          effectiveStartDate: `Choose ${latest.effectiveStartDate} or later.`,
        },
      },
    );
  }

  const category =
    input.action === "revise"
      ? await activeCategory(tx, input.categoryId)
      : { id: latest.categoryId, name: latest.category };
  await assertFixedCostRevisionPreservesCoverageLinks(tx, {
    seriesId: input.seriesId,
    effectiveStartDate: input.effectiveStartDate,
    state: input.action === "end" ? "ended" : "active",
    monthlyAmountCents:
      input.action === "revise"
        ? input.monthlyAmountCents
        : latest.monthlyAmountCents,
    categoryId: category.id,
  });
  const nextVersion = latest.version + 1;
  const [created] = await tx
    .insert(expenseFixedCostVersions)
    .values({
      seriesId: input.seriesId,
      version: nextVersion,
      name: input.action === "revise" ? input.name : latest.name,
      categoryId:
        input.action === "revise" ? input.categoryId : latest.categoryId,
      monthlyAmountCents:
        input.action === "revise"
          ? input.monthlyAmountCents
          : latest.monthlyAmountCents,
      effectiveStartDate: input.effectiveStartDate,
      state: input.action === "end" ? "ended" : "active",
      createdBy: input.actorId,
      createdAt: input.now,
    })
    .returning({
      seriesId: expenseFixedCostVersions.seriesId,
      version: expenseFixedCostVersions.version,
      name: expenseFixedCostVersions.name,
      categoryId: expenseFixedCostVersions.categoryId,
      monthlyAmountCents: expenseFixedCostVersions.monthlyAmountCents,
      effectiveStartDate: expenseFixedCostVersions.effectiveStartDate,
      state: expenseFixedCostVersions.state,
      createdAt: expenseFixedCostVersions.createdAt,
    });
  if (!created) throw new Error("fixed_cost_revision_failed");
  return {
    before: dto(latest),
    after: dto({ ...created, category: category.name }),
  };
}
