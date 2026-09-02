import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { initiatePartnerAccountMergeCase } from "@/lib/partner-account-merge-administration";
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
    targetPartnerAccountId: z.string().uuid(),
    reason: z.string().trim().min(20).max(1_000),
    confirmation: z.literal("PREPARE PARTNER ACCOUNT MERGE"),
  })
  .strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ accountId?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.accounts.merge"],
    risk: "destructive",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_account_merge.preflighted",
  });
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;
  const sourcePartnerAccountId =
    (await context.params).accountId?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(sourcePartnerAccountId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid source partner account.",
      { status: 404, correlationId: mutation.correlationId },
    );
  }
  if (
    !mutation.expectedVersion ||
    !/^[1-9][0-9]{0,9}$/u.test(mutation.expectedVersion)
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The current source-account lifecycle version is required.",
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
      "Choose a destination, provide a durable reason, and type the exact confirmation.",
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
        "POST /api/admin/partner-management/v1/accounts/:accountId/merge",
      entityType: "partner_account",
      entityId: sourcePartnerAccountId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await database.transaction(async (tx) => {
      const prepared = await initiatePartnerAccountMergeCase(tx, {
        sourcePartnerAccountId,
        targetPartnerAccountId: parsed.data.targetPartnerAccountId,
        sourceExpectedVersion: mutation.expectedVersion!,
        reason: parsed.data.reason,
        teamMemberId: actorId,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_account_merge_case",
        entityId: prepared.mergeCase.id,
        before: prepared.before,
        after: prepared.after,
        metadata: {
          sourcePartnerAccountId,
          targetPartnerAccountId: parsed.data.targetPartnerAccountId,
          reason: parsed.data.reason,
          state: prepared.mergeCase.state,
          conflictSummary: prepared.counts,
          automaticTenantRewrite: false,
        },
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          mergeCaseId: prepared.mergeCase.id,
          sourcePartnerAccountId,
          targetPartnerAccountId: prepared.mergeCase.targetPartnerAccountId,
          state: prepared.mergeCase.state,
          conflictSummary: prepared.counts,
          version: String(prepared.mergeCase.version),
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_account_merge_case",
          entityId: prepared.mergeCase.id,
          version: String(prepared.mergeCase.version),
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
        console.error("[partner-management] merge_preflight_settlement_failed", {
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
