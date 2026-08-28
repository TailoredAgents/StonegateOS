import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, sql } from "drizzle-orm";
import {
  expenseAllocations,
  expenseFixedCostVersions,
  expenseReceiptCaptures,
  expenses,
  getDb,
} from "@/db";
import { resolveExpenseCategoryAlias } from "@/lib/expense-categories";
import {
  buildExpenseWhere,
  encodeExpenseCursor,
  parseExpenseQuery,
} from "@/lib/expense-query";
import {
  expenseIdempotencyPayload,
  parseExpenseRequest,
} from "@/lib/expense-lifecycle";
import {
  cleanupStagedExpenseReceiptEvidenceIfUncommitted,
  findExactExpenseReceiptDuplicateForPosting,
  stageExpenseReceiptEvidence,
  type StagedExpenseReceiptEvidence,
} from "@/lib/expense-receipt-evidence";
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
  const permissionError = await requirePermission(request, "expenses.read", {
    disallowedRoles: ["crew"],
  });
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
        hasReceipt:
          sql<boolean>`${expenses.receiptUrl} IS NOT NULL OR ${expenses.receiptCaptureId} IS NOT NULL`.as(
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
        coveredByFixedCostSeriesId: expenses.coveredByFixedCostSeriesId,
        coveredByFixedCostName: sql<string | null>`(
          SELECT ${expenseFixedCostVersions.name}
          FROM ${expenseFixedCostVersions}
          WHERE ${expenseFixedCostVersions.seriesId} = ${expenses.coveredByFixedCostSeriesId}
            AND ${expenseFixedCostVersions.effectiveStartDate} <= (${expenses.paidAt} AT TIME ZONE 'America/New_York')::date
          ORDER BY ${expenseFixedCostVersions.effectiveStartDate} DESC, ${expenseFixedCostVersions.version} DESC
          LIMIT 1
        )`.as("covered_by_fixed_cost_name"),
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
          coveredByFixedCostSeriesId: row.coveredByFixedCostSeriesId,
          coveredByFixedCostName: row.coveredByFixedCostName,
          externallyManaged: Boolean(
            row.bankTransactionId ||
              row.payoutRunId ||
              ["daily_ad_spend", "payout_run", "payout_reimbursement"].includes(
                row.source,
              ),
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
    requiredPermissions: ["expenses.approve"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.draft_created",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  let stagedReceipt: StagedExpenseReceiptEvidence | null = null;
  let receiptCommitted = false;
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
    const actorId = mutation.actor.id;
    if (!actorId) {
      throw new TeamMutationFailure(
        "internal",
        "The verified expense actor is incomplete.",
      );
    }
    if (parsed.receipt) {
      stagedReceipt = await stageExpenseReceiptEvidence({
        captureId: claim.id,
        submittedBy: actorId,
        receipt: parsed.receipt,
      });
    }

    const result = await db.transaction(async (tx) => {
      const now = new Date();
      if (stagedReceipt) {
        const duplicateCaptureId =
          await findExactExpenseReceiptDuplicateForPosting(tx, {
            captureId: stagedReceipt.capture.id as string,
            sha256: stagedReceipt.capture.sha256 ?? null,
          });
        if (duplicateCaptureId) {
          throw new TeamMutationFailure(
            "conflict",
            "This receipt already exists. Use Scan receipt so an owner can review a legitimate duplicate.",
          );
        }
        await tx.insert(expenseReceiptCaptures).values(stagedReceipt.capture);
      }
      const category = await resolveExpenseCategoryAlias(
        tx,
        parsed.expense.category,
      );
      const [row] = await tx
        .insert(expenses)
        .values({
          amount: parsed.expense.amountCents,
          currency: "USD",
          category: category.category,
          categoryId: category.categoryId,
          categoryNeedsReview: category.categoryNeedsReview,
          vendor: parsed.expense.vendor,
          memo: parsed.expense.memo,
          method: parsed.expense.method,
          source: "manual",
          submittedBy: actorId,
          payerType: "company",
          paidByMemberId: null,
          reviewStatus: "draft",
          reviewedBy: null,
          reviewedAt: null,
          reviewReason: null,
          receiptCaptureId: stagedReceipt?.capture.id ?? null,
          paidAt: parsed.expense.paidAt,
          coverageStartAt: parsed.expense.coverageStartAt,
          coverageEndAt: parsed.expense.coverageEndAt,
          receiptFilename: parsed.receipt?.filename ?? null,
          receiptUrl: null,
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

      if (category.categoryId) {
        await tx.insert(expenseAllocations).values({
          expenseId: row.id,
          categoryId: category.categoryId,
          amountCents: parsed.expense.amountCents,
          createdAt: now,
        });
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "expense",
        entityId: row.id,
        after: {
          amountCents: parsed.expense.amountCents,
          currency: "USD",
          category: category.category,
          categoryId: category.categoryId,
          categoryNeedsReview: category.categoryNeedsReview,
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
    receiptCommitted = true;

    return teamMutationResultResponse(result, 201, mutation.correlationId);
  } catch (error) {
    if (stagedReceipt && !receiptCommitted && db) {
      await cleanupStagedExpenseReceiptEvidenceIfUncommitted(db, stagedReceipt);
    }
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
