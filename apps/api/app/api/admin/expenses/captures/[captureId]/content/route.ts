import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  expenseReceiptCaptureErrorResponse,
  permissionListIncludes,
  requireExpenseCaptureActorId,
} from "@/lib/expense-receipt-capture-route";
import { getExpenseReceiptCaptureContentUrl } from "@/lib/expense-receipt-captures";
import { requirePermission, resolvePermissionContext } from "@/lib/permissions";

const VariantSchema = z.enum(["original", "normalized"]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ captureId: string }> },
): Promise<Response> {
  const permissionError = await requirePermission(request, [
    "expenses.submit",
    "expenses.approve",
  ]);
  if (permissionError) return permissionError;

  const variant = VariantSchema.safeParse(
    request.nextUrl.searchParams.get("variant") ?? "original",
  );
  if (!variant.success) {
    return NextResponse.json(
      { error: "invalid_variant" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { captureId } = await context.params;
  const actor = getAuditActorFromRequest(request);
  try {
    const viewerId = requireExpenseCaptureActorId(actor.id);
    const permissionContext = await resolvePermissionContext(request);
    const url = await getExpenseReceiptCaptureContentUrl({
      captureId,
      viewerId,
      canReviewAll: permissionListIncludes(
        permissionContext.permissions,
        "expenses.approve",
      ),
      variant: variant.data,
    });
    await recordAuditEvent({
      actor,
      action: "expense.receipt.viewed",
      entityType: "expense_receipt_capture",
      entityId: captureId,
      requiredPermissions: ["expenses.submit"],
      surface: "mobile_spend",
      meta: { variant: variant.data },
    });
    return NextResponse.redirect(url, {
      status: 307,
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return expenseReceiptCaptureErrorResponse(error);
  }
}
