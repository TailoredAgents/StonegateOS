import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { parseContactMergeScanOptions } from "@/lib/contact-merge-contract";
import { scanMergeSuggestionsUsing } from "@/lib/merge-queue";
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

function boundedRequestFailure(error: unknown): TeamMutationFailure {
  if (error instanceof BoundedJsonRequestError) {
    return new TeamMutationFailure(
      error.code === "body_timeout" ? "timeout" : "invalid",
      error.message,
      {
        status: error.status,
        retryable: error.code === "body_timeout",
      },
    );
  }
  return new TeamMutationFailure(
    "internal",
    "The merge scan request could not be read safely.",
    { retryable: true },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["contacts.merge"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "merge.suggestions.scanned",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  if (request.nextUrl.search.length > 0) {
    return teamMutationErrorResponse(
      "invalid",
      "Merge scans do not accept query parameters.",
      { correlationId: mutation.correlationId },
    );
  }

  let candidate: unknown;
  try {
    candidate = await readBoundedJsonRequest(request, {
      maximumBytes: 2 * 1024,
      deadlineMs: 8_000,
    });
  } catch (error) {
    return teamMutationExceptionResponse(
      boundedRequestFailure(error),
      mutation,
    );
  }
  const options = parseContactMergeScanOptions(candidate);
  if (!options) {
    return teamMutationErrorResponse(
      "invalid",
      "Merge scan limits must be whole numbers inside the supported ranges.",
      { correlationId: mutation.correlationId },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/merge-suggestions/scan",
      entityType: "merge_suggestion_scan",
      entityId: "latest",
      payload: options,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      // Suggestions, success audit, receipt, and idempotency completion share
      // one commit. A crash cannot leave newly created queue rows without the
      // corresponding actor evidence.
      const scanResult = await scanMergeSuggestionsUsing(tx, options);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "merge_suggestion_scan",
        entityId: null,
        after: scanResult,
        metadata: { duplicatePairPolicy: "on_conflict_do_nothing" },
      });
      const mutationResult = teamMutationSuccessResult(mutation, scanResult, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "merge_suggestion_scan",
      });
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
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
