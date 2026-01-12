import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { expenses, getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ expenseId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "expenses.read");
  if (permissionError) return permissionError;

  const { expenseId } = await context.params;
  if (!expenseId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select({
      receiptUrl: expenses.receiptUrl,
      receiptFilename: expenses.receiptFilename,
      receiptContentType: expenses.receiptContentType
    })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!row.receiptUrl) {
    return NextResponse.json({ error: "no_receipt" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    filename: row.receiptFilename ?? "receipt",
    contentType: row.receiptContentType ?? "application/octet-stream",
    dataUrl: row.receiptUrl
  });
}

