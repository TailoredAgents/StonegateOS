import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  expenseReceiptCaptureErrorResponse,
  permissionListIncludes,
  requireExpenseCaptureActorId,
} from "@/lib/expense-receipt-capture-route";
import { finalizeExpenseReceiptUpload } from "@/lib/expense-receipt-captures";
import { requirePermission, resolvePermissionContext } from "@/lib/permissions";

const BodySchema = z
  .object({
    checksumSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/iu)
      .optional(),
  })
  .strict()
  .default({});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ captureId: string }> },
): Promise<Response> {
  const permissionError = await requirePermission(request, [
    "expenses.submit",
    "expenses.approve",
  ]);
  if (permissionError) return permissionError;

  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { captureId } = await context.params;
  const actor = getAuditActorFromRequest(request);
  try {
    const viewerId = requireExpenseCaptureActorId(actor.id);
    const permissionContext = await resolvePermissionContext(request);
    const capture = await finalizeExpenseReceiptUpload({
      captureId,
      viewerId,
      canReviewAll: permissionListIncludes(
        permissionContext.permissions,
        "expenses.approve",
      ),
      checksumSha256: parsed.data.checksumSha256,
    });
    await recordAuditEvent({
      actor,
      action: "expense.receipt.upload_finalized",
      entityType: "expense_receipt_capture",
      entityId: capture.id,
      requiredPermissions: ["expenses.submit"],
      surface: "mobile_spend",
      meta: {
        status: capture.status,
        byteLength: capture.byteLength,
        exactDuplicateDetected: Boolean(capture.exactDuplicateOfCaptureId),
        queuedAsynchronously: capture.status === "queued",
        humanConfirmationRequired: true,
      },
    });
    return NextResponse.json(
      { ok: true, capture },
      {
        status: ["queued", "analyzing"].includes(capture.status) ? 202 : 200,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return expenseReceiptCaptureErrorResponse(error);
  }
}
