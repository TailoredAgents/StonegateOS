import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  expenseAllocations,
  expenseCategories,
  expenseReceiptCaptures,
  expenseReimbursementClaims,
  expenses,
  getDb,
  teamMembers,
} from "@/db";
import {
  createExpenseSubmissionInTransaction,
  parseExpenseSubmission,
} from "@/lib/expense-submissions";
import {
  permissionMatches,
  requirePermission,
  resolvePermissionContext,
} from "@/lib/permissions";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const HISTORY_FILTERS = new Set([
  "all",
  "pending",
  "approved",
  "rejected",
  "reimbursement",
]);

function hasPermission(permissions: string[], required: string): boolean {
  return permissions.some((permission) =>
    permissionMatches(permission, required),
  );
}

function expenseAccess(permissions: string[]): {
  canSubmit: boolean;
  canApprove: boolean;
} {
  return {
    canSubmit: hasPermission(permissions, "expenses.submit"),
    canApprove: hasPermission(permissions, "expenses.approve"),
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, [
    "expenses.submit",
    "expenses.approve",
  ]);
  if (permissionError) return permissionError;
  const context = await resolvePermissionContext(request);
  if (!context.authenticated || !context.principalId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const access = expenseAccess(context.permissions);
  if (!access.canSubmit && !access.canApprove) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const requestedFilter =
    request.nextUrl.searchParams.get("filter")?.trim().toLowerCase() ?? "all";
  if (!HISTORY_FILTERS.has(requestedFilter)) {
    return NextResponse.json(
      {
        error: "invalid_filter",
        field: "filter",
        message: "Choose a valid expense history filter.",
      },
      { status: 422 },
    );
  }

  const conditions = [
    ne(expenses.source, "payout_run"),
    ne(expenses.source, "payout_reimbursement"),
  ];
  if (!access.canApprove) {
    conditions.push(eq(expenses.submittedBy, context.principalId));
  }
  if (
    requestedFilter === "pending" ||
    requestedFilter === "approved" ||
    requestedFilter === "rejected"
  ) {
    conditions.push(eq(expenses.reviewStatus, requestedFilter));
  }
  if (requestedFilter === "reimbursement") {
    conditions.push(eq(expenses.payerType, "personal"));
  }

  const rows = await getDb()
    .select({
      id: expenses.id,
      amountCents: expenses.amount,
      currency: expenses.currency,
      categoryId: expenses.categoryId,
      category: expenses.category,
      categoryNeedsReview: expenses.categoryNeedsReview,
      vendor: expenses.vendor,
      notes: expenses.memo,
      method: expenses.method,
      source: expenses.source,
      purchaseDate:
        sql<string>`to_char(${expenses.paidAt} AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')`.as(
          "purchase_date",
        ),
      payerType: expenses.payerType,
      paidByMemberId: expenses.paidByMemberId,
      submittedBy: expenses.submittedBy,
      reviewStatus: expenses.reviewStatus,
      reviewedBy: expenses.reviewedBy,
      reviewedAt: expenses.reviewedAt,
      reviewReason: expenses.reviewReason,
      lifecycleStatus: expenses.lifecycleStatus,
      version: expenses.version,
      appointmentId: expenses.appointmentId,
      receiptCaptureId: expenses.receiptCaptureId,
      receiptCaptureStatus: expenseReceiptCaptures.status,
      legacyReceiptFilename: expenses.receiptFilename,
      hasLegacyReceipt: sql<boolean>`${expenses.receiptUrl} IS NOT NULL`.as(
        "has_legacy_receipt",
      ),
      reimbursementClaimId: expenseReimbursementClaims.id,
      reimbursementStatus: expenseReimbursementClaims.status,
      createdAt: expenses.createdAt,
      updatedAt: expenses.updatedAt,
    })
    .from(expenses)
    .leftJoin(
      expenseReceiptCaptures,
      eq(expenses.receiptCaptureId, expenseReceiptCaptures.id),
    )
    .leftJoin(
      expenseReimbursementClaims,
      eq(expenseReimbursementClaims.expenseId, expenses.id),
    )
    .where(and(...conditions))
    .orderBy(
      ...(access.canApprove
        ? [
            sql`case when ${expenses.reviewStatus} = 'pending' then 0 else 1 end`,
          ]
        : []),
      desc(expenses.paidAt),
      desc(expenses.createdAt),
    )
    .limit(100);

  const memberIds = Array.from(
    new Set(
      rows.flatMap((row) =>
        [row.submittedBy, row.paidByMemberId, row.reviewedBy].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ),
  );
  const memberRows =
    memberIds.length > 0
      ? await getDb()
          .select({ id: teamMembers.id, name: teamMembers.name })
          .from(teamMembers)
          .where(inArray(teamMembers.id, memberIds))
      : [];
  const memberNames = new Map(memberRows.map((row) => [row.id, row.name]));

  const expenseIds = rows.map((row) => row.id);
  const allocationRows =
    expenseIds.length > 0
      ? await getDb()
          .select({
            expenseId: expenseAllocations.expenseId,
            categoryId: expenseAllocations.categoryId,
            category: expenseCategories.name,
            amountCents: expenseAllocations.amountCents,
          })
          .from(expenseAllocations)
          .innerJoin(
            expenseCategories,
            eq(expenseAllocations.categoryId, expenseCategories.id),
          )
          .where(inArray(expenseAllocations.expenseId, expenseIds))
      : [];
  const allocationsByExpense = new Map<
    string,
    Array<{ categoryId: string; category: string; amountCents: number }>
  >();
  for (const allocation of allocationRows) {
    const list = allocationsByExpense.get(allocation.expenseId) ?? [];
    list.push({
      categoryId: allocation.categoryId,
      category: allocation.category,
      amountCents: allocation.amountCents,
    });
    allocationsByExpense.set(allocation.expenseId, list);
  }

  return NextResponse.json(
    {
      ok: true,
      access,
      expenses: rows.map((row) => ({
        id: row.id,
        amountCents: row.amountCents,
        currency: row.currency,
        categoryId: row.categoryId,
        category: row.category ?? "Uncategorized",
        categoryNeedsReview: row.categoryNeedsReview,
        allocations: allocationsByExpense.get(row.id) ?? [],
        vendor: row.vendor,
        notes: row.notes,
        method: row.method,
        source: row.source,
        purchaseDate: row.purchaseDate,
        payerType: row.payerType,
        paidByMember: row.paidByMemberId
          ? {
              id: row.paidByMemberId,
              name: memberNames.get(row.paidByMemberId) ?? "Former team member",
            }
          : null,
        submitter: row.submittedBy
          ? {
              id: row.submittedBy,
              name: memberNames.get(row.submittedBy) ?? "Former team member",
            }
          : null,
        reviewStatus: row.reviewStatus,
        reviewer: row.reviewedBy
          ? {
              id: row.reviewedBy,
              name: memberNames.get(row.reviewedBy) ?? "Former team member",
            }
          : null,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        reviewReason: row.reviewReason,
        lifecycleStatus: row.lifecycleStatus,
        version: row.version,
        appointmentId: row.appointmentId,
        receipt:
          row.receiptCaptureId || row.hasLegacyReceipt
            ? {
                captureId: row.receiptCaptureId,
                status:
                  row.receiptCaptureStatus ??
                  (row.hasLegacyReceipt ? "legacy" : null),
                filename: row.legacyReceiptFilename,
              }
            : null,
        reimbursement: row.reimbursementClaimId
          ? {
              claimId: row.reimbursementClaimId,
              status: row.reimbursementStatus,
            }
          : row.payerType === "personal" && row.reviewStatus === "pending"
            ? { claimId: null, status: "awaiting_approval" }
            : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["expenses.submit"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.submission.created",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const context = await resolvePermissionContext(request);
  if (!context.authenticated || !context.principalId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const access = expenseAccess(context.permissions);

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const body = (await request.json().catch(() => null)) as unknown;
    const submission = parseExpenseSubmission(body);
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/expenses/submissions",
      entityType: "expense",
      entityId: "new",
      payload: submission,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const created = await createExpenseSubmissionInTransaction(tx, {
        submission,
        actorId: context.principalId!,
        canApprove: access.canApprove,
        source: "manual",
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "expense",
        entityId: created.expenseId,
        after: {
          amountCents: submission.amountCents,
          purchaseDate: submission.purchaseDate,
          categoryId: submission.categoryId,
          payerType: submission.payerType,
          lifecycleStatus: created.lifecycleStatus,
          reviewStatus: created.reviewStatus,
          version: created.version,
        },
        metadata: {
          allocationCount: submission.allocations?.length ?? 0,
          reimbursementClaimId: created.reimbursementClaimId,
          reimbursementStatus: created.reimbursementStatus,
          source: "manual",
        },
      });
      const mutationResult = teamMutationSuccessResult(mutation, created, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "expense",
        entityId: created.expenseId,
        version: String(created.version),
      });
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
        console.error("[expenses] submission_idempotency_settlement_failed", {
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
