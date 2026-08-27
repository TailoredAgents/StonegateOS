import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  ExpenseOperationsMonitorInputError,
  parseExpenseOperationsMonitorQuery,
  readExpenseOperationsMonitor,
} from "@/lib/expense-operations-monitor";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
  response.headers.set("Pragma", NO_STORE_HEADERS.Pragma);
  return response;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const permissionError = await requirePermission(
    request,
    ["financials.read", "expenses.approve"],
    { mode: "all" },
  );
  if (permissionError) return noStore(permissionError);

  let query;
  try {
    query = parseExpenseOperationsMonitorQuery(request.nextUrl.searchParams);
  } catch (error) {
    if (error instanceof ExpenseOperationsMonitorInputError) {
      return NextResponse.json(
        {
          error: "invalid_expense_operations_query",
          field: error.field,
          message: error.message,
        },
        { status: 422, headers: NO_STORE_HEADERS },
      );
    }
    throw error;
  }

  try {
    const monitor = await readExpenseOperationsMonitor(getDb(), query);
    return NextResponse.json(
      { ok: true, monitor },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[expense.operations] read_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error: "expense_operations_unavailable",
        message: "Expense operations metrics could not be loaded. Try again.",
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
