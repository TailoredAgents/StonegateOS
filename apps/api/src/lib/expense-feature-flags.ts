import { isOperationalFeatureEnabled } from "@/lib/feature-flags";

export function isExpenseReceiptCaptureEnabled(): boolean {
  return isExpenseReceiptCaptureApiEnabled() && isExpenseReceiptWorkerEnabled();
}

export function isExpenseReceiptCaptureApiEnabled(): boolean {
  return isOperationalFeatureEnabled("EXPENSE_RECEIPT_CAPTURE_ENABLED");
}

export function isExpenseReceiptWorkerEnabled(): boolean {
  return isOperationalFeatureEnabled("EXPENSE_RECEIPT_WORKER_ENABLED");
}

export function isExpenseReceiptCrewEnabled(): boolean {
  return isOperationalFeatureEnabled("EXPENSE_RECEIPT_CREW_ENABLED");
}

export function canUseExpenseReceiptCapture(canApprove: boolean): boolean {
  return (
    isExpenseReceiptCaptureEnabled() &&
    (canApprove || isExpenseReceiptCrewEnabled())
  );
}

export function isExpenseAdSpendEnabled(): boolean {
  return isOperationalFeatureEnabled("EXPENSE_AD_SPEND_ENABLED");
}

export function isExpenseReimbursementEnabled(): boolean {
  return isOperationalFeatureEnabled("EXPENSE_REIMBURSEMENT_ENABLED");
}

export function isExpenseOverviewEnabled(): boolean {
  return isOperationalFeatureEnabled("EXPENSE_OVERVIEW_ENABLED");
}

/** Gates owner setup/mutations; stored costs always remain in Overview totals. */
export function isExpenseFixedCostsEnabled(): boolean {
  return isOperationalFeatureEnabled("EXPENSE_FIXED_COSTS_ENABLED");
}

/** Gates new dump-ticket capture and mutation surfaces; stored facts remain readable. */
export function isExpenseDumpTicketsEnabled(): boolean {
  return isOperationalFeatureEnabled("EXPENSE_DUMP_TICKETS_ENABLED");
}
