import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  canUseExpenseReceiptCapture,
  isExpenseAdSpendEnabled,
  isExpenseOverviewEnabled,
  isExpenseReimbursementEnabled,
} from "@/lib/expense-feature-flags";
import {
  permissionMatches,
  requirePermission,
  resolvePermissionContext,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

function hasPermission(permissions: string[], required: string): boolean {
  return permissions.some((permission) =>
    permissionMatches(permission, required),
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, [
    "expenses.submit",
    "expenses.approve",
  ]);
  if (permissionError) return permissionError;
  const context = await resolvePermissionContext(request);
  if (!context.authenticated || !context.principalId) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const canApprove = hasPermission(context.permissions, "expenses.approve");
  const canReadFinancials = hasPermission(
    context.permissions,
    "financials.read",
  );
  const canWriteAdSpend = hasPermission(context.permissions, "ad_spend.write");
  const receiptCapture = canUseExpenseReceiptCapture(canApprove);

  return NextResponse.json(
    {
      ok: true,
      capabilities: {
        manualEntry: true,
        receiptCapture,
        reimbursement: isExpenseReimbursementEnabled(),
        dailyAdSpend: canWriteAdSpend && isExpenseAdSpendEnabled(),
        overview: canReadFinancials && isExpenseOverviewEnabled(),
        exactDuplicateReview: canApprove && receiptCapture,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
