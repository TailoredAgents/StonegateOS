import { and, eq } from "drizzle-orm";
import { expenseReceiptCaptures } from "@/db";
import { findExactExpenseReceiptDuplicateForPosting } from "@/lib/expense-receipt-evidence";
import { parseStoredExpenseReceiptExtraction } from "@/lib/expense-receipt-domain";
import { isExpenseDumpTicketsEnabled } from "@/lib/expense-feature-flags";
import {
  createExpenseSubmissionInTransaction,
  parseExpenseDuplicateOverrideReason,
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
  scaleTicketDisposition: "not_scale_ticket" | null;
  receiptReviewContractVersion: 2 | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function receiptReviewUpgradeRequired(): TeamMutationFailure {
  return new TeamMutationFailure(
    "conflict",
    "Refresh StonegateOS before reviewing this scale ticket.",
    {
      status: 409,
      retryable: false,
      fieldErrors: {
        receiptReviewContractVersion:
          "Close and reopen or refresh StonegateOS, then review the receipt again.",
      },
    },
  );
}

/**
 * Fails closed for stored evidence written by a future or malformed extractor.
 * A strict parse gives us the canonical signal; recognizable raw scale fields
 * remain a review requirement even when the rest of the payload is invalid.
 */
export function storedExpenseReceiptExtractionRequiresDumpReview(
  input: unknown,
): boolean {
  const stored = isRecord(input) ? input : null;
  const raw = stored && "raw" in stored ? stored["raw"] : input;
  const extraction = parseStoredExpenseReceiptExtraction(raw);
  if (
    extraction &&
    (extraction.documentType === "scale_ticket" ||
      extraction.dumpTicket !== null)
  ) {
    return true;
  }
  if (!isRecord(raw)) return false;
  return (
    raw["documentType"] === "scale_ticket" ||
    raw["receiptType"] === "scale_ticket" ||
    ("dumpTicket" in raw && raw["dumpTicket"] !== null) ||
    ("dumpDetails" in raw && raw["dumpDetails"] !== null)
  );
}

export function parseExpenseReceiptConfirmation(
  input: unknown,
): ParsedExpenseReceiptConfirmation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      submission: parseExpenseSubmission(input),
      exactDuplicateOverrideReason: null,
      scaleTicketDisposition: null,
      receiptReviewContractVersion: null,
    };
  }
  const {
    exactDuplicateOverrideReason: rawReason,
    scaleTicketDisposition: rawDisposition,
    receiptReviewContractVersion: rawContractVersion,
    ...submissionBody
  } = input as Record<string, unknown>;
  if (
    rawContractVersion !== undefined &&
    rawContractVersion !== null &&
    rawContractVersion !== 2
  ) {
    throw receiptReviewUpgradeRequired();
  }
  if (
    rawDisposition !== undefined &&
    rawDisposition !== null &&
    rawDisposition !== "not_scale_ticket"
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a valid receipt classification.",
      {
        fieldErrors: {
          scaleTicketDisposition:
            "Choose Not a scale ticket or review the weight fields.",
        },
      },
    );
  }
  const submission = parseExpenseSubmission(submissionBody);
  const scaleTicketDisposition =
    rawDisposition === "not_scale_ticket" ? rawDisposition : null;
  if (
    scaleTicketDisposition === "not_scale_ticket" &&
    submission.dumpDetails !== null
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "A receipt cannot be both a reviewed scale ticket and not a scale ticket.",
      {
        fieldErrors: {
          scaleTicketDisposition:
            "Remove the scale-ticket details before changing the classification.",
          dumpDetails:
            "Remove these fields or keep the receipt classified as a scale ticket.",
        },
      },
    );
  }
  return {
    submission,
    exactDuplicateOverrideReason:
      parseExpenseDuplicateOverrideReason(rawReason),
    scaleTicketDisposition,
    receiptReviewContractVersion: rawContractVersion === 2 ? 2 : null,
  };
}

export type ConfirmedExpenseReceipt = CreatedExpenseSubmission & {
  captureId: string;
  captureStatus: "confirmed";
  captureVersion: number;
  priorCaptureVersion: number;
  captureSubmittedBy: string;
  exactDuplicateOfCaptureId: string | null;
  scaleTicketDuplicateOfExpenseId: string | null;
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
    canManageFixedCostCoverage?: boolean;
    dumpTicketsEnabled?: boolean;
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
      extraction: expenseReceiptCaptures.extraction,
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

  const dumpTicketsEnabled =
    input.dumpTicketsEnabled ?? isExpenseDumpTicketsEnabled();
  const requiresDumpReview =
    dumpTicketsEnabled &&
    storedExpenseReceiptExtractionRequiresDumpReview(capture.extraction);
  if (
    requiresDumpReview &&
    input.confirmation.receiptReviewContractVersion !== 2
  ) {
    throw receiptReviewUpgradeRequired();
  }
  if (
    input.confirmation.scaleTicketDisposition === "not_scale_ticket" &&
    !requiresDumpReview
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "This receipt was not classified as a scale ticket.",
      {
        fieldErrors: {
          scaleTicketDisposition: "Remove the classification override.",
        },
      },
    );
  }
  if (
    requiresDumpReview &&
    !input.confirmation.submission.dumpDetails &&
    input.confirmation.scaleTicketDisposition !== "not_scale_ticket"
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Review the scale-ticket weight before submitting this expense.",
      {
        fieldErrors: {
          dumpDetails:
            "Confirm the visible net weight or explicitly mark it unreadable.",
        },
      },
    );
  }

  const exactDuplicateOfCaptureId =
    capture.exactDuplicateOfCaptureId ??
    (await findExactExpenseReceiptDuplicateForPosting(tx, {
      captureId: capture.id,
      sha256: capture.sha256,
    }));
  if (exactDuplicateOfCaptureId && !input.canApprove) {
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

  const now = input.now ?? new Date();
  const created = await createExpenseSubmissionInTransaction(tx, {
    submission: input.confirmation.submission,
    actorId: input.actorId,
    submittedById: capture.submittedBy,
    canApprove: input.canApprove,
    canManageFixedCostCoverage: input.canManageFixedCostCoverage,
    source: "receipt_scan",
    receiptCaptureId: capture.id,
    duplicateOverrideReason: input.confirmation.exactDuplicateOverrideReason,
    externalDuplicateMatched: Boolean(exactDuplicateOfCaptureId),
    now,
  });
  const [confirmed] = await tx
    .update(expenseReceiptCaptures)
    .set({
      status: "confirmed",
      confirmedAt: now,
      exactDuplicateOfCaptureId,
      duplicateOverrideReason: created.duplicateOverrideRecorded
        ? input.confirmation.exactDuplicateOverrideReason
        : null,
      duplicateOverrideBy: created.duplicateOverrideRecorded
        ? input.actorId
        : null,
      duplicateOverrideAt: created.duplicateOverrideRecorded ? now : null,
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
    scaleTicketDuplicateOfExpenseId: created.scaleTicketDuplicateOfExpenseId,
    duplicateOverrideRecorded: created.duplicateOverrideRecorded,
  };
}
