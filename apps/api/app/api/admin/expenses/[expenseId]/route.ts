import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { expenses, getDb } from "@/db";
import {
  assertExpenseActionAllowed,
  expenseIdempotencyPayload,
  parseExpenseRequest,
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

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["expenses.write"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.draft_updated",
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
        fieldErrors: { expenseId: "Select a valid expense draft." },
      },
    );
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest expense version is required before editing.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the expense and try again." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const parsed = await parseExpenseRequest(request);
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PATCH /api/admin/expenses/:expenseId",
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
      assertExpenseActionAllowed(existing, "edit");

      const now = new Date();
      const nextVersion = existing.version + 1;
      const [updated] = await tx
        .update(expenses)
        .set({
          amount: parsed.expense.amountCents,
          currency: "USD",
          category: parsed.expense.category,
          vendor: parsed.expense.vendor,
          memo: parsed.expense.memo,
          method: parsed.expense.method,
          paidAt: parsed.expense.paidAt,
          coverageStartAt: parsed.expense.coverageStartAt,
          coverageEndAt: parsed.expense.coverageEndAt,
          receiptFilename: parsed.receipt?.filename ?? existing.receiptFilename,
          receiptUrl: parsed.receipt?.dataUrl ?? existing.receiptUrl,
          receiptContentType:
            parsed.receipt?.contentType ?? existing.receiptContentType,
          version: nextVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(expenses.id, expenseId),
            eq(expenses.version, existing.version),
            eq(expenses.lifecycleStatus, "draft"),
          ),
        )
        .returning({ id: expenses.id });
      if (!updated?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The expense changed while it was being edited. Refresh and try again.",
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
        },
        after: {
          amountCents: parsed.expense.amountCents,
          category: parsed.expense.category,
          paidAt: parsed.expense.paidAt.toISOString(),
          lifecycleStatus: "draft",
          version: nextVersion,
        },
        metadata: {
          receiptReplaced: Boolean(parsed.receipt),
          receiptSha256: parsed.receipt?.sha256 ?? null,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          expenseId,
          lifecycleStatus: "draft" as const,
          version: nextVersion,
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
