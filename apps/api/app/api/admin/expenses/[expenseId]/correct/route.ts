import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { expenses, getDb } from "@/db";
import {
  assertExpenseActionAllowed,
  assertExpenseFinancialShape,
  expenseIdempotencyPayload,
  parseExpenseRequest,
} from "@/lib/expense-lifecycle";
import { createManagedExpenseCorrection } from "@/lib/expense-managed-lifecycle";
import { assertGenericExpenseMutationAllowed } from "@/lib/expense-managed-mutation";
import { permissionMatches, resolvePermissionContext } from "@/lib/permissions";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
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
    auditAction: "expense.corrected",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { expenseId: rawExpenseId } = await context.params;
  const expenseId = rawExpenseId?.trim() ?? "";
  if (!UUID_PATTERN.test(expenseId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid expense ID is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { expenseId: "Select a valid posted expense." },
      },
    );
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest expense version is required before correction.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the expense and try again." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const parsed = await parseExpenseRequest(request, {
      requireReason: true,
      allowReceipt: false,
      allowFixedCostCoverage: true,
    });
    const permissionContext = await resolvePermissionContext(request);
    const canManageFixedCostCoverage = permissionContext.permissions.some(
      (permission) => permissionMatches(permission, "financials.read"),
    );
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/expenses/:expenseId/correct",
      entityType: "expense",
      entityId: expenseId,
      payload: expenseIdempotencyPayload(parsed),
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(expenses)
        .where(eq(expenses.id, expenseId))
        .for("update")
        .limit(1);
      if (!existing) {
        throw new TeamMutationFailure("invalid", "The expense was not found.", {
          status: 404,
        });
      }
      assertTeamMutationExpectedVersion(mutation, existing.version);
      assertExpenseActionAllowed(existing, "correct");
      assertExpenseFinancialShape(existing);
      await assertGenericExpenseMutationAllowed(tx, existing, "correct");
      const actorId = mutation.actor.id;
      if (!actorId) {
        throw new TeamMutationFailure(
          "internal",
          "The verified expense actor is incomplete.",
        );
      }
      const correctionReason = parsed.reason;
      if (!correctionReason) {
        throw new TeamMutationFailure(
          "internal",
          "The validated correction reason is unavailable.",
        );
      }

      const now = new Date();
      const managed = await createManagedExpenseCorrection(tx, {
        existing,
        replacement: parsed.expense,
        actorId,
        reason: correctionReason,
        now,
        coveredByFixedCostSeriesId: parsed.coveredByFixedCostSeriesId,
        canManageFixedCostCoverage,
      });

      const nextVersion = existing.version + 1;
      const [corrected] = await tx
        .update(expenses)
        .set({
          lifecycleStatus: "corrected",
          correctedAt: now,
          correctedBy: actorId,
          correctionReason,
          correctedByExpenseId: managed.replacement.id,
          version: nextVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(expenses.id, expenseId),
            eq(expenses.version, existing.version),
            eq(expenses.lifecycleStatus, "posted"),
          ),
        )
        .returning({ id: expenses.id });
      if (!corrected?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The expense changed while it was being corrected. No correction was saved.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "expense",
        entityId: expenseId,
        before: {
          amountCents: existing.amount,
          category: existing.category,
          paidAt: existing.paidAt.toISOString(),
          lifecycleStatus: existing.lifecycleStatus,
          version: existing.version,
          coveredByFixedCostSeriesId: existing.coveredByFixedCostSeriesId,
        },
        after: {
          lifecycleStatus: "corrected",
          version: nextVersion,
          reversalExpenseId: managed.reversal.id,
          replacementExpenseId: managed.replacement.id,
          replacementAmountCents: parsed.expense.amountCents,
          replacementCategory: parsed.expense.category,
          replacementPaidAt: parsed.expense.paidAt.toISOString(),
          coveredByFixedCostSeriesId:
            managed.replacement.coveredByFixedCostSeriesId,
        },
        metadata: {
          reasonLength: correctionReason.length,
          originalReceiptPreserved: Boolean(
            existing.receiptUrl || existing.receiptCaptureId,
          ),
          ledgerMethod: "linked_reversal_and_replacement",
          allocationStrategy: managed.allocationStrategy,
          reimbursementClaimId: managed.reimbursementClaimId,
          reimbursementStatus: managed.reimbursementStatus,
          coveredByFixedCostSeriesId:
            managed.replacement.coveredByFixedCostSeriesId,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          expenseId,
          lifecycleStatus: "corrected" as const,
          version: nextVersion,
          reversalExpenseId: managed.reversal.id,
          replacementExpenseId: managed.replacement.id,
          receiptPreservedOnExpenseId:
            existing.receiptUrl || existing.receiptCaptureId ? expenseId : null,
          reimbursementClaimId: managed.reimbursementClaimId,
          reimbursementStatus: managed.reimbursementStatus,
          coveredByFixedCostSeriesId:
            managed.replacement.coveredByFixedCostSeriesId,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "expense",
          entityId: expenseId,
          version: String(nextVersion),
        },
      );
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
