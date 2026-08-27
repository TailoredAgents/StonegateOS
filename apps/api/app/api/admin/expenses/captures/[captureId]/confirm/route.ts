import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { isExpenseReceiptCaptureEnabled } from "@/lib/expense-feature-flags";
import {
  confirmExpenseReceiptInTransaction,
  parseExpenseReceiptConfirmation,
} from "@/lib/expense-receipt-confirmation";
import { permissionMatches, resolvePermissionContext } from "@/lib/permissions";
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

type RouteContext = { params: Promise<{ captureId?: string }> };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function canApproveExpense(permissions: string[]): boolean {
  return permissions.some((permission) =>
    permissionMatches(permission, "expenses.approve"),
  );
}

function parseCaptureVersion(rawVersion: string | null): number | null {
  if (!rawVersion || !/^\d+$/u.test(rawVersion)) return null;
  const version = Number(rawVersion);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["expenses.submit"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.receipt.confirmed",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { captureId: rawCaptureId } = await context.params;
  const captureId = rawCaptureId?.trim() ?? "";
  if (!UUID_PATTERN.test(captureId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid receipt capture ID is required.",
      {
        correlationId: mutation.correlationId,
      },
    );
  }
  const expectedVersion = parseCaptureVersion(mutation.expectedVersion);
  if (expectedVersion === null) {
    return teamMutationErrorResponse(
      "invalid",
      "The latest receipt version is required before confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the receipt and try again." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    if (!isExpenseReceiptCaptureEnabled()) {
      throw new TeamMutationFailure(
        "provider_failed",
        "Receipt capture is temporarily unavailable.",
        { status: 503, retryable: true },
      );
    }
    const actorId = mutation.actor.id;
    if (!actorId) {
      throw new TeamMutationFailure(
        "internal",
        "The verified expense submitter is incomplete.",
      );
    }
    const permissionContext = await resolvePermissionContext(request);
    const canApprove = canApproveExpense(permissionContext.permissions);
    const confirmation = parseExpenseReceiptConfirmation(
      (await request.json().catch(() => null)) as unknown,
    );

    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/expenses/captures/:captureId/confirm",
      entityType: "expense_receipt_capture",
      entityId: captureId,
      payload: {
        ...confirmation.submission,
        captureVersion: expectedVersion,
        exactDuplicateOverrideReason: confirmation.exactDuplicateOverrideReason,
      },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const confirmed = await confirmExpenseReceiptInTransaction(tx, {
        captureId,
        expectedVersion,
        actorId,
        canApprove,
        confirmation,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "expense_receipt_capture",
        entityId: confirmed.captureId,
        before: { status: "ready", version: confirmed.priorCaptureVersion },
        after: {
          status: confirmed.captureStatus,
          version: confirmed.captureVersion,
          expenseId: confirmed.expenseId,
          reviewStatus: confirmed.reviewStatus,
          lifecycleStatus: confirmed.lifecycleStatus,
        },
        metadata: {
          exactDuplicateOfCaptureId: confirmed.exactDuplicateOfCaptureId,
          duplicateOverrideRecorded: confirmed.duplicateOverrideRecorded,
          duplicateOverrideReasonLength:
            confirmation.exactDuplicateOverrideReason?.length ?? 0,
          humanConfirmed: true,
        },
      });
      const {
        priorCaptureVersion: _priorCaptureVersion,
        captureSubmittedBy: _captureSubmittedBy,
        exactDuplicateOfCaptureId: _exactDuplicateOfCaptureId,
        duplicateOverrideRecorded: _duplicateOverrideRecorded,
        ...data
      } = confirmed;
      const mutationResult = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "expense",
        entityId: confirmed.expenseId,
        version: String(confirmed.version),
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
        console.error("[expenses] receipt_confirmation_settlement_failed", {
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
