import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { expenseCategories, getDb } from "@/db";
import {
  permissionMatches,
  requirePermission,
  resolvePermissionContext,
} from "@/lib/permissions";

function canUseExpenseTracking(permissions: string[]): boolean {
  return permissions.some(
    (permission) =>
      permissionMatches(permission, "expenses.submit") ||
      permissionMatches(permission, "expenses.approve"),
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, [
    "expenses.submit",
    "expenses.approve",
  ]);
  if (permissionError) return permissionError;
  const context = await resolvePermissionContext(request);
  if (!context.authenticated) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!canUseExpenseTracking(context.permissions)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const rows = await getDb()
    .select({
      id: expenseCategories.id,
      name: expenseCategories.name,
      sortOrder: expenseCategories.sortOrder,
    })
    .from(expenseCategories)
    .where(eq(expenseCategories.isActive, true))
    .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name));

  return NextResponse.json(
    { ok: true, categories: rows },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
