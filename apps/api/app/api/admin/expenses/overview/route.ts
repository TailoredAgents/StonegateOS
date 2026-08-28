import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  buildExpenseOverview,
  getExpenseOverviewWeekBoundary,
} from "@/lib/expense-overview";
import { loadExpenseOverviewInput } from "@/lib/expense-overview-repository";
import { isExpenseOverviewEnabled } from "@/lib/expense-feature-flags";
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

function invalidWeekStart(message: string): NextResponse {
  return NextResponse.json(
    {
      error: "invalid_week_start",
      field: "weekStart",
      message,
    },
    { status: 422, headers: NO_STORE_HEADERS },
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }
  const permissionError = await requirePermission(request, "financials.read");
  if (permissionError) return noStore(permissionError);
  if (!isExpenseOverviewEnabled()) {
    return NextResponse.json(
      { error: "expense_overview_disabled", retryable: false },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const weekStart = request.nextUrl.searchParams.get("weekStart")?.trim() ?? "";
  if (!weekStart) {
    return invalidWeekStart(
      "Choose the Monday for the expense week using YYYY-MM-DD.",
    );
  }
  try {
    getExpenseOverviewWeekBoundary(weekStart);
  } catch (error) {
    return invalidWeekStart(
      error instanceof Error
        ? error.message
        : "Choose a valid Eastern Monday using YYYY-MM-DD.",
    );
  }

  try {
    const input = await loadExpenseOverviewInput(getDb(), weekStart, {
      asOf: new Date(),
    });
    const overview = buildExpenseOverview(input);
    return NextResponse.json(
      {
        ok: true,
        currency: "USD",
        reportingBasis: {
          timezone: "America/New_York",
          week: "Monday through Sunday",
          revenue: "Final totals for jobs grouped by completion time.",
          expenses: "Posted ledger expenses grouped by purchase date.",
          fixedCosts:
            "Owner-verified monthly costs accrued exactly across Eastern calendar days; no synthetic ledger rows.",
          labor:
            overview.labor.state === "actual"
              ? "Finalized payout snapshot."
              : "Persisted appointment commissions accrued when work was completed.",
          advertising:
            "Manual daily entries only; provider analytics are excluded.",
        },
        ...overview,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[expenses-overview] read_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error: "expense_overview_failed",
        message: "The weekly expense overview could not be loaded. Try again.",
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
