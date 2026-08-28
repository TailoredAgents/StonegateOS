import { and, eq } from "drizzle-orm";
import {
  expenseAllocations,
  expenseDumpDetails,
  expenseReimbursementClaims,
  expenses,
  payoutRunAdjustments,
  payoutRuns,
} from "@/db";
import {
  replaceExpenseDumpDetailsInTransaction,
  type ExpenseDumpDetailsInput,
} from "@/lib/expense-submissions";
import {
  normalizeExpenseCategoryAlias,
  resolveExpenseCategoryAlias,
} from "@/lib/expense-categories";
import {
  assertExpenseFixedCostCoverageLink,
  assertFixedCostCoverageLinkCanBeEstablished,
} from "@/lib/expense-fixed-cost-coverage";
import {
  findScaleTicketDuplicateForPosting,
  normalizeScaleTicketDuplicateIdentity,
} from "@/lib/expense-receipt-evidence";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

type ExpenseRecord = typeof expenses.$inferSelect;

type Allocation = {
  categoryId: string;
  amountCents: number;
};

type GeneratedLedgerEntry = {
  id: string;
  version: number;
  coveredByFixedCostSeriesId: string | null;
};

export type ManagedExpenseCorrectionResult = {
  reversal: GeneratedLedgerEntry;
  replacement: GeneratedLedgerEntry;
  allocationStrategy: "preserved" | "single_category" | "unverified";
  reimbursementClaimId: string | null;
  reimbursementStatus: "pending" | "approved" | "attached" | null;
  dumpDetailsRecorded: boolean;
  scaleTicketDuplicateOfExpenseId: string | null;
};

export type ManagedExpenseVoidResult = {
  reversal: GeneratedLedgerEntry;
  reimbursementClaimId: string | null;
  reimbursementStatus: "rejected" | null;
};

async function loadAllocations(
  tx: TeamMutationTransaction,
  expenseId: string,
): Promise<Allocation[]> {
  return tx
    .select({
      categoryId: expenseAllocations.categoryId,
      amountCents: expenseAllocations.amountCents,
    })
    .from(expenseAllocations)
    .where(eq(expenseAllocations.expenseId, expenseId));
}

async function resolveReplacementCategory(
  tx: TeamMutationTransaction,
  existing: ExpenseRecord,
  requestedLabel: string,
): Promise<{
  category: string;
  categoryId: string | null;
  categoryNeedsReview: boolean;
}> {
  const normalized = normalizeExpenseCategoryAlias(requestedLabel);
  const existingNormalized = normalizeExpenseCategoryAlias(
    existing.category ?? "",
  );
  if (existing.categoryId && normalized === existingNormalized) {
    return {
      category: existing.category ?? requestedLabel,
      categoryId: existing.categoryId,
      categoryNeedsReview: existing.categoryNeedsReview,
    };
  }

  return resolveExpenseCategoryAlias(tx, requestedLabel);
}

async function insertGeneratedEntry(
  tx: TeamMutationTransaction,
  input: {
    existing: ExpenseRecord;
    amountCents: number;
    category: string | null;
    categoryId: string | null;
    categoryNeedsReview: boolean;
    allocations: Allocation[];
    actorId: string;
    reason: string;
    now: Date;
    kind: { reversalOfExpenseId: string } | { correctionOfExpenseId: string };
    coveredByFixedCostSeriesId?: string | null;
    replacement?: {
      vendor: string | null;
      memo: string | null;
      method: string | null;
      paidAt: Date;
      coverageStartAt: Date | null;
      coverageEndAt: Date | null;
    };
    dumpDetails?: ExpenseDumpDetailsInput | null;
    dumpDetailsConfirmation?: { confirmedBy: string; confirmedAt: Date };
  },
): Promise<GeneratedLedgerEntry> {
  const financial = input.replacement ?? {
    vendor: input.existing.vendor,
    memo: input.existing.memo,
    method: input.existing.method,
    paidAt: input.existing.paidAt,
    coverageStartAt: input.existing.coverageStartAt,
    coverageEndAt: input.existing.coverageEndAt,
  };
  const link =
    "reversalOfExpenseId" in input.kind
      ? { reversalOfExpenseId: input.kind.reversalOfExpenseId }
      : { correctionOfExpenseId: input.kind.correctionOfExpenseId };

  // Generated V2 entries start as transaction-local drafts so their signed
  // allocations can be installed before the deferred total check. They are
  // posted before the transaction can commit.
  const [created] = await tx
    .insert(expenses)
    .values({
      amount: input.amountCents,
      currency: input.existing.currency,
      category: input.category,
      categoryId: input.categoryId,
      categoryNeedsReview: input.categoryNeedsReview,
      vendor: financial.vendor,
      memo: financial.memo,
      method: financial.method,
      source: "manual_correction",
      submittedBy: input.existing.submittedBy,
      payerType: input.existing.payerType,
      paidByMemberId: input.existing.paidByMemberId,
      reviewStatus: "approved",
      reviewedBy: input.actorId,
      reviewedAt: input.now,
      reviewReason: input.reason,
      receiptCaptureId: null,
      appointmentId: input.existing.appointmentId,
      paidAt: financial.paidAt,
      coverageStartAt: financial.coverageStartAt,
      coverageEndAt: financial.coverageEndAt,
      coveredByFixedCostSeriesId: input.coveredByFixedCostSeriesId ?? null,
      lifecycleStatus: "draft",
      version: 1,
      postedAt: null,
      postedBy: null,
      ...link,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({
      id: expenses.id,
      coveredByFixedCostSeriesId: expenses.coveredByFixedCostSeriesId,
    });
  if (!created) {
    throw new TeamMutationFailure(
      "internal",
      "The linked ledger entry could not be created.",
      { retryable: true },
    );
  }

  if (input.allocations.length > 0) {
    await tx.insert(expenseAllocations).values(
      input.allocations.map((allocation) => ({
        expenseId: created.id,
        categoryId: allocation.categoryId,
        amountCents: allocation.amountCents,
        createdAt: input.now,
      })),
    );
  }

  if (input.dumpDetails) {
    await replaceExpenseDumpDetailsInTransaction(tx, {
      expenseId: created.id,
      dumpDetails: input.dumpDetails,
      confirmedBy: input.dumpDetailsConfirmation?.confirmedBy ?? input.actorId,
      confirmedAt: input.dumpDetailsConfirmation?.confirmedAt,
      now: input.now,
    });
  }

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
        eq(expenses.id, created.id),
        eq(expenses.lifecycleStatus, "draft"),
        eq(expenses.version, 1),
      ),
    )
    .returning({
      id: expenses.id,
      coveredByFixedCostSeriesId: expenses.coveredByFixedCostSeriesId,
    });
  if (!posted) {
    throw new TeamMutationFailure(
      "conflict",
      "The linked ledger entry changed before it could post.",
      { retryable: true },
    );
  }
  return {
    id: posted.id,
    version: 2,
    coveredByFixedCostSeriesId: posted.coveredByFixedCostSeriesId,
  };
}

async function moveReimbursementToCorrection(
  tx: TeamMutationTransaction,
  input: {
    existingExpenseId: string;
    replacementExpenseId: string;
    replacementAmountCents: number;
    actorId: string;
    now: Date;
  },
): Promise<{
  claimId: string | null;
  status: "pending" | "approved" | "attached" | null;
}> {
  const [claim] = await tx
    .select()
    .from(expenseReimbursementClaims)
    .where(eq(expenseReimbursementClaims.expenseId, input.existingExpenseId))
    .for("update")
    .limit(1);
  if (!claim || claim.status === "rejected") {
    return { claimId: null, status: null };
  }
  if (claim.status === "paid") {
    throw new TeamMutationFailure(
      "conflict",
      "This purchase was already reimbursed. Record any repayment or additional reimbursement through payroll before correcting the expense.",
    );
  }

  if (claim.status === "attached") {
    if (!claim.payoutRunId || !claim.payoutAdjustmentId) {
      throw new TeamMutationFailure(
        "internal",
        "The attached reimbursement record is incomplete.",
      );
    }
    const [run] = await tx
      .select({ id: payoutRuns.id, status: payoutRuns.status })
      .from(payoutRuns)
      .where(eq(payoutRuns.id, claim.payoutRunId))
      .for("update")
      .limit(1);
    if (!run || run.status !== "draft") {
      throw new TeamMutationFailure(
        "conflict",
        "This reimbursement is on a locked payout. Correct it with a later payroll adjustment so the locked payout stays immutable.",
      );
    }
    const [adjustment] = await tx
      .update(payoutRunAdjustments)
      .set({
        amountCents: input.replacementAmountCents,
        expenseId: input.replacementExpenseId,
        note: `Expense reimbursement ${input.replacementExpenseId}`,
      })
      .where(
        and(
          eq(payoutRunAdjustments.id, claim.payoutAdjustmentId),
          eq(payoutRunAdjustments.payoutRunId, run.id),
          eq(payoutRunAdjustments.kind, "reimbursement"),
        ),
      )
      .returning({ id: payoutRunAdjustments.id });
    if (!adjustment) {
      throw new TeamMutationFailure(
        "conflict",
        "The reimbursement adjustment changed. Refresh and try again.",
        { retryable: true },
      );
    }
    await tx
      .update(payoutRuns)
      .set({
        updatedAt: input.now,
        reportHtml: null,
        reportGeneratedAt: null,
      })
      .where(and(eq(payoutRuns.id, run.id), eq(payoutRuns.status, "draft")));
  }

  const [updated] = await tx
    .update(expenseReimbursementClaims)
    .set({
      expenseId: input.replacementExpenseId,
      amountCents: input.replacementAmountCents,
      version: claim.version + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(expenseReimbursementClaims.id, claim.id),
        eq(expenseReimbursementClaims.version, claim.version),
        eq(expenseReimbursementClaims.status, claim.status),
      ),
    )
    .returning({ id: expenseReimbursementClaims.id });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The reimbursement changed while the expense was being corrected.",
      { retryable: true },
    );
  }
  return {
    claimId: updated.id,
    status: claim.status,
  };
}

async function rejectReimbursementForVoid(
  tx: TeamMutationTransaction,
  input: {
    expenseId: string;
    actorId: string;
    reason: string;
    now: Date;
  },
): Promise<{ claimId: string | null; status: "rejected" | null }> {
  const [claim] = await tx
    .select()
    .from(expenseReimbursementClaims)
    .where(eq(expenseReimbursementClaims.expenseId, input.expenseId))
    .for("update")
    .limit(1);
  if (!claim || claim.status === "rejected") {
    return { claimId: claim?.id ?? null, status: claim ? "rejected" : null };
  }
  if (claim.status === "paid") {
    throw new TeamMutationFailure(
      "conflict",
      "This purchase was already reimbursed. Record a payroll recovery before voiding the expense.",
    );
  }

  let draftPayoutId: string | null = null;
  const adjustmentId = claim.payoutAdjustmentId;
  if (claim.status === "attached") {
    if (!claim.payoutRunId || !adjustmentId) {
      throw new TeamMutationFailure(
        "internal",
        "The attached reimbursement record is incomplete.",
      );
    }
    const [run] = await tx
      .select({ id: payoutRuns.id, status: payoutRuns.status })
      .from(payoutRuns)
      .where(eq(payoutRuns.id, claim.payoutRunId))
      .for("update")
      .limit(1);
    if (!run || run.status !== "draft") {
      throw new TeamMutationFailure(
        "conflict",
        "This reimbursement is on a locked payout. Record a payroll recovery before voiding the expense.",
      );
    }
    draftPayoutId = run.id;
  }

  const [rejected] = await tx
    .update(expenseReimbursementClaims)
    .set({
      status: "rejected",
      reviewedBy: input.actorId,
      reviewedAt: input.now,
      reviewReason: input.reason,
      payoutRunId: null,
      payoutAdjustmentId: null,
      attachedAt: null,
      paidAt: null,
      version: claim.version + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(expenseReimbursementClaims.id, claim.id),
        eq(expenseReimbursementClaims.version, claim.version),
        eq(expenseReimbursementClaims.status, claim.status),
      ),
    )
    .returning({ id: expenseReimbursementClaims.id });
  if (!rejected) {
    throw new TeamMutationFailure(
      "conflict",
      "The reimbursement changed while the expense was being voided.",
      { retryable: true },
    );
  }

  if (adjustmentId && draftPayoutId) {
    const [removed] = await tx
      .delete(payoutRunAdjustments)
      .where(
        and(
          eq(payoutRunAdjustments.id, adjustmentId),
          eq(payoutRunAdjustments.payoutRunId, draftPayoutId),
          eq(payoutRunAdjustments.kind, "reimbursement"),
        ),
      )
      .returning({ id: payoutRunAdjustments.id });
    if (!removed) {
      throw new TeamMutationFailure(
        "conflict",
        "The reimbursement adjustment changed. Refresh and try again.",
        { retryable: true },
      );
    }
    await tx
      .update(payoutRuns)
      .set({
        updatedAt: input.now,
        reportHtml: null,
        reportGeneratedAt: null,
      })
      .where(
        and(eq(payoutRuns.id, draftPayoutId), eq(payoutRuns.status, "draft")),
      );
  }
  return { claimId: rejected.id, status: "rejected" };
}

export async function createManagedExpenseCorrection(
  tx: TeamMutationTransaction,
  input: {
    existing: ExpenseRecord;
    replacement: {
      amountCents: number;
      category: string;
      vendor: string | null;
      memo: string | null;
      method: string | null;
      paidAt: Date;
      coverageStartAt: Date | null;
      coverageEndAt: Date | null;
    };
    actorId: string;
    reason: string;
    now: Date;
    /** Undefined preserves the original; null intentionally unlinks. */
    coveredByFixedCostSeriesId?: string | null;
    canManageFixedCostCoverage?: boolean;
    /** Undefined preserves existing facts; null explicitly removes them. */
    dumpDetails?: ExpenseDumpDetailsInput | null;
  },
): Promise<ManagedExpenseCorrectionResult> {
  const originalAllocations = await loadAllocations(tx, input.existing.id);
  const [originalDumpDetails] = await tx
    .select()
    .from(expenseDumpDetails)
    .where(eq(expenseDumpDetails.expenseId, input.existing.id))
    .limit(1);
  const replacementCategory = await resolveReplacementCategory(
    tx,
    input.existing,
    input.replacement.category,
  );
  const reversalAllocations = originalAllocations.map((allocation) => ({
    ...allocation,
    amountCents: -allocation.amountCents,
  }));
  const preservesAllocations =
    input.replacement.amountCents === input.existing.amount &&
    replacementCategory.categoryId === input.existing.categoryId;
  const replacementAllocations = preservesAllocations
    ? originalAllocations
    : replacementCategory.categoryId
      ? [
          {
            categoryId: replacementCategory.categoryId,
            amountCents: input.replacement.amountCents,
          },
        ]
      : [];
  const hasPositiveDumpFeesAllocation = replacementAllocations.some(
    (allocation) =>
      allocation.categoryId === "dump_fees" && allocation.amountCents > 0,
  );
  const preservesDumpDetails =
    input.dumpDetails === undefined && Boolean(originalDumpDetails);
  let replacementDumpDetails: ExpenseDumpDetailsInput | null;
  if (input.dumpDetails === undefined) {
    if (originalDumpDetails && !hasPositiveDumpFeesAllocation) {
      throw new TeamMutationFailure(
        "invalid",
        "Remove the reviewed dump-ticket facts when changing away from Dump Fees.",
        {
          fieldErrors: {
            dumpDetails:
              "Explicitly remove the dump-ticket details for this correction.",
          },
        },
      );
    }
    replacementDumpDetails = originalDumpDetails
      ? {
          weightStatus: originalDumpDetails.weightStatus,
          facilityName: originalDumpDetails.facilityName,
          ticketNumber: originalDumpDetails.ticketNumber,
          material: originalDumpDetails.material,
          grossWeightPounds: originalDumpDetails.grossWeightPounds,
          tareWeightPounds: originalDumpDetails.tareWeightPounds,
          netWeightPounds: originalDumpDetails.netWeightPounds,
          billedWeightMilliTons: originalDumpDetails.billedWeightMilliTons,
          unitRateCentsPerTon: originalDumpDetails.unitRateCentsPerTon,
          reviewed: true,
        }
      : null;
  } else {
    replacementDumpDetails = input.dumpDetails;
  }
  if (replacementDumpDetails && !hasPositiveDumpFeesAllocation) {
    throw new TeamMutationFailure(
      "invalid",
      "Dump-ticket facts require a positive Dump Fees allocation.",
      {
        fieldErrors: {
          dumpDetails: "Choose Dump Fees or remove the dump-ticket details.",
        },
      },
    );
  }
  let scaleTicketDuplicateOfExpenseId: string | null = null;
  if (input.dumpDetails) {
    const originalIdentity = normalizeScaleTicketDuplicateIdentity({
      facilityName: originalDumpDetails?.facilityName ?? null,
      ticketNumber: originalDumpDetails?.ticketNumber ?? null,
    });
    const replacementIdentity = normalizeScaleTicketDuplicateIdentity({
      facilityName: input.dumpDetails.facilityName,
      ticketNumber: input.dumpDetails.ticketNumber,
    });
    const identityChanged =
      replacementIdentity !== null &&
      (replacementIdentity.facilityName !== originalIdentity?.facilityName ||
        replacementIdentity.ticketNumber !== originalIdentity?.ticketNumber);
    if (identityChanged) {
      scaleTicketDuplicateOfExpenseId =
        await findScaleTicketDuplicateForPosting(tx, {
          facilityName: input.dumpDetails.facilityName,
          ticketNumber: input.dumpDetails.ticketNumber,
          excludeExpenseIds: [input.existing.id],
        });
      if (scaleTicketDuplicateOfExpenseId && input.reason.trim().length < 10) {
        throw new TeamMutationFailure(
          "invalid",
          "Add a specific correction reason to override the duplicate scale ticket.",
          {
            fieldErrors: {
              reason:
                "Enter at least 10 characters explaining why this is not a duplicate expense.",
            },
          },
        );
      }
    }
  }
  const coveredByFixedCostSeriesId =
    input.coveredByFixedCostSeriesId === undefined
      ? input.existing.coveredByFixedCostSeriesId
      : input.coveredByFixedCostSeriesId;
  assertFixedCostCoverageLinkCanBeEstablished({
    existingSeriesId: input.existing.coveredByFixedCostSeriesId,
    requestedSeriesId: coveredByFixedCostSeriesId,
    canManageCoverage: input.canManageFixedCostCoverage,
  });
  if (coveredByFixedCostSeriesId) {
    await assertExpenseFixedCostCoverageLink(tx, {
      seriesId: coveredByFixedCostSeriesId,
      purchaseDate: input.replacement.paidAt,
      amountCents: input.replacement.amountCents,
      categoryId: replacementCategory.categoryId,
      allocations: replacementAllocations,
      replacesExpenseId: input.existing.id,
    });
  }

  const reversal = await insertGeneratedEntry(tx, {
    existing: input.existing,
    amountCents: -input.existing.amount,
    category: input.existing.category,
    categoryId: input.existing.categoryId,
    categoryNeedsReview: input.existing.categoryNeedsReview,
    allocations: reversalAllocations,
    actorId: input.actorId,
    reason: input.reason,
    now: input.now,
    kind: { reversalOfExpenseId: input.existing.id },
  });
  const replacement = await insertGeneratedEntry(tx, {
    existing: input.existing,
    amountCents: input.replacement.amountCents,
    ...replacementCategory,
    allocations: replacementAllocations,
    actorId: input.actorId,
    reason: input.reason,
    now: input.now,
    kind: { correctionOfExpenseId: input.existing.id },
    coveredByFixedCostSeriesId,
    dumpDetails: replacementDumpDetails,
    dumpDetailsConfirmation:
      preservesDumpDetails && originalDumpDetails
        ? {
            confirmedBy: originalDumpDetails.confirmedBy,
            confirmedAt: originalDumpDetails.confirmedAt,
          }
        : undefined,
    replacement: {
      vendor: input.replacement.vendor,
      memo: input.replacement.memo,
      method: input.replacement.method,
      paidAt: input.replacement.paidAt,
      coverageStartAt: input.replacement.coverageStartAt,
      coverageEndAt: input.replacement.coverageEndAt,
    },
  });

  const reimbursement = await moveReimbursementToCorrection(tx, {
    existingExpenseId: input.existing.id,
    replacementExpenseId: replacement.id,
    replacementAmountCents: input.replacement.amountCents,
    actorId: input.actorId,
    now: input.now,
  });

  return {
    reversal,
    replacement,
    allocationStrategy: preservesAllocations
      ? "preserved"
      : replacementCategory.categoryId
        ? "single_category"
        : "unverified",
    reimbursementClaimId: reimbursement.claimId,
    reimbursementStatus: reimbursement.status,
    dumpDetailsRecorded: replacementDumpDetails !== null,
    scaleTicketDuplicateOfExpenseId,
  };
}

export async function createManagedExpenseVoid(
  tx: TeamMutationTransaction,
  input: {
    existing: ExpenseRecord;
    actorId: string;
    reason: string;
    now: Date;
  },
): Promise<ManagedExpenseVoidResult> {
  const originalAllocations = await loadAllocations(tx, input.existing.id);
  const reimbursement = await rejectReimbursementForVoid(tx, {
    expenseId: input.existing.id,
    actorId: input.actorId,
    reason: input.reason,
    now: input.now,
  });
  const reversal = await insertGeneratedEntry(tx, {
    existing: input.existing,
    amountCents: -input.existing.amount,
    category: input.existing.category,
    categoryId: input.existing.categoryId,
    categoryNeedsReview: input.existing.categoryNeedsReview,
    allocations: originalAllocations.map((allocation) => ({
      ...allocation,
      amountCents: -allocation.amountCents,
    })),
    actorId: input.actorId,
    reason: input.reason,
    now: input.now,
    kind: { reversalOfExpenseId: input.existing.id },
  });
  return {
    reversal,
    reimbursementClaimId: reimbursement.claimId,
    reimbursementStatus: reimbursement.status,
  };
}
