import { isOperationalFeatureEnabled } from "@/lib/feature-flags";

export function isExpenseReceiptCaptureEnabled(): boolean {
  return isOperationalFeatureEnabled("EXPENSE_RECEIPT_CAPTURE_ENABLED");
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
