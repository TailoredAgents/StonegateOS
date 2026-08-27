import type { NextRequest } from "next/server";
import {
  ExpenseReviewDecisionSchema,
  reviewExpenseSubmissionInTransaction,
} from "@/lib/expense-submissions";
import { getDb } from "@/db";
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
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ expenseId?: string }> };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["expenses.approve"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.submission.reviewed",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const { expenseId: rawExpenseId } = await context.params;
  const expenseId = rawExpenseId?.trim() ?? "";
  if (!UUID_PATTERN.test(expenseId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid expense ID is required.",
      { correlationId: mutation.correlationId },
    );
  }
  const expectedVersion = mutation.expectedVersion;
  if (!expectedVersion || !/^\d+$/u.test(expectedVersion)) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest expense version is required before review.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the expense and try again." },
      },
    );
  }
  const version = Number(expectedVersion);
  if (!Number.isSafeInteger(version) || version < 1) {
    return teamMutationErrorResponse(
      "invalid",
      "The expense version is invalid.",
      { correlationId: mutation.correlationId },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const parsed = ExpenseReviewDecisionSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose approve or reject and include a rejection reason.",
        {
          fieldErrors: {
            reason:
              parsed.error.flatten().fieldErrors.reason?.[0] ??
              "Review the decision details.",
          },
        },
      );
    }
    const actorId = mutation.actor.id;
    if (!actorId) {
      throw new TeamMutationFailure(
        "internal",
        "The verified expense reviewer is incomplete.",
      );
    }
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/expenses/submissions/:expenseId/review",
      entityType: "expense",
      entityId: expenseId,
      payload: { ...parsed.data, expectedVersion: version },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const reviewed = await reviewExpenseSubmissionInTransaction(tx, {
        expenseId,
        reviewerId: actorId,
        expectedVersion: version,
        decision: parsed.data,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "expense",
        entityId: expenseId,
        before: {
          lifecycleStatus: "draft",
          reviewStatus: "pending",
          version,
        },
        after: {
          lifecycleStatus: reviewed.lifecycleStatus,
          reviewStatus: reviewed.reviewStatus,
          categoryId: reviewed.categoryId,
          category: reviewed.category,
          version: reviewed.version,
        },
        metadata: {
          reasonLength: parsed.data.reason?.length ?? 0,
          categoryCorrected: parsed.data.categoryId !== undefined,
          allocationCount: parsed.data.allocations?.length ?? 0,
          vendorRuleLocked: parsed.data.lockVendorRule,
          reimbursementClaimId: reviewed.reimbursementClaimId,
          reimbursementStatus: reviewed.reimbursementStatus,
        },
      });
      const mutationResult = teamMutationSuccessResult(mutation, reviewed, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "expense",
        entityId: expenseId,
        version: String(reviewed.version),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[expenses] review_idempotency_settlement_failed", {
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
