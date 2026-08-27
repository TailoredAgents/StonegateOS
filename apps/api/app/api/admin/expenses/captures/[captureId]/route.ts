import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  expenseReceiptCaptureErrorResponse,
  permissionListIncludes,
  requireExpenseCaptureActorId,
} from "@/lib/expense-receipt-capture-route";
import {
  discardExpenseReceiptCapture,
  getExpenseReceiptCaptureStatus,
} from "@/lib/expense-receipt-captures";
import { requirePermission, resolvePermissionContext } from "@/lib/permissions";

async function captureViewer(request: NextRequest): Promise<{
  actorId: string;
  canReviewAll: boolean;
}> {
  const actor = getAuditActorFromRequest(request);
  const permissionContext = await resolvePermissionContext(request);
  return {
    actorId: requireExpenseCaptureActorId(actor.id),
    canReviewAll: permissionListIncludes(
      permissionContext.permissions,
      "expenses.approve",
    ),
  };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ captureId: string }> },
): Promise<Response> {
  const permissionError = await requirePermission(request, [
    "expenses.submit",
    "expenses.approve",
  ]);
  if (permissionError) return permissionError;

  const { captureId } = await context.params;
  try {
    const viewer = await captureViewer(request);
    const capture = await getExpenseReceiptCaptureStatus({
      captureId,
      viewerId: viewer.actorId,
      canReviewAll: viewer.canReviewAll,
    });
    return NextResponse.json(
      { ok: true, capture },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return expenseReceiptCaptureErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ captureId: string }> },
): Promise<Response> {
  const permissionError = await requirePermission(request, [
    "expenses.submit",
    "expenses.approve",
  ]);
  if (permissionError) return permissionError;

  const { captureId } = await context.params;
  const actor = getAuditActorFromRequest(request);
  try {
    const viewer = await captureViewer(request);
    const capture = await discardExpenseReceiptCapture({
      captureId,
      viewerId: viewer.actorId,
      canReviewAll: viewer.canReviewAll,
    });
    await recordAuditEvent({
      actor,
      action: "expense.receipt.discarded",
      entityType: "expense_receipt_capture",
      entityId: capture.id,
      requiredPermissions: ["expenses.submit"],
      surface: "mobile_spend",
      meta: { status: capture.status, originalEvidenceRetained: true },
    });
    return NextResponse.json(
      { ok: true, capture },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return expenseReceiptCaptureErrorResponse(error);
  }
}
