import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  lockPayoutRun,
  requirePayoutRunExpectedVersion,
} from "@/lib/commissions";
import {
  normalizePayoutRunMutationError,
  requirePayoutRunId,
} from "@/lib/payout-run-mutation-http";
import {
  claimTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
} from "@/lib/team-mutation";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ payoutRunId: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["commissions.manage"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "commission.payout_run.locked",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  let payoutRunId: string | null = null;
  try {
    const { payoutRunId: rawPayoutRunId } = await context.params;
    payoutRunId = requirePayoutRunId(rawPayoutRunId);
    requirePayoutRunExpectedVersion(mutation);
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/commissions/payout-runs/:id/lock",
      entityType: "payout_run",
      entityId: payoutRunId,
      payload: { requestedStatus: "locked" },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await lockPayoutRun(db, {
      payoutRunId,
      actor: mutation.actor,
      execution: { mutation, claim },
    });
    if (!result.mutationResult) {
      throw new TeamMutationFailure(
        "internal",
        "The payout lock result could not be verified.",
        { retryable: true },
      );
    }
    return teamMutationResultResponse(
      result.mutationResult,
      200,
      mutation.correlationId,
    );
  } catch (rawError) {
    const error = normalizePayoutRunMutationError(rawError);
    await recordTeamMutationFailure(mutation, {
      entityType: "payout_run",
      entityId: payoutRunId,
      code: error.code,
      metadata: {
        route: "payout_run_lock",
        boundary: claim ? "execution" : "input",
      },
    });
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[commissions] lock_idempotency_settlement_failed", {
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
