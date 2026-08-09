import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { expenses, getDb } from "@/db";
import {
  assertExpenseActionAllowed,
  assertExpenseFinancialShape,
  parseExpenseReasonRequest,
} from "@/lib/expense-lifecycle";
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
    requiredPermissions: ["expenses.write"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.voided",
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
      "The latest expense version is required before voiding.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the expense and try again." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const reason = await parseExpenseReasonRequest(request);
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/expenses/:expenseId/void",
      entityType: "expense",
      entityId: expenseId,
      payload: { reason },
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
      assertExpenseActionAllowed(existing, "void");
      assertExpenseFinancialShape(existing);
      const actorId = mutation.actor.id;
      if (!actorId) {
        throw new TeamMutationFailure(
          "internal",
          "The verified expense actor is incomplete.",
        );
      }

      const now = new Date();
      const [reversal] = await tx
        .insert(expenses)
        .values({
          amount: -existing.amount,
          currency: existing.currency,
          category: existing.category,
          vendor: existing.vendor,
          memo: existing.memo,
          method: existing.method,
          source: "manual_correction",
          paidAt: existing.paidAt,
          coverageStartAt: existing.coverageStartAt,
          coverageEndAt: existing.coverageEndAt,
          lifecycleStatus: "posted",
          version: 1,
          postedAt: now,
          postedBy: actorId,
          reversalOfExpenseId: expenseId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: expenses.id });
      if (!reversal?.id) {
        throw new TeamMutationFailure(
          "internal",
          "The void reversal could not be created.",
          { retryable: true },
        );
      }

      const nextVersion = existing.version + 1;
      const [voided] = await tx
        .update(expenses)
        .set({
          lifecycleStatus: "voided",
          voidedAt: now,
          voidedBy: actorId,
          voidReason: reason,
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
      if (!voided?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The expense changed while it was being voided. No reversal was saved.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "expense",
        entityId: expenseId,
        before: {
          amountCents: existing.amount,
          lifecycleStatus: existing.lifecycleStatus,
          version: existing.version,
        },
        after: {
          lifecycleStatus: "voided",
          voidedAt: now.toISOString(),
          version: nextVersion,
          reversalExpenseId: reversal.id,
        },
        metadata: {
          reasonLength: reason.length,
          originalReceiptPreserved: Boolean(existing.receiptUrl),
          ledgerMethod: "linked_reversal",
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          expenseId,
          lifecycleStatus: "voided" as const,
          version: nextVersion,
          reversalExpenseId: reversal.id,
          receiptPreservedOnExpenseId: existing.receiptUrl ? expenseId : null,
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
