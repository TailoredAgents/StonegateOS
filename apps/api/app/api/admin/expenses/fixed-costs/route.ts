import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  createExpenseFixedCost,
  parseExpenseFixedCostCreateInput,
  readExpenseFixedCosts,
  validateExpenseFixedCostAsOf,
} from "@/lib/expense-fixed-costs";
import { isExpenseFixedCostsEnabled } from "@/lib/expense-feature-flags";
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
  type TeamMutationContext,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ROUTE_PATH = "/api/admin/expenses/fixed-costs";
const BODY_MAXIMUM_BYTES = 4 * 1024;
const BODY_DEADLINE_MS = 5_000;
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

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, "financials.read");
  if (permissionError) return noStore(permissionError);
  try {
    const values = request.nextUrl.searchParams.getAll("asOf");
    if (values.length > 1) {
      throw new TeamMutationFailure("invalid", "Choose one as-of date.", {
        fieldErrors: { asOf: "Use one YYYY-MM-DD value." },
      });
    }
    const asOf =
      values.length === 1 ? validateExpenseFixedCostAsOf(values[0]) : undefined;
    const result = await readExpenseFixedCosts(getDb(), asOf);
    return NextResponse.json(
      { ok: true, currency: "USD", ...result },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (!(error instanceof TeamMutationFailure)) {
      console.error("[fixed-costs] read_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return noStore(teamMutationExceptionResponse(error));
  }
}

async function createAuthorized(
  request: NextRequest,
  mutation: TeamMutationContext,
): Promise<Response> {
  if (!isExpenseFixedCostsEnabled()) return disabledResponse();
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const parsed = parseExpenseFixedCostCreateInput(await readPayload(request));
    const actorId = mutation.actor.id;
    if (!actorId) {
      throw new TeamMutationFailure(
        "internal",
        "The verified fixed-cost actor is incomplete.",
      );
    }
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: `POST ${ROUTE_PATH}`,
      entityType: "expense_fixed_cost",
      entityId: "new",
      payload: parsed,
    });
    if (claimed.kind === "replay") {
      return noStore(teamMutationIdempotencyReplayResponse(claimed.replay));
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const created = await createExpenseFixedCost(tx, {
        ...parsed,
        actorId,
        now,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "expense_fixed_cost",
        entityId: created.seriesId,
        before: null,
        after: created,
        metadata: {
          accountingBasis: "monthly_cost_accrued_by_eastern_calendar_day",
          syntheticLedgerRowsCreated: false,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(mutation, created, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "expense_fixed_cost",
        entityId: created.seriesId,
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
    return noStore(
      teamMutationResultResponse(
        result,
        201,
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

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["financials.read", "expenses.approve"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.fixed_cost.created",
  });
  if (!boundary.ok) return noStore(boundary.response);
  return createAuthorized(request, boundary.mutation);
}
