import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { completePartnerAccountMergeCase } from "@/lib/partner-account-merge-administration";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const InputSchema = z
  .object({
    resolutionNote: z.string().trim().min(20).max(1_000),
    confirmation: z.literal("COMPLETE PARTNER ACCOUNT MERGE"),
  })
  .strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ caseId?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.accounts.merge"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_account_merge.completed",
  });
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;
  const mergeCaseId =
    (await context.params).caseId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(mergeCaseId)) {
    return teamMutationErrorResponse("invalid", "Merge case not found.", {
      status: 404,
      correlationId: mutation.correlationId,
    });
  }
  if (
    !mutation.expectedVersion ||
    !/^[1-9][0-9]{0,9}$/u.test(mutation.expectedVersion)
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The current merge-case version is required.",
      { correlationId: mutation.correlationId },
    );
  }
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return teamMutationExceptionResponse(
      error instanceof BoundedJsonRequestError
        ? new TeamMutationFailure("invalid", "The request body is invalid.", {
            status: error.status,
          })
        : error,
      mutation,
    );
  }
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "Record the reconciliation result and type the exact confirmation.",
      { correlationId: mutation.correlationId },
    );
  }
  const actorId = mutation.actor.id;
  if (!actorId || !UUID_PATTERN.test(actorId)) {
    return teamMutationErrorResponse(
      "forbidden",
      "A verified Team Owner is required.",
      { correlationId: mutation.correlationId },
    );
  }
  const database = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route:
        "POST /api/admin/partner-management/v1/account-merges/:caseId/complete",
      entityType: "partner_account_merge_case",
      entityId: mergeCaseId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await database.transaction(async (tx) => {
      const completed = await completePartnerAccountMergeCase(tx, {
        mergeCaseId,
        expectedVersion: mutation.expectedVersion!,
        resolutionNote: parsed.data.resolutionNote,
        teamMemberId: actorId,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_account_merge_case",
        entityId: mergeCaseId,
        before: completed.before,
        after: completed.after,
        metadata: {
          sourcePartnerAccountId:
            completed.mergeCase.sourcePartnerAccountId,
          targetPartnerAccountId:
            completed.mergeCase.targetPartnerAccountId,
          resolutionNote: parsed.data.resolutionNote,
          operationalAndFinancialRecordsPreserved: true,
          automaticTenantRewrite: false,
        },
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          mergeCaseId,
          sourcePartnerAccountId:
            completed.mergeCase.sourcePartnerAccountId,
          targetPartnerAccountId:
            completed.mergeCase.targetPartnerAccountId,
          state: completed.mergeCase.state,
          sourceLifecycleStatus:
            completed.sourceAccount.portalLifecycleStatus,
          version: String(completed.mergeCase.version),
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account_merge_case",
          entityId: mergeCaseId,
          version: String(completed.mergeCase.version),
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
    return teamMutationResultResponse(result, 200, mutation.correlationId, {
      "Cache-Control": "private, no-store",
      ETag: `"${String(result.receipt.version)}"`,
    });
  } catch (error) {
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(
          database,
          mutation,
          claim,
          error,
        );
      } catch (settlementError) {
        console.error("[partner-management] merge_complete_settlement_failed", {
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
