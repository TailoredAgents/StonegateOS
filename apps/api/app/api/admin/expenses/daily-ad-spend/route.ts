import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  parseDailyAdSpendSaveInput,
  readDailyAdSpendDay,
  saveDailyAdSpendDay,
  validateDailyAdBusinessDate,
} from "@/lib/daily-ad-spend";
import { isExpenseAdSpendEnabled } from "@/lib/expense-feature-flags";
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

const ROUTE_PATH = "/api/admin/expenses/daily-ad-spend";
const BODY_MAXIMUM_BYTES = 2 * 1024;
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
      error: "expense_ad_spend_disabled",
      message: "Daily advertising entry is temporarily unavailable.",
      retryable: false,
    },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, "ad_spend.write");
  if (permissionError) return noStore(permissionError);
  if (!isExpenseAdSpendEnabled()) return disabledResponse();

  try {
    const values = request.nextUrl.searchParams.getAll("businessDate");
    if (values.length !== 1) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose one advertising business date.",
        { fieldErrors: { businessDate: "Use one YYYY-MM-DD value." } },
      );
    }
    const businessDate = validateDailyAdBusinessDate(values[0]);
    const day = await readDailyAdSpendDay(getDb(), businessDate);
    return NextResponse.json(
      { ok: true, currency: "USD", ...day },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const response = teamMutationExceptionResponse(error);
    if (!(error instanceof TeamMutationFailure)) {
      console.error("[daily-ad-spend] read_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return noStore(response);
  }
}

async function readSavePayload(request: NextRequest): Promise<unknown> {
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

async function saveAuthorized(
  request: NextRequest,
  method: "POST" | "PUT",
  mutation: TeamMutationContext,
): Promise<Response> {
  if (!isExpenseAdSpendEnabled()) return disabledResponse();

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const parsed = parseDailyAdSpendSaveInput(await readSavePayload(request));
    const actorId = mutation.actor.id;
    if (!actorId) {
      throw new TeamMutationFailure(
        "internal",
        "The verified advertising actor is incomplete.",
      );
    }

    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: `${method} ${ROUTE_PATH}`,
      entityType: "daily_ad_spend",
      entityId: parsed.businessDate,
      payload: parsed,
    });
    if (claimed.kind === "replay") {
      return noStore(teamMutationIdempotencyReplayResponse(claimed.replay));
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const saved = await saveDailyAdSpendDay(tx, {
        ...parsed,
        actorId,
        now,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "daily_ad_spend",
        entityId: parsed.businessDate,
        before: Object.fromEntries(
          saved.changes.map((change) => [
            change.platform,
            {
              amountCents: change.previousAmountCents,
              expenseId: change.previousExpenseId,
            },
          ]),
        ),
        after: {
          facebook: saved.facebook,
          google: saved.google,
        },
        metadata: {
          businessDate: parsed.businessDate,
          timezone: saved.timezone,
          changes: saved.changes.map((change) => ({
            platform: change.platform,
            kind: change.kind,
            reversalExpenseId: change.reversalExpenseId,
          })),
          accountingSource: "manual_authoritative",
          providerImportsIncluded: false,
        },
        committedAt: now,
      });
      const version = `facebook:${saved.facebook?.version ?? "missing"};google:${saved.google?.version ?? "missing"}`;
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          currency: "USD" as const,
          ...saved,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "daily_ad_spend",
          entityId: parsed.businessDate,
          version,
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
        console.error("[daily-ad-spend] idempotency_settlement_failed", {
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
    requiredPermissions: ["ad_spend.write"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.daily_ad_spend_saved",
  });
  if (!boundary.ok) return noStore(boundary.response);
  return saveAuthorized(request, "POST", boundary.mutation);
}

export async function PUT(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["ad_spend.write"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.daily_ad_spend_saved",
  });
  if (!boundary.ok) return noStore(boundary.response);
  return saveAuthorized(request, "PUT", boundary.mutation);
}
