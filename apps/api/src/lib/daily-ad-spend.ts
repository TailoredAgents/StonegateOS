import { and, eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  dailyAdSpend,
  expenseAllocations,
  expenses,
  type DatabaseClient,
} from "@/db";
import { MAX_EXPENSE_CENTS } from "@/lib/expense-lifecycle";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export const DAILY_AD_SPEND_TIME_ZONE = "America/New_York" as const;
export const DAILY_AD_SPEND_CATEGORY_ID = "advertising" as const;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EARLIEST_BUSINESS_DATE = "2000-01-01";
const PLATFORMS = ["facebook", "google"] as const;

export type DailyAdPlatform = (typeof PLATFORMS)[number];

export type DailyAdSpendSelection = {
  amountCents: number;
  /** Null means the platform has never been confirmed for this date. */
  version: number | null;
};

export type DailyAdSpendSaveInput = {
  businessDate: string;
  facebook: DailyAdSpendSelection | null;
  google: DailyAdSpendSelection | null;
};

export type DailyAdSpendEntry = {
  amountCents: number;
  version: number;
  expenseId: string | null;
  confirmedAt: string;
};

export type DailyAdSpendDay = {
  businessDate: string;
  timezone: typeof DAILY_AD_SPEND_TIME_ZONE;
  facebook: DailyAdSpendEntry | null;
  google: DailyAdSpendEntry | null;
};

export type DailyAdSpendChangeKind =
  | "missing"
  | "confirmed_zero"
  | "posted"
  | "noop"
  | "corrected"
  | "reversed_to_zero";

export type DailyAdSpendChange = {
  platform: DailyAdPlatform;
  kind: DailyAdSpendChangeKind;
  previousAmountCents: number | null;
  amountCents: number | null;
  previousExpenseId: string | null;
  expenseId: string | null;
  reversalExpenseId: string | null;
  version: number | null;
};

export type DailyAdSpendSaveResult = DailyAdSpendDay & {
  changes: DailyAdSpendChange[];
};

type DailyAdSpendRow = typeof dailyAdSpend.$inferSelect;
type ExpenseRow = typeof expenses.$inferSelect;

const SelectionSchema = z
  .object({
    amountCents: z.number().int().min(0).max(MAX_EXPENSE_CENTS),
    version: z.number().int().min(1).nullable(),
  })
  .strict();

const SaveSchema = z
  .object({
    businessDate: z.string(),
    facebook: SelectionSchema.nullable(),
    google: SelectionSchema.nullable(),
  })
  .strict()
  .refine((value) => value.facebook !== null || value.google !== null, {
    message: "Enter Facebook, Google, or both before saving.",
    path: ["facebook"],
  });

function fieldErrors(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "request";
    result[path] ??= issue.message;
  }
  return result;
}

function parseBusinessDate(value: string): DateTime {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a valid advertising business date.",
      { fieldErrors: { businessDate: "Use YYYY-MM-DD." } },
    );
  }
  const parsed = DateTime.fromISO(value, {
    zone: DAILY_AD_SPEND_TIME_ZONE,
  }).startOf("day");
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd") !== value) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a valid advertising business date.",
      { fieldErrors: { businessDate: "Choose a real calendar date." } },
    );
  }
  if (value < EARLIEST_BUSINESS_DATE) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a supported advertising business date.",
      {
        fieldErrors: {
          businessDate: `Choose ${EARLIEST_BUSINESS_DATE} or later.`,
        },
      },
    );
  }
  return parsed;
}

export function validateDailyAdBusinessDate(value: unknown): string {
  if (typeof value !== "string") {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a valid advertising business date.",
      { fieldErrors: { businessDate: "Use YYYY-MM-DD." } },
    );
  }
  return parseBusinessDate(value).toFormat("yyyy-MM-dd");
}

/**
 * Noon Eastern is an unambiguous instant on every civil date, including both
 * DST transition days. The ledger still groups it into the requested Eastern
 * purchase date without relying on the server's local timezone.
 */
export function dailyAdPurchaseTimestamp(businessDate: string): Date {
  return parseBusinessDate(businessDate)
    .set({ hour: 12, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

export function parseDailyAdSpendSaveInput(
  value: unknown,
  now = new Date(),
): DailyAdSpendSaveInput {
  const parsed = SaveSchema.safeParse(value);
  if (!parsed.success) {
    throw new TeamMutationFailure(
      "invalid",
      "Review the daily advertising amounts and try again.",
      { fieldErrors: fieldErrors(parsed.error) },
    );
  }

  const businessDate = validateDailyAdBusinessDate(parsed.data.businessDate);
  const today =
    DateTime.fromJSDate(now, { zone: "utc" })
      .setZone(DAILY_AD_SPEND_TIME_ZONE)
      .toISODate() ?? "";
  if (businessDate > today) {
    throw new TeamMutationFailure(
      "invalid",
      "Advertising spend cannot be confirmed for a future date.",
      { fieldErrors: { businessDate: "Choose today or an earlier date." } },
    );
  }

  return {
    businessDate,
    facebook: parsed.data.facebook,
    google: parsed.data.google,
  };
}

function platformField(platform: DailyAdPlatform, field: string): string {
  return `${platform}.${field}`;
}

export function planDailyAdSpendChange(
  platform: DailyAdPlatform,
  current: Pick<
    DailyAdSpendRow,
    "amountCents" | "currentExpenseId" | "version"
  > | null,
  requested: DailyAdSpendSelection | null,
): DailyAdSpendChangeKind {
  if (requested === null) {
    if (current !== null) {
      throw new TeamMutationFailure(
        "invalid",
        "A confirmed advertising value cannot be changed back to missing.",
        {
          fieldErrors: {
            [platformField(platform, "amountCents")]:
              "Enter the current amount or use $0.00 to confirm zero spend.",
          },
        },
      );
    }
    return "missing";
  }

  if (current === null) {
    if (requested.version !== null) {
      throw new TeamMutationFailure(
        "conflict",
        "The daily advertising entry changed after it was loaded.",
        {
          retryable: true,
          fieldErrors: {
            [platformField(platform, "version")]:
              "Refresh this date and try again.",
          },
        },
      );
    }
    return requested.amountCents === 0 ? "confirmed_zero" : "posted";
  }

  if (requested.version !== current.version) {
    throw new TeamMutationFailure(
      "conflict",
      "The daily advertising entry changed after it was loaded.",
      {
        retryable: true,
        fieldErrors: {
          [platformField(platform, "version")]:
            "Refresh this date and try again.",
        },
      },
    );
  }
  if (requested.amountCents === current.amountCents) return "noop";
  if (requested.amountCents === 0) return "reversed_to_zero";
  return current.amountCents === 0 ? "posted" : "corrected";
}

function entryFromRow(row: DailyAdSpendRow): DailyAdSpendEntry {
  return {
    amountCents: row.amountCents,
    version: row.version,
    expenseId: row.currentExpenseId,
    confirmedAt: row.confirmedAt.toISOString(),
  };
}

export function dailyAdSpendDayFromRows(
  businessDate: string,
  rows: readonly DailyAdSpendRow[],
): DailyAdSpendDay {
  const result: DailyAdSpendDay = {
    businessDate,
    timezone: DAILY_AD_SPEND_TIME_ZONE,
    facebook: null,
    google: null,
  };
  for (const row of rows) {
    if (row.businessDate !== businessDate) {
      throw new TypeError(
        "Daily advertising rows must share one business date.",
      );
    }
    if (result[row.platform] !== null) {
      throw new TypeError(
        "Daily advertising rows contain a duplicate platform.",
      );
    }
    result[row.platform] = entryFromRow(row);
  }
  return result;
}

export async function readDailyAdSpendDay(
  db: DatabaseClient,
  businessDate: string,
): Promise<DailyAdSpendDay> {
  const rows = await db
    .select()
    .from(dailyAdSpend)
    .where(eq(dailyAdSpend.businessDate, businessDate));
  return dailyAdSpendDayFromRows(businessDate, rows);
}

function vendorForPlatform(platform: DailyAdPlatform): string {
  return platform === "facebook" ? "Meta Ads" : "Google Ads";
}

function memoForPlatform(
  platform: DailyAdPlatform,
  businessDate: string,
): string {
  const name = platform === "facebook" ? "Facebook" : "Google";
  return `${name} ad spend for ${businessDate}`;
}

type CreatePostedExpenseInput = {
  actorId: string;
  platform: DailyAdPlatform;
  businessDate: string;
  amountCents: number;
  paidAt: Date;
  now: Date;
  source: "daily_ad_spend" | "manual_correction";
  reversalOfExpenseId?: string | null;
  correctionOfExpenseId?: string | null;
};

async function createPostedAdExpense(
  tx: TeamMutationTransaction,
  input: CreatePostedExpenseInput,
): Promise<{ id: string; version: number }> {
  const [draft] = await tx
    .insert(expenses)
    .values({
      amount: input.amountCents,
      currency: "USD",
      category: "Advertising",
      categoryId: DAILY_AD_SPEND_CATEGORY_ID,
      categoryNeedsReview: false,
      vendor: vendorForPlatform(input.platform),
      memo: memoForPlatform(input.platform, input.businessDate),
      method: null,
      source: input.source,
      submittedBy: input.actorId,
      payerType: "company",
      paidByMemberId: null,
      reviewStatus: "approved",
      reviewedBy: input.actorId,
      reviewedAt: input.now,
      paidAt: input.paidAt,
      lifecycleStatus: "draft",
      version: 1,
      postedAt: null,
      postedBy: null,
      reversalOfExpenseId: input.reversalOfExpenseId ?? null,
      correctionOfExpenseId: input.correctionOfExpenseId ?? null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: expenses.id });
  if (!draft?.id) {
    throw new TeamMutationFailure(
      "internal",
      "The advertising expense draft could not be created.",
      { retryable: true },
    );
  }

  await tx.insert(expenseAllocations).values({
    expenseId: draft.id,
    categoryId: DAILY_AD_SPEND_CATEGORY_ID,
    amountCents: input.amountCents,
    createdAt: input.now,
  });

  const [posted] = await tx
    .update(expenses)
    .set({
      lifecycleStatus: "posted",
      postedAt: input.now,
      postedBy: input.actorId,
      version: 2,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(expenses.id, draft.id),
        eq(expenses.lifecycleStatus, "draft"),
        eq(expenses.version, 1),
      ),
    )
    .returning({ id: expenses.id, version: expenses.version });
  if (!posted?.id) {
    throw new TeamMutationFailure(
      "conflict",
      "The advertising expense changed before it could post.",
      { retryable: true },
    );
  }
  return posted;
}

function assertCurrentExpense(
  expense: ExpenseRow | undefined,
  row: DailyAdSpendRow,
): asserts expense is ExpenseRow {
  const expectedVendor = vendorForPlatform(row.platform);
  const paidDate = expense
    ? DateTime.fromJSDate(expense.paidAt, { zone: "utc" })
        .setZone(DAILY_AD_SPEND_TIME_ZONE)
        .toISODate()
    : null;
  if (
    !expense ||
    expense.id !== row.currentExpenseId ||
    expense.amount !== row.amountCents ||
    expense.amount <= 0 ||
    expense.currency !== "USD" ||
    expense.categoryId !== DAILY_AD_SPEND_CATEGORY_ID ||
    expense.vendor !== expectedVendor ||
    expense.payerType !== "company" ||
    expense.paidByMemberId !== null ||
    expense.reviewStatus !== "approved" ||
    expense.lifecycleStatus !== "posted" ||
    expense.reversalOfExpenseId !== null ||
    expense.bankTransactionId !== null ||
    expense.payoutRunId !== null ||
    (expense.source !== "daily_ad_spend" &&
      expense.source !== "manual_correction") ||
    paidDate !== row.businessDate
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The saved advertising expense needs finance review before it can change.",
    );
  }
}

async function loadCurrentExpense(
  tx: TeamMutationTransaction,
  row: DailyAdSpendRow,
): Promise<ExpenseRow> {
  if (!row.currentExpenseId || row.amountCents <= 0) {
    throw new TeamMutationFailure(
      "conflict",
      "The saved advertising entry has an invalid ledger link.",
    );
  }
  const [expense] = await tx
    .select()
    .from(expenses)
    .where(eq(expenses.id, row.currentExpenseId))
    .for("update")
    .limit(1);
  assertCurrentExpense(expense, row);
  return expense;
}

async function markExpenseCorrected(
  tx: TeamMutationTransaction,
  input: {
    current: ExpenseRow;
    replacementExpenseId: string;
    actorId: string;
    reason: string;
    now: Date;
  },
): Promise<void> {
  const [updated] = await tx
    .update(expenses)
    .set({
      lifecycleStatus: "corrected",
      correctedAt: input.now,
      correctedBy: input.actorId,
      correctionReason: input.reason,
      correctedByExpenseId: input.replacementExpenseId,
      version: input.current.version + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(expenses.id, input.current.id),
        eq(expenses.lifecycleStatus, "posted"),
        eq(expenses.version, input.current.version),
      ),
    )
    .returning({ id: expenses.id });
  if (!updated?.id) {
    throw new TeamMutationFailure(
      "conflict",
      "The advertising expense changed while it was being corrected.",
      { retryable: true },
    );
  }
}

async function markExpenseVoided(
  tx: TeamMutationTransaction,
  input: {
    current: ExpenseRow;
    actorId: string;
    reason: string;
    now: Date;
  },
): Promise<void> {
  const [updated] = await tx
    .update(expenses)
    .set({
      lifecycleStatus: "voided",
      voidedAt: input.now,
      voidedBy: input.actorId,
      voidReason: input.reason,
      version: input.current.version + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(expenses.id, input.current.id),
        eq(expenses.lifecycleStatus, "posted"),
        eq(expenses.version, input.current.version),
      ),
    )
    .returning({ id: expenses.id });
  if (!updated?.id) {
    throw new TeamMutationFailure(
      "conflict",
      "The advertising expense changed while it was being reversed.",
      { retryable: true },
    );
  }
}

async function insertRegistryRow(
  tx: TeamMutationTransaction,
  input: {
    platform: DailyAdPlatform;
    businessDate: string;
    amountCents: number;
    currentExpenseId: string | null;
    actorId: string;
    now: Date;
  },
): Promise<DailyAdSpendRow> {
  const [row] = await tx
    .insert(dailyAdSpend)
    .values({
      platform: input.platform,
      businessDate: input.businessDate,
      amountCents: input.amountCents,
      currentExpenseId: input.currentExpenseId,
      enteredBy: input.actorId,
      confirmedAt: input.now,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!row) {
    throw new TeamMutationFailure(
      "internal",
      "The advertising confirmation could not be saved.",
      { retryable: true },
    );
  }
  return row;
}

async function updateRegistryRow(
  tx: TeamMutationTransaction,
  input: {
    current: DailyAdSpendRow;
    amountCents: number;
    currentExpenseId: string | null;
    actorId: string;
    now: Date;
  },
): Promise<DailyAdSpendRow> {
  const [row] = await tx
    .update(dailyAdSpend)
    .set({
      amountCents: input.amountCents,
      currentExpenseId: input.currentExpenseId,
      enteredBy: input.actorId,
      confirmedAt: input.now,
      version: input.current.version + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(dailyAdSpend.id, input.current.id),
        eq(dailyAdSpend.version, input.current.version),
      ),
    )
    .returning();
  if (!row) {
    throw new TeamMutationFailure(
      "conflict",
      "The daily advertising entry changed while it was being saved.",
      { retryable: true },
    );
  }
  return row;
}

async function applyPlatformChange(
  tx: TeamMutationTransaction,
  input: {
    platform: DailyAdPlatform;
    current: DailyAdSpendRow | null;
    requested: DailyAdSpendSelection | null;
    kind: DailyAdSpendChangeKind;
    actorId: string;
    businessDate: string;
    paidAt: Date;
    now: Date;
  },
): Promise<{ row: DailyAdSpendRow | null; change: DailyAdSpendChange }> {
  const base = {
    platform: input.platform,
    kind: input.kind,
    previousAmountCents: input.current?.amountCents ?? null,
    amountCents: input.requested?.amountCents ?? null,
    previousExpenseId: input.current?.currentExpenseId ?? null,
  };

  if (input.kind === "missing") {
    return {
      row: null,
      change: {
        ...base,
        expenseId: null,
        reversalExpenseId: null,
        version: null,
      },
    };
  }
  if (input.kind === "noop") {
    if (!input.current) throw new TypeError("A no-op requires a current row.");
    return {
      row: input.current,
      change: {
        ...base,
        expenseId: input.current.currentExpenseId,
        reversalExpenseId: null,
        version: input.current.version,
      },
    };
  }
  if (!input.requested) {
    throw new TypeError("A daily advertising change requires an amount.");
  }

  if (input.kind === "confirmed_zero") {
    const row = await insertRegistryRow(tx, {
      platform: input.platform,
      businessDate: input.businessDate,
      amountCents: 0,
      currentExpenseId: null,
      actorId: input.actorId,
      now: input.now,
    });
    return {
      row,
      change: {
        ...base,
        expenseId: null,
        reversalExpenseId: null,
        version: row.version,
      },
    };
  }

  if (input.kind === "posted") {
    const expense = await createPostedAdExpense(tx, {
      actorId: input.actorId,
      platform: input.platform,
      businessDate: input.businessDate,
      amountCents: input.requested.amountCents,
      paidAt: input.paidAt,
      now: input.now,
      source: "daily_ad_spend",
    });
    const row = input.current
      ? await updateRegistryRow(tx, {
          current: input.current,
          amountCents: input.requested.amountCents,
          currentExpenseId: expense.id,
          actorId: input.actorId,
          now: input.now,
        })
      : await insertRegistryRow(tx, {
          platform: input.platform,
          businessDate: input.businessDate,
          amountCents: input.requested.amountCents,
          currentExpenseId: expense.id,
          actorId: input.actorId,
          now: input.now,
        });
    return {
      row,
      change: {
        ...base,
        expenseId: expense.id,
        reversalExpenseId: null,
        version: row.version,
      },
    };
  }

  if (!input.current) {
    throw new TypeError("A correction requires a current registry row.");
  }
  const currentExpense = await loadCurrentExpense(tx, input.current);
  const reversal = await createPostedAdExpense(tx, {
    actorId: input.actorId,
    platform: input.platform,
    businessDate: input.businessDate,
    amountCents: -currentExpense.amount,
    paidAt: currentExpense.paidAt,
    now: input.now,
    source: "manual_correction",
    reversalOfExpenseId: currentExpense.id,
  });

  if (input.kind === "reversed_to_zero") {
    const reason = `${vendorForPlatform(input.platform)} spend for ${input.businessDate} corrected to zero.`;
    await markExpenseVoided(tx, {
      current: currentExpense,
      actorId: input.actorId,
      reason,
      now: input.now,
    });
    const row = await updateRegistryRow(tx, {
      current: input.current,
      amountCents: 0,
      currentExpenseId: null,
      actorId: input.actorId,
      now: input.now,
    });
    return {
      row,
      change: {
        ...base,
        expenseId: null,
        reversalExpenseId: reversal.id,
        version: row.version,
      },
    };
  }

  const replacement = await createPostedAdExpense(tx, {
    actorId: input.actorId,
    platform: input.platform,
    businessDate: input.businessDate,
    amountCents: input.requested.amountCents,
    paidAt: input.paidAt,
    now: input.now,
    source: "manual_correction",
    correctionOfExpenseId: currentExpense.id,
  });
  const reason = `${vendorForPlatform(input.platform)} spend for ${input.businessDate} corrected by daily entry.`;
  await markExpenseCorrected(tx, {
    current: currentExpense,
    replacementExpenseId: replacement.id,
    actorId: input.actorId,
    reason,
    now: input.now,
  });
  const row = await updateRegistryRow(tx, {
    current: input.current,
    amountCents: input.requested.amountCents,
    currentExpenseId: replacement.id,
    actorId: input.actorId,
    now: input.now,
  });
  return {
    row,
    change: {
      ...base,
      expenseId: replacement.id,
      reversalExpenseId: reversal.id,
      version: row.version,
    },
  };
}

/**
 * Applies both fixed ad platforms under one transaction and one advisory
 * business-date lock. The caller must co-commit its audit row and durable
 * idempotency receipt in this same transaction.
 */
export async function saveDailyAdSpendDay(
  tx: TeamMutationTransaction,
  input: DailyAdSpendSaveInput & { actorId: string; now?: Date },
): Promise<DailyAdSpendSaveResult> {
  if (!UUID_PATTERN.test(input.actorId)) {
    throw new TeamMutationFailure(
      "internal",
      "The verified advertising actor is incomplete.",
    );
  }
  const now = input.now ?? new Date();
  const businessDate = validateDailyAdBusinessDate(input.businessDate);
  const paidAt = dailyAdPurchaseTimestamp(businessDate);

  // Serializes inserts as well as updates: SELECT FOR UPDATE alone cannot lock
  // a missing platform/date row, while the unique registry key must remain
  // race-safe for first entry and idempotent retries.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`daily_ad_spend:${businessDate}`}, 0))`,
  );
  const existingRows = await tx
    .select()
    .from(dailyAdSpend)
    .where(eq(dailyAdSpend.businessDate, businessDate))
    .for("update");
  const byPlatform = new Map<DailyAdPlatform, DailyAdSpendRow>();
  for (const row of existingRows) {
    if (byPlatform.has(row.platform)) {
      throw new TeamMutationFailure(
        "conflict",
        "The daily advertising registry contains duplicate platform entries.",
      );
    }
    byPlatform.set(row.platform, row);
  }

  // Plan both platforms before the first write so one stale value cannot leave
  // the other platform partially committed.
  const plans = PLATFORMS.map((platform) => ({
    platform,
    current: byPlatform.get(platform) ?? null,
    requested: input[platform],
    kind: planDailyAdSpendChange(
      platform,
      byPlatform.get(platform) ?? null,
      input[platform],
    ),
  }));

  const rows: DailyAdSpendRow[] = [];
  const changes: DailyAdSpendChange[] = [];
  for (const plan of plans) {
    const applied = await applyPlatformChange(tx, {
      ...plan,
      actorId: input.actorId,
      businessDate,
      paidAt,
      now,
    });
    if (applied.row) rows.push(applied.row);
    changes.push(applied.change);
  }

  return {
    ...dailyAdSpendDayFromRows(businessDate, rows),
    changes,
  };
}
