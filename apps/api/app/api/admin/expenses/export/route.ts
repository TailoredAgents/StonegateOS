import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  expenseDumpDetails,
  expenseFixedCostVersions,
  expenses,
  getDb,
} from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { expenseCsvRow } from "@/lib/expense-export";
import {
  buildExpenseWhere,
  expenseFilterEvidence,
  parseExpenseQuery,
} from "@/lib/expense-query";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

export const dynamic = "force-dynamic";

export const MAX_EXPENSE_EXPORT_ROWS = 5_000;

function invalidFilter(field: string, message: string): NextResponse {
  return NextResponse.json(
    { error: "invalid_filter", field, message },
    { status: 422, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "expenses.export", {
    disallowedRoles: ["crew"],
  });
  if (permissionError) return permissionError;

  const parsed = parseExpenseQuery(request.nextUrl.searchParams, {
    allowCursor: false,
    allowLimit: false,
    defaultLimit: MAX_EXPENSE_EXPORT_ROWS,
    maxLimit: MAX_EXPENSE_EXPORT_ROWS,
  });
  if (!parsed.ok) return invalidFilter(parsed.field, parsed.message);

  const query = parsed.query;
  const filters = buildExpenseWhere(query);
  const requestedCorrelationId = request.headers.get("x-request-id")?.trim();
  const correlationId =
    requestedCorrelationId &&
    /^[A-Za-z0-9._:-]{1,160}$/u.test(requestedCorrelationId)
      ? requestedCorrelationId
      : crypto.randomUUID();
  const actor = getAuditActorFromRequest(request);
  const filterEvidence = expenseFilterEvidence(query);

  try {
    const rows = await getDb()
      .select({
        id: expenses.id,
        amountCents: expenses.amount,
        currency: expenses.currency,
        category: expenses.category,
        vendor: expenses.vendor,
        memo: expenses.memo,
        method: expenses.method,
        source: expenses.source,
        paidAt: expenses.paidAt,
        coverageStartAt: expenses.coverageStartAt,
        coverageEndAt: expenses.coverageEndAt,
        coveredByFixedCostSeriesId: expenses.coveredByFixedCostSeriesId,
        coveredByFixedCostName: sql<string | null>`(
          SELECT ${expenseFixedCostVersions.name}
          FROM ${expenseFixedCostVersions}
          WHERE ${expenseFixedCostVersions.seriesId} = ${expenses.coveredByFixedCostSeriesId}
            AND ${expenseFixedCostVersions.effectiveStartDate} <= (${expenses.paidAt} AT TIME ZONE 'America/New_York')::date
          ORDER BY ${expenseFixedCostVersions.effectiveStartDate} DESC, ${expenseFixedCostVersions.version} DESC
          LIMIT 1
        )`.as("covered_by_fixed_cost_name"),
        dumpWeightStatus: expenseDumpDetails.weightStatus,
        dumpFacilityName: expenseDumpDetails.facilityName,
        dumpTicketNumber: expenseDumpDetails.ticketNumber,
        dumpMaterial: expenseDumpDetails.material,
        dumpGrossWeightPounds: expenseDumpDetails.grossWeightPounds,
        dumpTareWeightPounds: expenseDumpDetails.tareWeightPounds,
        dumpNetWeightPounds: expenseDumpDetails.netWeightPounds,
        dumpBilledWeightMilliTons: expenseDumpDetails.billedWeightMilliTons,
        dumpUnitRateCentsPerTon: expenseDumpDetails.unitRateCentsPerTon,
        lifecycleStatus: expenses.lifecycleStatus,
        postedAt: expenses.postedAt,
        voidedAt: expenses.voidedAt,
        correctedAt: expenses.correctedAt,
        createdAt: expenses.createdAt,
      })
      .from(expenses)
      .leftJoin(
        expenseDumpDetails,
        eq(expenseDumpDetails.expenseId, expenses.id),
      )
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(
        desc(expenses.paidAt),
        desc(expenses.createdAt),
        desc(expenses.id),
      )
      .limit(MAX_EXPENSE_EXPORT_ROWS + 1);

    if (rows.length > MAX_EXPENSE_EXPORT_ROWS) {
      await recordAuditEvent({
        actor,
        action: "expense.export.failed",
        entityType: "expense",
        correlationId,
        requiredPermissions: ["expenses.export"],
        outcome: "failed",
        surface: "expenses",
        meta: {
          reason: "export_too_large",
          maximumRows: MAX_EXPENSE_EXPORT_ROWS,
          filters: filterEvidence,
        },
      });
      return NextResponse.json(
        {
          error: "export_too_large",
          message: `This export contains more than ${MAX_EXPENSE_EXPORT_ROWS.toLocaleString("en-US")} expenses. Narrow the filters and try again.`,
          maximumRows: MAX_EXPENSE_EXPORT_ROWS,
          truncated: false,
        },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }

    const header = expenseCsvRow([
      "Expense ID",
      "Paid at",
      "Amount",
      "Currency",
      "Category",
      "Vendor",
      "Memo",
      "Method",
      "Source",
      "Lifecycle status",
      "Finance review",
      "Coverage start",
      "Coverage end",
      "Posted at",
      "Voided at",
      "Corrected at",
      "Created at",
      "Fixed-cost series ID",
      "Fixed-cost name",
      "Dump weight status",
      "Dump facility",
      "Scale ticket number",
      "Dump material",
      "Gross weight (lb)",
      "Tare weight (lb)",
      "Net weight (lb)",
      "Billed weight (milli-tons)",
      "Unit rate (cents per ton)",
      "Overview treatment",
    ]);
    const csvRows = rows.map((row) => {
      const needsFinanceReview =
        row.amountCents <= 0 ||
        row.currency !== "USD" ||
        Boolean(
          row.coverageStartAt &&
            row.coverageEndAt &&
            row.coverageEndAt < row.coverageStartAt,
        );
      return expenseCsvRow([
        row.id,
        row.paidAt.toISOString(),
        row.amountCents / 100,
        row.currency,
        row.category,
        row.vendor,
        row.memo,
        row.method,
        row.source,
        row.lifecycleStatus,
        needsFinanceReview ? "required" : "clear",
        row.coverageStartAt?.toISOString(),
        row.coverageEndAt?.toISOString(),
        row.postedAt?.toISOString(),
        row.voidedAt?.toISOString(),
        row.correctedAt?.toISOString(),
        row.createdAt.toISOString(),
        row.coveredByFixedCostSeriesId,
        row.coveredByFixedCostName,
        row.dumpWeightStatus,
        row.dumpFacilityName,
        row.dumpTicketNumber,
        row.dumpMaterial,
        row.dumpGrossWeightPounds,
        row.dumpTareWeightPounds,
        row.dumpNetWeightPounds,
        row.dumpBilledWeightMilliTons,
        row.dumpUnitRateCentsPerTon,
        row.coveredByFixedCostSeriesId
          ? "Excluded from ordinary Overview expenses; fixed-cost accrual counted instead"
          : "Ordinary expense",
      ]);
    });

    // Do not release row data unless the export itself has durable actor and
    // filter evidence. Metadata intentionally excludes expense contents.
    await recordAuditEvent({
      actor,
      action: "expense.exported",
      entityType: "expense",
      correlationId,
      requiredPermissions: ["expenses.export"],
      outcome: "succeeded",
      surface: "expenses",
      meta: {
        format: "csv",
        rowCount: rows.length,
        maximumRows: MAX_EXPENSE_EXPORT_ROWS,
        truncated: false,
        filters: filterEvidence,
      },
    });

    const date = new Date().toISOString().slice(0, 10);
    return new Response(`${[header, ...csvRows].join("\r\n")}\r\n`, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="stonegate-expenses-${date}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Export-Row-Count": String(rows.length),
        "X-Export-Maximum-Rows": String(MAX_EXPENSE_EXPORT_ROWS),
        "X-Export-Truncated": "false",
        "X-Audit-Correlation-Id": correlationId,
      },
    });
  } catch (error) {
    console.error("[expenses] export_failed", {
      correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error: "expense_export_failed",
        message:
          "The expense export could not be prepared or audited. No file was released.",
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
