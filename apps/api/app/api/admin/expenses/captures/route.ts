import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  createExpenseReceiptUploadIntent,
  listExactDuplicateExpenseReceiptCaptures,
  parseExactDuplicateCaptureReviewQuery,
} from "@/lib/expense-receipt-captures";
import {
  expenseReceiptCaptureErrorResponse,
  requireExpenseCaptureActorId,
} from "@/lib/expense-receipt-capture-route";
import { ExpenseReceiptUploadIntentSchema } from "@/lib/expense-receipt-storage";
import { requirePermission } from "@/lib/permissions";

/** Owner-only queue for employee captures blocked by an exact hash match. */
export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, "expenses.approve");
  if (permissionError) return permissionError;

  const actor = getAuditActorFromRequest(request);
  try {
    const query = parseExactDuplicateCaptureReviewQuery(
      request.nextUrl.searchParams,
    );
    const result = await listExactDuplicateExpenseReceiptCaptures(query);
    await recordAuditEvent({
      actor,
      action: "expense.receipt.exact_duplicate_queue_viewed",
      entityType: "expense_receipt_capture",
      entityId: null,
      requiredPermissions: ["expenses.approve"],
      surface: "mobile_spend",
      meta: {
        resultCount: result.captures.length,
        hasMore: result.page.hasMore,
      },
    });
    return NextResponse.json(
      { ok: true, reviewType: "exact_duplicates", ...result },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return expenseReceiptCaptureErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, "expenses.submit");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = ExpenseReceiptUploadIntentSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const actor = getAuditActorFromRequest(request);
  try {
    const submittedBy = requireExpenseCaptureActorId(actor.id);
    const intent = await createExpenseReceiptUploadIntent({
      submittedBy,
      upload: parsed.data,
    });
    await recordAuditEvent({
      actor,
      action: "expense.receipt.upload_intent_created",
      entityType: "expense_receipt_capture",
      entityId: intent.capture.id,
      requiredPermissions: ["expenses.submit"],
      surface: "mobile_spend",
      meta: {
        byteLength: intent.capture.byteLength,
        contentType: intent.capture.contentType,
        alreadyExists: intent.alreadyExists,
        evidenceStoredPrivately: true,
      },
    });
    return NextResponse.json(
      { ok: true, ...intent },
      {
        status: intent.alreadyExists ? 200 : 201,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return expenseReceiptCaptureErrorResponse(error);
  }
}
