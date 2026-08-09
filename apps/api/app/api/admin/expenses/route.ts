import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, sql } from "drizzle-orm";
import { expenses, getDb } from "@/db";
import {
  buildExpenseWhere,
  encodeExpenseCursor,
  parseExpenseQuery,
} from "@/lib/expense-query";
import {
  expenseIdempotencyPayload,
  parseExpenseRequest,
} from "@/lib/expense-lifecycle";
import { requirePermission } from "@/lib/permissions";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { isAdminRequest } from "../../web/admin";

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
  const permissionError = await requirePermission(request, "expenses.read");
  if (permissionError) return permissionError;

  const parsed = parseExpenseQuery(request.nextUrl.searchParams);
  if (!parsed.ok) return invalidFilter(parsed.field, parsed.message);
  const { query } = parsed;
  const filters = buildExpenseWhere(query);

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
        receiptFilename: expenses.receiptFilename,
        receiptContentType: expenses.receiptContentType,
        hasReceipt: sql<boolean>`${expenses.receiptUrl} IS NOT NULL`.as(
          "has_receipt",
        ),
        bankTransactionId: expenses.bankTransactionId,
        payoutRunId: expenses.payoutRunId,
        lifecycleStatus: expenses.lifecycleStatus,
        version: expenses.version,
        postedAt: expenses.postedAt,
        voidedAt: expenses.voidedAt,
        voidReason: expenses.voidReason,
        correctedAt: expenses.correctedAt,
        correctionReason: expenses.correctionReason,
        reversalOfExpenseId: expenses.reversalOfExpenseId,
        correctionOfExpenseId: expenses.correctionOfExpenseId,
        correctedByExpenseId: expenses.correctedByExpenseId,
        createdAt: expenses.createdAt,
        updatedAt: expenses.updatedAt,
      })
      .from(expenses)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(
        ...(query.direction === "previous"
          ? [asc(expenses.paidAt), asc(expenses.createdAt), asc(expenses.id)]
          : [
              desc(expenses.paidAt),
              desc(expenses.createdAt),
              desc(expenses.id),
            ]),
      )
      .limit(query.limit + 1);
    const hasExtraInRequestedDirection = rows.length > query.limit;
    const selectedRows = hasExtraInRequestedDirection
      ? rows.slice(0, query.limit)
      : rows;
    const pageRows =
      query.direction === "previous" ? selectedRows.reverse() : selectedRows;
    const hasPrevious =
      query.direction === "previous"
        ? hasExtraInRequestedDirection
        : Boolean(query.cursor);
    const hasMore =
      query.direction === "previous"
        ? Boolean(query.cursor)
        : hasExtraInRequestedDirection;
    const firstRow = pageRows[0] ?? null;
    const lastRow = pageRows.at(-1) ?? null;
    const fallbackCursor = query.cursor
      ? encodeExpenseCursor(query.cursor)
      : null;

    return NextResponse.json(
      {
        ok: true,
        expenses: pageRows.map((row) => ({
          id: row.id,
          amountCents: row.amountCents,
          currency: row.currency,
          category: row.category,
          vendor: row.vendor,
          memo: row.memo,
          method: row.method,
          source: row.source,
          paidAt: row.paidAt.toISOString(),
          coverageStartAt: row.coverageStartAt?.toISOString() ?? null,
          coverageEndAt: row.coverageEndAt?.toISOString() ?? null,
          lifecycleStatus: row.lifecycleStatus,
          version: row.version,
          postedAt: row.postedAt?.toISOString() ?? null,
          voidedAt: row.voidedAt?.toISOString() ?? null,
          voidReason: row.voidReason,
          correctedAt: row.correctedAt?.toISOString() ?? null,
          correctionReason: row.correctionReason,
          reversalOfExpenseId: row.reversalOfExpenseId,
          correctionOfExpenseId: row.correctionOfExpenseId,
          correctedByExpenseId: row.correctedByExpenseId,
          externallyManaged: Boolean(
            row.bankTransactionId ||
              row.payoutRunId ||
              (row.source !== "manual" && row.source !== "manual_correction"),
          ),
          requiresFinanceReview:
            row.amountCents <= 0 ||
            row.currency !== "USD" ||
            Boolean(
              row.coverageStartAt &&
                row.coverageEndAt &&
                row.coverageEndAt.getTime() < row.coverageStartAt.getTime(),
            ),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          receipt: row.hasReceipt
            ? {
                filename: row.receiptFilename ?? "receipt",
                contentType:
                  row.receiptContentType ?? "application/octet-stream",
              }
            : null,
        })),
        page: {
          limit: query.limit,
          hasMore,
          hasPrevious,
          previousCursor:
            hasPrevious && firstRow
              ? encodeExpenseCursor({
                  paidAt: firstRow.paidAt,
                  createdAt: firstRow.createdAt,
                  id: firstRow.id,
                })
              : hasPrevious
                ? fallbackCursor
                : null,
          nextCursor:
            hasMore && lastRow
              ? encodeExpenseCursor({
                  paidAt: lastRow.paidAt,
                  createdAt: lastRow.createdAt,
                  id: lastRow.id,
                })
              : hasMore
                ? fallbackCursor
                : null,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[expenses] ledger_read_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error: "expense_list_failed",
        message: "The expense ledger could not be loaded. Try again.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["expenses.write"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.draft_created",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const parsed = await parseExpenseRequest(request);
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/expenses",
      entityType: "expense",
      entityId: "new",
      payload: expenseIdempotencyPayload(parsed),
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const [row] = await tx
        .insert(expenses)
        .values({
          amount: parsed.expense.amountCents,
          currency: "USD",
          category: parsed.expense.category,
          vendor: parsed.expense.vendor,
          memo: parsed.expense.memo,
          method: parsed.expense.method,
          source: "manual",
          paidAt: parsed.expense.paidAt,
          coverageStartAt: parsed.expense.coverageStartAt,
          coverageEndAt: parsed.expense.coverageEndAt,
          receiptFilename: parsed.receipt?.filename ?? null,
          receiptUrl: parsed.receipt?.dataUrl ?? null,
          receiptContentType: parsed.receipt?.contentType ?? null,
          lifecycleStatus: "draft",
          version: 1,
          postedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: expenses.id });
      if (!row?.id) {
        throw new TeamMutationFailure(
          "internal",
          "The expense draft could not be created.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "expense",
        entityId: row.id,
        after: {
          amountCents: parsed.expense.amountCents,
          currency: "USD",
          category: parsed.expense.category,
          paidAt: parsed.expense.paidAt.toISOString(),
          lifecycleStatus: "draft",
          version: 1,
        },
        metadata: {
          receiptAttached: Boolean(parsed.receipt),
          receiptSha256: parsed.receipt?.sha256 ?? null,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          expenseId: row.id,
          lifecycleStatus: "draft" as const,
          version: 1,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "expense",
          entityId: row.id,
          version: "1",
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        201,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 201, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[expenses] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
