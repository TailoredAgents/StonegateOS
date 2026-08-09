import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, mergeSuggestions } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  isExactContactMergeUuid,
  parseContactMergeReviewPayload,
} from "@/lib/contact-merge-contract";
import {
  buildMergeConfirmation,
  declineMergeSuggestionInTransaction,
  getMergePreview,
  MergeQueueError,
  mergeContactsInTransaction,
} from "@/lib/merge-queue";
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
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

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
    "The merge review could not be read safely.",
    { retryable: true },
  );
}

function errorResponse(error: unknown): Response {
  if (error instanceof MergeQueueError) {
    return NextResponse.json(
      { error: error.code, retryable: false },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: "merge_failed", retryable: true },
    { status: 500 },
  );
}

function asReviewMutationFailure(error: unknown): unknown {
  const databaseCode =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (databaseCode === "40001" || databaseCode === "40P01") {
    return new TeamMutationFailure(
      "conflict",
      "Another reviewer changed this contact scope first. Refresh the merge queue before trying again.",
      { retryable: false },
    );
  }
  if (!(error instanceof MergeQueueError)) return error;
  const code: "invalid" | "conflict" | "internal" =
    error.status === 422
      ? "invalid"
      : error.status === 409 || error.status === 404
        ? "conflict"
        : "internal";
  const messages: Record<string, string> = {
    merge_input_invalid:
      "The merge request no longer matches its exact preview. Refresh and review it again.",
    suggestion_already_resolved:
      "This suggestion was already decided or changed. Refresh the queue.",
    merge_confirmation_required:
      "The typed merge confirmation does not match this preview.",
    merge_contact_version_conflict:
      "One of the contacts changed after preview. Refresh and review the latest records.",
    merge_preview_conflict:
      "A linked record changed after preview. Refresh and review the complete dependency list.",
    merge_contact_inactive:
      "A selected contact is no longer active. Refresh the queue.",
    merge_contact_already_merged:
      "A selected contact already belongs to a completed merge. Review its recovery ledger instead.",
    merge_has_unresolved_dependencies:
      "The duplicate still owns records that cannot be consolidated safely.",
    merge_source_changed:
      "The duplicate changed while the merge was running. Refresh before retrying.",
    merge_dependency_evidence_incomplete:
      "The complete dependency evidence could not be captured. No merge was attempted.",
    merge_dependency_postcondition_failed:
      "A linked record did not match the reviewed merge plan. The merge was rolled back.",
    merge_actor_attribution_invalid:
      "Verified session attribution is invalid; the merge was rolled back.",
  };
  return new TeamMutationFailure(
    code,
    messages[error.code] ?? "The merge decision could not be saved safely.",
    { retryable: false },
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ suggestionId: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "contacts.merge");
  if (permissionError) return permissionError;
  if (request.nextUrl.search.length > 0) {
    return NextResponse.json(
      { error: "unsupported_query", retryable: false },
      { status: 422 },
    );
  }

  const { suggestionId } = await context.params;
  if (!isExactContactMergeUuid(suggestionId)) {
    return NextResponse.json(
      { error: "invalid_suggestion", retryable: false },
      { status: 422 },
    );
  }
  const db = getDb();
  const [suggestion] = await db
    .select({
      id: mergeSuggestions.id,
      status: mergeSuggestions.status,
      sourceContactId: mergeSuggestions.sourceContactId,
      targetContactId: mergeSuggestions.targetContactId,
      updatedAt: mergeSuggestions.updatedAt,
    })
    .from(mergeSuggestions)
    .where(eq(mergeSuggestions.id, suggestionId))
    .limit(1);

  if (!suggestion) {
    return NextResponse.json(
      { error: "suggestion_not_found" },
      { status: 404 },
    );
  }
  if (suggestion.status !== "pending") {
    return NextResponse.json(
      { error: "suggestion_already_resolved", retryable: false },
      { status: 409 },
    );
  }

  try {
    const preview = await getMergePreview({
      sourceContactId: suggestion.sourceContactId,
      targetContactId: suggestion.targetContactId,
    });
    return NextResponse.json(
      {
        suggestionId: suggestion.id,
        expectedUpdatedAt: suggestion.updatedAt.toISOString(),
        preview,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ suggestionId: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["contacts.merge"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "merge.suggestion.reviewed",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  if (request.nextUrl.search.length > 0) {
    return teamMutationErrorResponse(
      "invalid",
      "Merge reviews do not accept query parameters.",
      { correlationId: mutation.correlationId },
    );
  }
  const actorAuthMethod = mutation.actor.authMethod;
  if (!actorAuthMethod) {
    return teamMutationErrorResponse(
      "internal",
      "Verified session attribution is unavailable; no merge decision was attempted.",
      { correlationId: mutation.correlationId },
    );
  }
  const idempotencyKeyHash = mutation.idempotencyKeyHash;
  if (!idempotencyKeyHash) {
    return teamMutationErrorResponse(
      "internal",
      "Durable duplicate protection is unavailable; no merge decision was attempted.",
      { correlationId: mutation.correlationId },
    );
  }
  if (actorAuthMethod !== "team_session" && actorAuthMethod !== "break_glass") {
    return teamMutationErrorResponse(
      "internal",
      "Only an attributed human session can review a merge.",
      { correlationId: mutation.correlationId },
    );
  }
  const actorMemberId = mutation.actor.id;
  const actorSessionId = mutation.actor.sessionId;
  if (
    !isExactContactMergeUuid(actorMemberId) ||
    !isExactContactMergeUuid(actorSessionId)
  ) {
    return teamMutationErrorResponse(
      "internal",
      "Verified member and session attribution is required for a merge review.",
      { correlationId: mutation.correlationId },
    );
  }

  const { suggestionId } = await context.params;
  if (!isExactContactMergeUuid(suggestionId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A merge suggestion is required.",
      { correlationId: mutation.correlationId },
    );
  }

  let candidate: unknown;
  try {
    candidate = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1024,
      deadlineMs: 8_000,
    });
  } catch (error) {
    return teamMutationExceptionResponse(
      boundedRequestFailure(error),
      mutation,
    );
  }
  const payload = parseContactMergeReviewPayload(candidate);
  if (!payload) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose Approve or Decline before saving this review.",
      { correlationId: mutation.correlationId },
    );
  }
  const expectedSourceUpdatedAt =
    payload.action === "approve" ? payload.expectedSourceUpdatedAt : "";
  const expectedTargetUpdatedAt =
    payload.action === "approve" ? payload.expectedTargetUpdatedAt : "";
  const expectedPreviewHash =
    payload.action === "approve" ? payload.expectedPreviewHash : "";
  if (
    payload.action === "approve" &&
    mutation.expectedVersion !== expectedPreviewHash
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The contact versions are missing from this merge preview. Refresh before approving.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the merge preview." },
      },
    );
  }
  if (
    payload.action === "decline" &&
    mutation.expectedVersion !== payload.expectedUpdatedAt
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The suggestion version is inconsistent. Refresh before declining it.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the merge queue." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  const now = new Date();

  try {
    db = getDb();
    const claimedIdempotency = await claimTeamMutationIdempotency(
      db,
      mutation,
      {
        route: "PATCH /api/admin/merge-suggestions/:suggestionId",
        entityType: "merge_suggestion",
        entityId: suggestionId,
        payload: {
          action: payload.action,
          expectedUpdatedAt: payload.expectedUpdatedAt,
          expectedSourceUpdatedAt:
            payload.action === "approve" ? expectedSourceUpdatedAt : null,
          expectedTargetUpdatedAt:
            payload.action === "approve" ? expectedTargetUpdatedAt : null,
          expectedPreviewHash:
            payload.action === "approve" ? expectedPreviewHash : null,
        },
      },
    );
    if (claimedIdempotency.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimedIdempotency.replay);
    }
    claim = claimedIdempotency.claim;

    const result = await db.transaction(
      async (tx) => {
        let mergeResult: Awaited<
          ReturnType<typeof mergeContactsInTransaction>
        > | null = null;
        let sourceContactId: string;
        let targetContactId: string;
        let decisionVersion: string;
        if (payload.action === "decline") {
          const declineResult = await declineMergeSuggestionInTransaction(tx, {
            suggestionId,
            expectedUpdatedAt: payload.expectedUpdatedAt,
            actorMemberId,
            reviewedAt: now,
          });
          sourceContactId = declineResult.sourceContactId;
          targetContactId = declineResult.targetContactId;
          decisionVersion = declineResult.version;
        } else {
          const [hint] = await tx
            .select({
              sourceContactId: mergeSuggestions.sourceContactId,
              targetContactId: mergeSuggestions.targetContactId,
            })
            .from(mergeSuggestions)
            .where(eq(mergeSuggestions.id, suggestionId))
            .limit(1);
          if (!hint) {
            throw new MergeQueueError("suggestion_already_resolved", 409);
          }
          const requiredConfirmation = buildMergeConfirmation(
            hint.sourceContactId,
            hint.targetContactId,
          );
          if (payload.confirmation !== requiredConfirmation) {
            throw new MergeQueueError("merge_confirmation_required", 422);
          }
          mergeResult = await mergeContactsInTransaction(tx, {
            ...hint,
            expectedSourceUpdatedAt,
            expectedTargetUpdatedAt,
            expectedPreviewHash,
            recovery: {
              actorMemberId,
              actorRole: mutation.actor.role ?? null,
              actorLabel: mutation.actor.label ?? null,
              sessionId: actorSessionId,
              authMethod: actorAuthMethod,
              operationId: mutation.operationId,
              correlationId: mutation.correlationId,
              idempotencyKeyHash,
              suggestionId,
              expectedSuggestionUpdatedAt: payload.expectedUpdatedAt,
            },
          });
          sourceContactId = hint.sourceContactId;
          targetContactId = hint.targetContactId;
          decisionVersion =
            mergeResult.suggestionVersion ?? mergeResult.targetVersion;
        }

        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: "merge_suggestion",
          entityId: suggestionId,
          before: { status: "pending", updatedAt: payload.expectedUpdatedAt },
          after: {
            status: payload.action === "approve" ? "approved" : "declined",
            updatedAt: decisionVersion,
            targetVersion: mergeResult?.targetVersion ?? null,
            recoveryLedgerId: mergeResult?.recoveryLedgerId ?? null,
            previewHash: mergeResult?.previewHash ?? null,
          },
          metadata: {
            decision: payload.action,
            sourceContactId,
            targetContactId,
            moved: mergeResult?.moved ?? null,
            updatedFields: mergeResult?.updatedFields ?? [],
            recoveryPolicy:
              payload.action === "approve"
                ? "append_only_ledger_manual_assessment"
                : "not_applicable",
            recoveryAssessmentPath: mergeResult?.recoveryAssessmentPath ?? null,
          },
          committedAt: mergeResult ? new Date(mergeResult.targetVersion) : now,
        });
        const mutationResult = teamMutationSuccessResult(
          mutation,
          {
            status: payload.action === "approve" ? "approved" : "declined",
            sourceContactId,
            targetContactId,
            merged: payload.action === "approve",
            version: mergeResult?.targetVersion ?? decisionVersion,
            previewHash: mergeResult?.previewHash ?? null,
            recoveryLedgerId: mergeResult?.recoveryLedgerId ?? null,
            recoveryAssessmentPath: mergeResult?.recoveryAssessmentPath ?? null,
            moved: mergeResult?.moved ?? null,
          },
          {
            auditEventId: audit.auditEventId,
            committedAt: audit.committedAt,
            entityType: mergeResult
              ? "contact_merge_recovery"
              : "merge_suggestion",
            entityId: mergeResult?.recoveryLedgerId ?? suggestionId,
            version: mergeResult?.targetVersion ?? decisionVersion,
          },
        );
        await completeTeamMutationIdempotency(
          tx,
          mutation,
          claimedIdempotency.claim,
          mutationResult,
          200,
        );
        return mutationResult;
      },
      { isolationLevel: "serializable" },
    );

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    const failure = asReviewMutationFailure(error);
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        failure,
      ).catch(() => undefined);
    }
    return teamMutationExceptionResponse(failure, mutation);
  }
}
