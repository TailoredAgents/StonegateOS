import { eq } from "drizzle-orm";
import { dailyAdSpend } from "@/db";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

type ExpenseWorkflowRecord = {
  id: string;
  source: string;
  categoryId: string | null;
  submittedBy: string | null;
  receiptCaptureId: string | null;
  payerType: "company" | "personal";
  reviewStatus: "draft" | "pending" | "approved" | "rejected";
};

export async function assertGenericExpenseMutationAllowed(
  tx: TeamMutationTransaction,
  expense: ExpenseWorkflowRecord,
  action: "edit" | "post" | "correct" | "void",
): Promise<void> {
  if (action === "post" && expense.reviewStatus !== "approved") {
    const isMigratedLegacyDraft =
      expense.reviewStatus === "draft" &&
      expense.source === "manual" &&
      expense.payerType === "company";
    if (!isMigratedLegacyDraft) {
      throw new TeamMutationFailure(
        "conflict",
        "Pending expense submissions must be approved through the review workflow.",
      );
    }
  }

  const hasV2Evidence = Boolean(
    expense.categoryId ||
      expense.submittedBy ||
      expense.receiptCaptureId ||
      expense.payerType === "personal",
  );
  const isOwnerManualDraft =
    expense.source === "manual" &&
    expense.reviewStatus === "draft" &&
    expense.payerType === "company";
  if (action === "edit" && hasV2Evidence && !isOwnerManualDraft) {
    throw new TeamMutationFailure(
      "conflict",
      "Submitted expenses cannot be edited through the legacy draft form. Review or reject the submission instead.",
    );
  }

  if (action !== "correct" && action !== "void") return;

  const [adEntry] = await tx
    .select({
      platform: dailyAdSpend.platform,
      businessDate: dailyAdSpend.businessDate,
    })
    .from(dailyAdSpend)
    .where(eq(dailyAdSpend.currentExpenseId, expense.id))
    .limit(1);
  if (adEntry) {
    throw new TeamMutationFailure(
      "conflict",
      "Update this amount from Daily Ad Spend so the authoritative day stays reconciled.",
    );
  }
}
