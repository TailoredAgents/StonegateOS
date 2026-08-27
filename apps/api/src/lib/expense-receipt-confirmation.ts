import { and, eq } from "drizzle-orm";
import { expenseReceiptCaptures } from "@/db";
import { findExactExpenseReceiptDuplicateForPosting } from "@/lib/expense-receipt-evidence";
import {
  createExpenseSubmissionInTransaction,
  parseExpenseSubmission,
  type CreatedExpenseSubmission,
  type ExpenseSubmissionInput,
} from "@/lib/expense-submissions";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export type ParsedExpenseReceiptConfirmation = {
  submission: ExpenseSubmissionInput;
  exactDuplicateOverrideReason: string | null;
};

export function parseExpenseReceiptConfirmation(
  input: unknown,
): ParsedExpenseReceiptConfirmation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      submission: parseExpenseSubmission(input),
      exactDuplicateOverrideReason: null,
    };
  }
  const { exactDuplicateOverrideReason: rawReason, ...submissionBody } =
    input as Record<string, unknown>;
  if (
    rawReason !== undefined &&
    rawReason !== null &&
    typeof rawReason !== "string"
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The duplicate override reason must be text.",
      {
        fieldErrors: {
          exactDuplicateOverrideReason: "Enter a written override reason.",
        },
      },
    );
  }
  const exactDuplicateOverrideReason =
    typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason.trim()
      : null;
  if (
    exactDuplicateOverrideReason &&
    exactDuplicateOverrideReason.length > 500
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The duplicate override reason is too long.",
      {
        fieldErrors: {
          exactDuplicateOverrideReason: "Keep the reason under 500 characters.",
        },
      },
    );
  }
  return {
    submission: parseExpenseSubmission(submissionBody),
    exactDuplicateOverrideReason,
  };
}

export type ConfirmedExpenseReceipt = CreatedExpenseSubmission & {
  captureId: string;
  captureStatus: "confirmed";
  captureVersion: number;
  priorCaptureVersion: number;
  captureSubmittedBy: string;
  exactDuplicateOfCaptureId: string | null;
  duplicateOverrideRecorded: boolean;
};

/**
 * The only bridge from receipt analysis into the ledger. Every financial value
 * comes from the human-confirmed submission; AI extraction is not read here.
 */
export async function confirmExpenseReceiptInTransaction(
  tx: TeamMutationTransaction,
  input: {
    captureId: string;
    expectedVersion: number;
    actorId: string;
    canApprove: boolean;
    confirmation: ParsedExpenseReceiptConfirmation;
    now?: Date;
  },
): Promise<ConfirmedExpenseReceipt> {
  const [capture] = await tx
    .select({
      id: expenseReceiptCaptures.id,
      submittedBy: expenseReceiptCaptures.submittedBy,
      status: expenseReceiptCaptures.status,
      version: expenseReceiptCaptures.version,
      sha256: expenseReceiptCaptures.sha256,
      exactDuplicateOfCaptureId:
        expenseReceiptCaptures.exactDuplicateOfCaptureId,
    })
    .from(expenseReceiptCaptures)
    .where(eq(expenseReceiptCaptures.id, input.captureId))
    .for("update")
    .limit(1);
  if (
    !capture ||
    (capture.submittedBy !== input.actorId && !input.canApprove)
  ) {
    throw new TeamMutationFailure("invalid", "The receipt was not found.", {
      status: 404,
    });
  }
  if (capture.status !== "ready") {
    throw new TeamMutationFailure(
      "conflict",
      capture.status === "confirmed"
        ? "This receipt has already been confirmed."
        : "Wait for receipt analysis to finish before confirming it.",
      { retryable: capture.status !== "confirmed" },
    );
  }
  if (capture.version !== input.expectedVersion) {
    throw new TeamMutationFailure(
      "conflict",
      "The receipt changed while you were reviewing it. Refresh and try again.",
      { retryable: true },
    );
  }

  const exactDuplicateOfCaptureId =
    capture.exactDuplicateOfCaptureId ??
    (await findExactExpenseReceiptDuplicateForPosting(tx, {
      captureId: capture.id,
      sha256: capture.sha256,
    }));
  const duplicateReason = input.confirmation.exactDuplicateOverrideReason;
  if (exactDuplicateOfCaptureId) {
    if (!input.canApprove) {
      throw new TeamMutationFailure(
        "conflict",
        "This exact receipt already exists. An owner must review and override it.",
        {
          fieldErrors: {
            exactDuplicateOverrideReason: "Owner approval is required.",
          },
        },
      );
    }
    if (!duplicateReason || duplicateReason.length < 10) {
      throw new TeamMutationFailure(
        "invalid",
        "Add a specific reason for posting an exact duplicate receipt.",
        {
          fieldErrors: {
            exactDuplicateOverrideReason:
              "Enter at least 10 characters explaining why this is not a duplicate expense.",
          },
        },
      );
    }
  } else if (duplicateReason) {
    throw new TeamMutationFailure(
      "invalid",
      "A duplicate override is only allowed when an exact duplicate was detected.",
      {
        fieldErrors: {
          exactDuplicateOverrideReason: "Remove the override reason.",
        },
      },
    );
  }

  const now = input.now ?? new Date();
  const created = await createExpenseSubmissionInTransaction(tx, {
    submission: input.confirmation.submission,
    actorId: input.actorId,
    submittedById: capture.submittedBy,
    canApprove: input.canApprove,
    source: "receipt_scan",
    receiptCaptureId: capture.id,
    now,
  });
  const [confirmed] = await tx
    .update(expenseReceiptCaptures)
    .set({
      status: "confirmed",
      confirmedAt: now,
      exactDuplicateOfCaptureId,
      duplicateOverrideReason: exactDuplicateOfCaptureId
        ? duplicateReason
        : null,
      duplicateOverrideBy: exactDuplicateOfCaptureId ? input.actorId : null,
      duplicateOverrideAt: exactDuplicateOfCaptureId ? now : null,
      version: capture.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(expenseReceiptCaptures.id, capture.id),
        eq(expenseReceiptCaptures.status, "ready"),
        eq(expenseReceiptCaptures.version, capture.version),
      ),
    )
    .returning({
      id: expenseReceiptCaptures.id,
      version: expenseReceiptCaptures.version,
    });
  if (!confirmed) {
    throw new TeamMutationFailure(
      "conflict",
      "The receipt changed before confirmation completed.",
      { retryable: true },
    );
  }

  return {
    ...created,
    captureId: capture.id,
    captureStatus: "confirmed",
    captureVersion: confirmed.version,
    priorCaptureVersion: capture.version,
    captureSubmittedBy: capture.submittedBy,
    exactDuplicateOfCaptureId,
    duplicateOverrideRecorded: Boolean(exactDuplicateOfCaptureId),
  };
}
