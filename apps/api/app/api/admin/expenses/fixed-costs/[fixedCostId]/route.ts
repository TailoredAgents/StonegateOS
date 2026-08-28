import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  parseExpenseFixedCostRevisionInput,
  reviseExpenseFixedCost,
} from "@/lib/expense-fixed-costs";
import { isExpenseFixedCostsEnabled } from "@/lib/expense-feature-flags";
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

export const dynamic = "force-dynamic";
export const revalidate = 0;

const BODY_MAXIMUM_BYTES = 4 * 1024;
const BODY_DEADLINE_MS = 5_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
  response.headers.set("Pragma", NO_STORE_HEADERS.Pragma);
  return response;
}

function disabledResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "expense_fixed_costs_disabled",
      message: "Fixed-cost changes are temporarily unavailable.",
      retryable: false,
    },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

async function readPayload(request: NextRequest): Promise<unknown> {
  try {
    return await readBoundedJsonRequest(request, {
      maximumBytes: BODY_MAXIMUM_BYTES,
      deadlineMs: BODY_DEADLINE_MS,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    if (error instanceof BoundedJsonRequestError) {
      throw new TeamMutationFailure("invalid", error.message, {
        status: error.status,
        fieldErrors: { request: error.message },
      });
    }
    throw error;
  }
}

function expectedMutationVersion(value: string | null): number {
  if (value === null || value === "*") {
    throw new TeamMutationFailure(
      "invalid",
      "Refresh this fixed cost before changing it.",
      { status: 428 },
    );
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "The fixed-cost version is invalid.",
      { fieldErrors: { version: "Use the latest fixed-cost version." } },
    );
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw new TeamMutationFailure("invalid", "Fixed-cost version is invalid.");
  }
  return version;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ fixedCostId: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["financials.read", "expenses.approve"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.fixed_cost.changed",
  });
  if (!boundary.ok) return noStore(boundary.response);
  if (!isExpenseFixedCostsEnabled()) return disabledResponse();

  const mutation = boundary.mutation;
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const { fixedCostId } = await context.params;
    if (!UUID_PATTERN.test(fixedCostId)) {
      throw new TeamMutationFailure("invalid", "Fixed cost not found.", {
        status: 404,
      });
    }
    const expectedVersion = expectedMutationVersion(mutation.expectedVersion);
    const parsed = parseExpenseFixedCostRevisionInput(
      await readPayload(request),
    );
    if (parsed.expectedVersion !== expectedVersion) {
      throw new TeamMutationFailure(
        "conflict",
        "The fixed-cost version does not match this request.",
        { retryable: true },
      );
    }
    const actorId = mutation.actor.id;
    if (!actorId) {
      throw new TeamMutationFailure(
        "internal",
        "The verified fixed-cost actor is incomplete.",
      );
    }
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PATCH /api/admin/expenses/fixed-costs/:fixedCostId",
      entityType: "expense_fixed_cost",
      entityId: fixedCostId,
      payload: parsed,
    });
    if (claimed.kind === "replay") {
      return noStore(teamMutationIdempotencyReplayResponse(claimed.replay));
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const revised = await reviseExpenseFixedCost(tx, {
        ...parsed,
        seriesId: fixedCostId,
        actorId,
        now,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "expense_fixed_cost",
        entityId: fixedCostId,
        before: revised.before,
        after: revised.after,
        metadata: {
          action: parsed.action,
          effectiveStartDate: parsed.effectiveStartDate,
          historicalRowsRewritten: false,
          syntheticLedgerRowsCreated: false,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        revised.after,
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "expense_fixed_cost",
          entityId: fixedCostId,
          version: String(revised.after.version),
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
    return noStore(
      teamMutationResultResponse(
        result,
        200,
        mutation.correlationId,
        NO_STORE_HEADERS,
      ),
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[fixed-costs] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return noStore(teamMutationExceptionResponse(error, mutation));
  }
}
