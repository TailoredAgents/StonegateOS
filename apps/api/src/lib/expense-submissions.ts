import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  appointments,
  expenseAllocations,
  expenseCategories,
  expenseReimbursementClaims,
  expenses,
  expenseVendorCategoryRules,
  payoutRunAdjustments,
  payoutRuns,
  teamMembers,
} from "@/db";
import {
  normalizeReceiptVendor,
  validateExpenseAllocations,
} from "@/lib/expense-receipt-domain";
import { isExpenseReimbursementEnabled } from "@/lib/expense-feature-flags";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export const EXPENSE_BUSINESS_TIME_ZONE = "America/New_York" as const;
export const EXPENSE_SUBMISSION_MAX_CENTS = 100_000_000;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CATEGORY_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/u;
const EXPENSE_METHODS = [
  "card",
  "cash",
  "ach",
  "check",
  "zelle",
  "other",
] as const;

const nullableText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .nullable()
    .optional()
    .transform((value) => value || null);

export const ExpenseSubmissionSchema = z
  .object({
    amountCents: z.number().int().min(1).max(EXPENSE_SUBMISSION_MAX_CENTS),
    purchaseDate: z.string().regex(DATE_ONLY_PATTERN),
    categoryId: z.string().trim().regex(CATEGORY_ID_PATTERN),
    allocations: z
      .array(
        z
          .object({
            categoryId: z.string().trim().regex(CATEGORY_ID_PATTERN),
            amountCents: z
              .number()
              .int()
              .min(1)
              .max(EXPENSE_SUBMISSION_MAX_CENTS),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    vendor: nullableText(240),
    notes: nullableText(2_000),
    method: z.enum(EXPENSE_METHODS).nullable().optional().default(null),
    payerType: z.enum(["company", "personal"]),
    paidByMemberId: z.string().uuid().nullable().optional().default(null),
    appointmentId: z.string().uuid().nullable().optional().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.payerType === "company" && value.paidByMemberId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paidByMemberId"],
        message: "Company-paid expenses cannot name a personal payer.",
      });
    }
    if (value.payerType === "personal" && value.paidByMemberId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paidByMemberId"],
        message: "Choose the team member who paid.",
      });
    }
  });

export const ExpenseReviewDecisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: nullableText(500),
    categoryId: z.string().trim().regex(CATEGORY_ID_PATTERN).optional(),
    allocations: z
      .array(
        z
          .object({
            categoryId: z.string().trim().regex(CATEGORY_ID_PATTERN),
            amountCents: z
              .number()
              .int()
              .min(1)
              .max(EXPENSE_SUBMISSION_MAX_CENTS),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    lockVendorRule: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "reject" && (value.reason?.length ?? 0) < 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Add a brief reason so the submitter knows what to fix.",
      });
    }
    if (
      value.decision === "reject" &&
      (value.categoryId !== undefined ||
        value.allocations !== undefined ||
        value.lockVendorRule)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision"],
        message: "Category changes can only be saved when approving.",
      });
    }
    if (value.allocations !== undefined && value.categoryId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categoryId"],
        message: "Choose the primary category for this split.",
      });
    }
  });

export type ExpenseSubmissionInput = z.infer<typeof ExpenseSubmissionSchema>;
export type ExpenseReviewDecision = z.infer<typeof ExpenseReviewDecisionSchema>;

export type ExpenseSubmissionSource = "manual" | "receipt_scan";

export type CreatedExpenseSubmission = {
  expenseId: string;
  lifecycleStatus: "draft" | "posted";
  reviewStatus: "pending" | "approved";
  reimbursementClaimId: string | null;
  reimbursementStatus: "approved" | "attached" | null;
  version: number;
};

function invalidFields(error: z.ZodError): Record<string, string> | undefined {
  const flattened = error.flatten().fieldErrors as Record<
    string,
    string[] | undefined
  >;
  const entries = Object.entries(flattened).flatMap(([field, messages]) => {
    const message = messages?.[0];
    return message ? [[field, message] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function parseExpenseSubmission(input: unknown): ExpenseSubmissionInput {
  const parsed = ExpenseSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    throw new TeamMutationFailure(
      "invalid",
      "Review the highlighted expense fields and try again.",
      { fieldErrors: invalidFields(parsed.error) },
    );
  }

  const purchaseDate = DateTime.fromISO(parsed.data.purchaseDate, {
    zone: EXPENSE_BUSINESS_TIME_ZONE,
  });
  const earliest = DateTime.fromISO("2000-01-01", {
    zone: EXPENSE_BUSINESS_TIME_ZONE,
  });
  const today = DateTime.now()
    .setZone(EXPENSE_BUSINESS_TIME_ZONE)
    .startOf("day");
  if (
    !purchaseDate.isValid ||
    purchaseDate.toISODate() !== parsed.data.purchaseDate ||
    purchaseDate < earliest ||
    purchaseDate.startOf("day") > today
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a valid purchase date that is not in the future.",
      {
        fieldErrors: {
          purchaseDate: "Use a real date from January 1, 2000 through today.",
        },
      },
    );
  }

  const allocations =
    parsed.data.allocations && parsed.data.allocations.length > 0
      ? parsed.data.allocations
      : [
          {
            categoryId: parsed.data.categoryId,
            amountCents: parsed.data.amountCents,
          },
        ];
  const allocationResult = validateExpenseAllocations({
    totalCents: parsed.data.amountCents,
    allocations,
  });
  if (!allocationResult.ok) {
    throw new TeamMutationFailure(
      "invalid",
      "Category splits must add up to the expense total exactly.",
      {
        fieldErrors: {
          allocations:
            allocationResult.issues[0]?.message ??
            "Review the category split amounts.",
        },
      },
    );
  }
  if (
    !allocationResult.allocationSet.allocations.some(
      (allocation) => allocation.categoryId === parsed.data.categoryId,
    )
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The primary category must be included in the category split.",
      {
        fieldErrors: {
          categoryId: "Choose one of the allocated categories.",
        },
      },
    );
  }

  return {
    ...parsed.data,
    allocations: allocationResult.allocationSet.allocations,
  };
}

export function expenseBusinessDateToTimestamp(businessDate: string): Date {
  const parsed = DateTime.fromISO(businessDate, {
    zone: EXPENSE_BUSINESS_TIME_ZONE,
  }).set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  if (!parsed.isValid || parsed.toISODate() !== businessDate) {
    throw new TeamMutationFailure("invalid", "The purchase date is invalid.");
  }
  return parsed.toUTC().toJSDate();
}

function nextVersionTimestamp(current: Date, now = new Date()): Date {
  return new Date(Math.max(now.getTime(), current.getTime() + 1));
}

async function assertSubmissionReferences(
  tx: TeamMutationTransaction,
  input: ExpenseSubmissionInput,
  actorId: string,
  canApprove: boolean,
): Promise<Map<string, { id: string; name: string }>> {
  const categoryIds = Array.from(
    new Set(input.allocations?.map((allocation) => allocation.categoryId)),
  );
  const categoryRows = await tx
    .select({ id: expenseCategories.id, name: expenseCategories.name })
    .from(expenseCategories)
    .where(
      and(
        inArray(expenseCategories.id, categoryIds),
        eq(expenseCategories.isActive, true),
      ),
    );
  const categories = new Map(categoryRows.map((row) => [row.id, row]));
  if (categories.size !== categoryIds.length) {
    throw new TeamMutationFailure(
      "invalid",
      "One or more expense categories are unavailable.",
      { fieldErrors: { categoryId: "Choose an active expense category." } },
    );
  }

  if (input.payerType === "personal") {
    const paidByMemberId = input.paidByMemberId;
    if (!paidByMemberId) {
      throw new TeamMutationFailure("invalid", "Choose who paid.");
    }
    if (!canApprove && paidByMemberId !== actorId) {
      throw new TeamMutationFailure(
        "forbidden",
        "You can only submit a personal purchase that you paid for.",
      );
    }
    const [member] = await tx
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(eq(teamMembers.id, paidByMemberId), eq(teamMembers.active, true)),
      )
      .limit(1);
    if (!member) {
      throw new TeamMutationFailure(
        "invalid",
        "The selected payer is not an active team member.",
        { fieldErrors: { paidByMemberId: "Choose an active team member." } },
      );
    }
  }

  if (input.appointmentId) {
    const [appointment] = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.id, input.appointmentId))
      .limit(1);
    if (!appointment) {
      throw new TeamMutationFailure(
        "invalid",
        "The selected job could not be found.",
        { fieldErrors: { appointmentId: "Choose a valid job." } },
      );
    }
  }

  return categories;
}

async function recordApprovedVendorCategory(
  tx: TeamMutationTransaction,
  input: { vendor: string | null; categoryId: string },
): Promise<void> {
  const normalizedVendor = normalizeReceiptVendor(input.vendor);
  if (!normalizedVendor) return;

  await tx
    .update(expenseVendorCategoryRules)
    .set({
      disagreementCount: sql`${expenseVendorCategoryRules.disagreementCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(expenseVendorCategoryRules.normalizedVendor, normalizedVendor),
        ne(expenseVendorCategoryRules.categoryId, input.categoryId),
        eq(expenseVendorCategoryRules.ownerLocked, false),
      ),
    );

  await tx
    .insert(expenseVendorCategoryRules)
    .values({
      normalizedVendor,
      categoryId: input.categoryId,
      confirmationCount: 1,
      disagreementCount: 0,
      ownerLocked: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        expenseVendorCategoryRules.normalizedVendor,
        expenseVendorCategoryRules.categoryId,
      ],
      set: {
        confirmationCount: sql`${expenseVendorCategoryRules.confirmationCount} + 1`,
        updatedAt: new Date(),
      },
    });
}

async function lockApprovedVendorCategory(
  tx: TeamMutationTransaction,
  input: {
    vendor: string | null;
    categoryId: string;
    reviewerId: string;
    now: Date;
  },
): Promise<void> {
  const normalizedVendor = normalizeReceiptVendor(input.vendor);
  if (!normalizedVendor) {
    throw new TeamMutationFailure(
      "invalid",
      "Add a vendor before remembering its category.",
      { fieldErrors: { lockVendorRule: "A vendor name is required." } },
    );
  }

  await tx
    .update(expenseVendorCategoryRules)
    .set({
      ownerLocked: false,
      lockedBy: null,
      lockedAt: null,
      updatedAt: input.now,
    })
    .where(eq(expenseVendorCategoryRules.normalizedVendor, normalizedVendor));

  await tx
    .insert(expenseVendorCategoryRules)
    .values({
      normalizedVendor,
      categoryId: input.categoryId,
      confirmationCount: 0,
      disagreementCount: 0,
      ownerLocked: true,
      lockedBy: input.reviewerId,
      lockedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [
        expenseVendorCategoryRules.normalizedVendor,
        expenseVendorCategoryRules.categoryId,
      ],
      set: {
        ownerLocked: true,
        lockedBy: input.reviewerId,
        lockedAt: input.now,
        updatedAt: input.now,
      },
    });
}

export type AttachedReimbursement = {
  claimId: string;
  adjustmentId: string;
  payoutRunId: string;
};

/** Attach approved, unassigned claims to a draft run without another expense. */
export async function attachApprovedReimbursementClaimsToDraftPayout(
  tx: TeamMutationTransaction,
  input: {
    payoutRunId: string;
    actorId: string | null;
    memberId?: string | null;
    touchPayoutRun?: boolean;
    now?: Date;
  },
): Promise<AttachedReimbursement[]> {
  const now = input.now ?? new Date();
  const [run] = await tx
    .select({
      id: payoutRuns.id,
      status: payoutRuns.status,
      updatedAt: payoutRuns.updatedAt,
    })
    .from(payoutRuns)
    .where(eq(payoutRuns.id, input.payoutRunId))
    .for("update")
    .limit(1);
  if (!run || run.status !== "draft") return [];

  const conditions = [eq(expenseReimbursementClaims.status, "approved")];
  if (input.memberId) {
    conditions.push(eq(expenseReimbursementClaims.memberId, input.memberId));
  }
  const claims = await tx
    .select({
      id: expenseReimbursementClaims.id,
      expenseId: expenseReimbursementClaims.expenseId,
      memberId: expenseReimbursementClaims.memberId,
      amountCents: expenseReimbursementClaims.amountCents,
      version: expenseReimbursementClaims.version,
    })
    .from(expenseReimbursementClaims)
    .where(and(...conditions))
    .orderBy(asc(expenseReimbursementClaims.createdAt))
    .for("update");

  const attached: AttachedReimbursement[] = [];
  for (const claim of claims) {
    const [adjustment] = await tx
      .insert(payoutRunAdjustments)
      .values({
        payoutRunId: run.id,
        memberId: claim.memberId,
        kind: "reimbursement",
        amountCents: claim.amountCents,
        note: `Expense reimbursement ${claim.expenseId}`,
        expenseId: claim.expenseId,
        createdBy: input.actorId,
        createdAt: now,
      })
      .returning({ id: payoutRunAdjustments.id });
    if (!adjustment) {
      throw new TeamMutationFailure(
        "internal",
        "The reimbursement could not be attached to payroll.",
        { retryable: true },
      );
    }
    const [updated] = await tx
      .update(expenseReimbursementClaims)
      .set({
        status: "attached",
        payoutRunId: run.id,
        payoutAdjustmentId: adjustment.id,
        attachedAt: now,
        version: claim.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(expenseReimbursementClaims.id, claim.id),
          eq(expenseReimbursementClaims.status, "approved"),
          eq(expenseReimbursementClaims.version, claim.version),
        ),
      )
      .returning({ id: expenseReimbursementClaims.id });
    if (!updated) {
      throw new TeamMutationFailure(
        "conflict",
        "The reimbursement changed while payroll was being updated.",
        { retryable: true },
      );
    }
    attached.push({
      claimId: claim.id,
      adjustmentId: adjustment.id,
      payoutRunId: run.id,
    });
  }

  if (attached.length > 0 && input.touchPayoutRun !== false) {
    await tx
      .update(payoutRuns)
      .set({
        updatedAt: nextVersionTimestamp(run.updatedAt, now),
        reportHtml: null,
        reportGeneratedAt: null,
      })
      .where(and(eq(payoutRuns.id, run.id), eq(payoutRuns.status, "draft")));
  }

  return attached;
}

async function attachClaimToNextDraftPayout(
  tx: TeamMutationTransaction,
  input: { memberId: string; actorId: string | null; now: Date },
): Promise<AttachedReimbursement | null> {
  const [nextRun] = await tx
    .select({ id: payoutRuns.id })
    .from(payoutRuns)
    .where(
      and(
        eq(payoutRuns.status, "draft"),
        eq(payoutRuns.periodCanonical, true),
        eq(payoutRuns.timezone, EXPENSE_BUSINESS_TIME_ZONE),
      ),
    )
    .orderBy(asc(payoutRuns.scheduledPayoutAt), asc(payoutRuns.id))
    .for("update")
    .limit(1);
  if (!nextRun) return null;
  const attached = await attachApprovedReimbursementClaimsToDraftPayout(tx, {
    payoutRunId: nextRun.id,
    actorId: input.actorId,
    memberId: input.memberId,
    now: input.now,
  });
  return attached[0] ?? null;
}

async function createApprovedReimbursementClaim(
  tx: TeamMutationTransaction,
  input: {
    expenseId: string;
    memberId: string;
    amountCents: number;
    reviewerId: string;
    now: Date;
  },
): Promise<{ id: string; status: "approved" | "attached" }> {
  const [claim] = await tx
    .insert(expenseReimbursementClaims)
    .values({
      expenseId: input.expenseId,
      memberId: input.memberId,
      amountCents: input.amountCents,
      status: "approved",
      reviewedBy: input.reviewerId,
      reviewedAt: input.now,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: expenseReimbursementClaims.id });
  if (!claim) {
    throw new TeamMutationFailure(
      "internal",
      "The reimbursement claim could not be created.",
      { retryable: true },
    );
  }
  const attached = await attachClaimToNextDraftPayout(tx, {
    memberId: input.memberId,
    actorId: input.reviewerId,
    now: input.now,
  });
  return { id: claim.id, status: attached ? "attached" : "approved" };
}

export async function createExpenseSubmissionInTransaction(
  tx: TeamMutationTransaction,
  input: {
    submission: ExpenseSubmissionInput;
    actorId: string;
    submittedById?: string;
    canApprove: boolean;
    source: ExpenseSubmissionSource;
    receiptCaptureId?: string | null;
    now?: Date;
  },
): Promise<CreatedExpenseSubmission> {
  const now = input.now ?? new Date();
  if (
    input.submission.payerType === "personal" &&
    !isExpenseReimbursementEnabled()
  ) {
    throw new TeamMutationFailure(
      "forbidden",
      "Personal-paid expenses are temporarily unavailable. Use company-paid or contact an owner.",
    );
  }
  const categories = await assertSubmissionReferences(
    tx,
    input.submission,
    input.actorId,
    input.canApprove,
  );
  const primaryCategory = categories.get(input.submission.categoryId);
  if (!primaryCategory) {
    throw new TeamMutationFailure("invalid", "Choose an active category.");
  }
  const reviewStatus = input.canApprove ? "approved" : "pending";
  const [created] = await tx
    .insert(expenses)
    .values({
      amount: input.submission.amountCents,
      currency: "USD",
      category: primaryCategory.name,
      categoryId: primaryCategory.id,
      categoryNeedsReview: false,
      vendor: input.submission.vendor,
      memo: input.submission.notes,
      method: input.submission.method,
      source: input.source,
      submittedBy: input.submittedById ?? input.actorId,
      payerType: input.submission.payerType,
      paidByMemberId: input.submission.paidByMemberId,
      reviewStatus,
      reviewedBy: input.canApprove ? input.actorId : null,
      reviewedAt: input.canApprove ? now : null,
      receiptCaptureId: input.receiptCaptureId ?? null,
      appointmentId: input.submission.appointmentId,
      paidAt: expenseBusinessDateToTimestamp(input.submission.purchaseDate),
      lifecycleStatus: "draft",
      version: 1,
      postedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: expenses.id });
  if (!created) {
    throw new TeamMutationFailure(
      "internal",
      "The expense submission could not be created.",
      { retryable: true },
    );
  }

  await tx.insert(expenseAllocations).values(
    (input.submission.allocations ?? []).map((allocation) => ({
      expenseId: created.id,
      categoryId: allocation.categoryId,
      amountCents: allocation.amountCents,
      createdAt: now,
    })),
  );

  let reimbursementClaimId: string | null = null;
  let reimbursementStatus: "approved" | "attached" | null = null;
  if (input.canApprove) {
    const [posted] = await tx
      .update(expenses)
      .set({
        lifecycleStatus: "posted",
        postedAt: now,
        postedBy: input.actorId,
        version: 2,
        updatedAt: now,
      })
      .where(and(eq(expenses.id, created.id), eq(expenses.version, 1)))
      .returning({ id: expenses.id });
    if (!posted) {
      throw new TeamMutationFailure(
        "conflict",
        "The expense changed before it could post.",
        { retryable: true },
      );
    }
    await recordApprovedVendorCategory(tx, {
      vendor: input.submission.vendor,
      categoryId: input.submission.categoryId,
    });
    if (
      input.submission.payerType === "personal" &&
      input.submission.paidByMemberId
    ) {
      const claim = await createApprovedReimbursementClaim(tx, {
        expenseId: created.id,
        memberId: input.submission.paidByMemberId,
        amountCents: input.submission.amountCents,
        reviewerId: input.actorId,
        now,
      });
      reimbursementClaimId = claim.id;
      reimbursementStatus = claim.status;
    }
  }

  return {
    expenseId: created.id,
    lifecycleStatus: input.canApprove ? "posted" : "draft",
    reviewStatus,
    reimbursementClaimId,
    reimbursementStatus,
    version: input.canApprove ? 2 : 1,
  };
}

export async function reviewExpenseSubmissionInTransaction(
  tx: TeamMutationTransaction,
  input: {
    expenseId: string;
    reviewerId: string;
    expectedVersion: number;
    decision: ExpenseReviewDecision;
    now?: Date;
  },
): Promise<{
  expenseId: string;
  reviewStatus: "approved" | "rejected";
  lifecycleStatus: "posted" | "draft";
  version: number;
  reimbursementClaimId: string | null;
  reimbursementStatus: "approved" | "attached" | null;
  categoryId: string | null;
  category: string | null;
}> {
  const now = input.now ?? new Date();
  const [existing] = await tx
    .select({
      id: expenses.id,
      amount: expenses.amount,
      categoryId: expenses.categoryId,
      vendor: expenses.vendor,
      payerType: expenses.payerType,
      paidByMemberId: expenses.paidByMemberId,
      lifecycleStatus: expenses.lifecycleStatus,
      reviewStatus: expenses.reviewStatus,
      version: expenses.version,
    })
    .from(expenses)
    .where(eq(expenses.id, input.expenseId))
    .for("update")
    .limit(1);
  if (!existing) {
    throw new TeamMutationFailure("invalid", "The expense was not found.", {
      status: 404,
    });
  }
  if (
    existing.lifecycleStatus !== "draft" ||
    existing.reviewStatus !== "pending"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This expense is no longer awaiting review.",
    );
  }
  if (existing.version !== input.expectedVersion) {
    throw new TeamMutationFailure(
      "conflict",
      "The expense changed while you were reviewing it. Refresh and try again.",
      { retryable: true },
    );
  }
  const nextVersion = existing.version + 1;
  if (input.decision.decision === "reject") {
    const [rejected] = await tx
      .update(expenses)
      .set({
        reviewStatus: "rejected",
        reviewedBy: input.reviewerId,
        reviewedAt: now,
        reviewReason: input.decision.reason,
        version: nextVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(expenses.id, existing.id),
          eq(expenses.version, existing.version),
          eq(expenses.reviewStatus, "pending"),
        ),
      )
      .returning({ id: expenses.id });
    if (!rejected) {
      throw new TeamMutationFailure(
        "conflict",
        "The expense changed while it was being rejected.",
        { retryable: true },
      );
    }
    return {
      expenseId: existing.id,
      reviewStatus: "rejected",
      lifecycleStatus: "draft",
      version: nextVersion,
      reimbursementClaimId: null,
      reimbursementStatus: null,
      categoryId: existing.categoryId,
      category: null,
    };
  }

  const requestedCategoryId = input.decision.categoryId ?? existing.categoryId;
  if (!requestedCategoryId) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a category before approving this expense.",
      { fieldErrors: { categoryId: "Choose an active expense category." } },
    );
  }
  const requestedAllocations =
    input.decision.allocations && input.decision.allocations.length > 0
      ? input.decision.allocations
      : input.decision.categoryId
        ? [{ categoryId: requestedCategoryId, amountCents: existing.amount }]
        : null;
  let approvedCategoryName: string | null = null;
  if (requestedAllocations) {
    const validated = validateExpenseAllocations({
      totalCents: existing.amount,
      allocations: requestedAllocations,
    });
    if (!validated.ok) {
      throw new TeamMutationFailure(
        "invalid",
        "Category splits must add up to the expense total exactly.",
        {
          fieldErrors: {
            allocations:
              validated.issues[0]?.message ??
              "Review the category split amounts.",
          },
        },
      );
    }
    if (
      !validated.allocationSet.allocations.some(
        (allocation) => allocation.categoryId === requestedCategoryId,
      )
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The primary category must be included in the category split.",
        { fieldErrors: { categoryId: "Choose an allocated category." } },
      );
    }
    const categoryIds = validated.allocationSet.allocations.map(
      (allocation) => allocation.categoryId,
    );
    const categoryRows = await tx
      .select({ id: expenseCategories.id, name: expenseCategories.name })
      .from(expenseCategories)
      .where(
        and(
          inArray(expenseCategories.id, categoryIds),
          eq(expenseCategories.isActive, true),
        ),
      );
    if (categoryRows.length !== new Set(categoryIds).size) {
      throw new TeamMutationFailure(
        "invalid",
        "One or more expense categories are unavailable.",
        { fieldErrors: { categoryId: "Choose active expense categories." } },
      );
    }
    approvedCategoryName =
      categoryRows.find((category) => category.id === requestedCategoryId)
        ?.name ?? null;
    if (!approvedCategoryName) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose an active primary category.",
        { fieldErrors: { categoryId: "Choose an active expense category." } },
      );
    }
    await tx
      .delete(expenseAllocations)
      .where(eq(expenseAllocations.expenseId, existing.id));
    await tx.insert(expenseAllocations).values(
      validated.allocationSet.allocations.map((allocation) => ({
        expenseId: existing.id,
        categoryId: allocation.categoryId,
        amountCents: allocation.amountCents,
        createdAt: now,
      })),
    );
  } else if (existing.categoryId) {
    const [category] = await tx
      .select({ name: expenseCategories.name })
      .from(expenseCategories)
      .where(eq(expenseCategories.id, existing.categoryId))
      .limit(1);
    approvedCategoryName = category?.name ?? null;
  }

  const [approved] = await tx
    .update(expenses)
    .set({
      categoryId: requestedCategoryId,
      ...(approvedCategoryName ? { category: approvedCategoryName } : {}),
      categoryNeedsReview: false,
      reviewStatus: "approved",
      reviewedBy: input.reviewerId,
      reviewedAt: now,
      reviewReason: input.decision.reason,
      lifecycleStatus: "posted",
      postedAt: now,
      postedBy: input.reviewerId,
      version: nextVersion,
      updatedAt: now,
    })
    .where(
      and(
        eq(expenses.id, existing.id),
        eq(expenses.version, existing.version),
        eq(expenses.reviewStatus, "pending"),
      ),
    )
    .returning({ id: expenses.id });
  if (!approved) {
    throw new TeamMutationFailure(
      "conflict",
      "The expense changed while it was being approved.",
      { retryable: true },
    );
  }
  await recordApprovedVendorCategory(tx, {
    vendor: existing.vendor,
    categoryId: requestedCategoryId,
  });
  if (input.decision.lockVendorRule) {
    await lockApprovedVendorCategory(tx, {
      vendor: existing.vendor,
      categoryId: requestedCategoryId,
      reviewerId: input.reviewerId,
      now,
    });
  }

  let reimbursementClaimId: string | null = null;
  let reimbursementStatus: "approved" | "attached" | null = null;
  if (existing.payerType === "personal" && existing.paidByMemberId) {
    const claim = await createApprovedReimbursementClaim(tx, {
      expenseId: existing.id,
      memberId: existing.paidByMemberId,
      amountCents: existing.amount,
      reviewerId: input.reviewerId,
      now,
    });
    reimbursementClaimId = claim.id;
    reimbursementStatus = claim.status;
  }

  return {
    expenseId: existing.id,
    reviewStatus: "approved",
    lifecycleStatus: "posted",
    version: nextVersion,
    reimbursementClaimId,
    reimbursementStatus,
    categoryId: requestedCategoryId,
    category: approvedCategoryName,
  };
}

export async function markAttachedReimbursementClaimsPaid(
  tx: TeamMutationTransaction,
  input: { payoutRunId: string; paidAt: Date },
): Promise<number> {
  const claims = await tx
    .select({
      id: expenseReimbursementClaims.id,
      version: expenseReimbursementClaims.version,
    })
    .from(expenseReimbursementClaims)
    .where(
      and(
        eq(expenseReimbursementClaims.payoutRunId, input.payoutRunId),
        eq(expenseReimbursementClaims.status, "attached"),
      ),
    )
    .for("update");
  for (const claim of claims) {
    await tx
      .update(expenseReimbursementClaims)
      .set({
        status: "paid",
        paidAt: input.paidAt,
        version: claim.version + 1,
        updatedAt: input.paidAt,
      })
      .where(
        and(
          eq(expenseReimbursementClaims.id, claim.id),
          eq(expenseReimbursementClaims.status, "attached"),
          eq(expenseReimbursementClaims.version, claim.version),
        ),
      );
  }
  return claims.length;
}
