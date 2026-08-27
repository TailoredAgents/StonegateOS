import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { expenses, getDb } from "@/db";
import { expenseReceiptCaptureErrorResponse } from "@/lib/expense-receipt-capture-route";
import { getExpenseReceiptCaptureContentUrl } from "@/lib/expense-receipt-captures";
import { deterministicLegacyReceiptCaptureId } from "@/lib/expense-receipt-legacy-id";
import {
  permissionMatches,
  requirePermission,
  resolvePermissionContext,
} from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ expenseId: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, [
    "expenses.submit",
    "expenses.approve",
    "expenses.read",
  ]);
  if (permissionError) return permissionError;
  const permissionContext = await resolvePermissionContext(request);
  if (!permissionContext.authenticated || !permissionContext.principalId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const canReadAll = permissionContext.permissions.some(
    (permission) =>
      permissionMatches(permission, "expenses.approve") ||
      permissionMatches(permission, "expenses.read"),
  );

  const { expenseId } = await context.params;
  if (!expenseId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select({
      receiptUrl: expenses.receiptUrl,
      receiptFilename: expenses.receiptFilename,
      receiptContentType: expenses.receiptContentType,
      receiptCaptureId: expenses.receiptCaptureId,
      submittedBy: expenses.submittedBy,
    })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!canReadAll && row.submittedBy !== permissionContext.principalId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const captureIds = new Set<string>();
  if (row.receiptCaptureId) captureIds.add(row.receiptCaptureId);
  if (row.receiptUrl) {
    // Posted historical ledger evidence is immutable. The verified backfill
    // therefore uses a deterministic capture identity that can be read without
    // rewriting the posted expense row.
    captureIds.add(deterministicLegacyReceiptCaptureId(expenseId));
  }
  for (const captureId of captureIds) {
    try {
      const contentUrl = await getExpenseReceiptCaptureContentUrl({
        captureId,
        viewerId: permissionContext.principalId,
        canReviewAll: canReadAll,
        variant: "original",
      });
      return NextResponse.redirect(contentUrl, {
        status: 307,
        headers: {
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      if (!row.receiptUrl) return expenseReceiptCaptureErrorResponse(error);
      // A migrated record retains its verified legacy fallback until the
      // separate cleanup phase has re-read and hashed the private object.
    }
  }
  if (!row.receiptUrl) {
    return NextResponse.json({ error: "no_receipt" }, { status: 404 });
  }

  return NextResponse.json(
    {
      ok: true,
      filename: row.receiptFilename ?? "receipt",
      contentType: row.receiptContentType ?? "application/octet-stream",
      dataUrl: row.receiptUrl,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
