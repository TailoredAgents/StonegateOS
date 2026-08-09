import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  isExactContactMergeUuid,
  parseManualContactMergePayload,
} from "@/lib/contact-merge-contract";
import {
  buildMergeConfirmation,
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
import { isAdminRequest } from "../../web/admin";

function readPreviewContactIds(request: NextRequest): {
  sourceContactId: string;
  targetContactId: string;
} | null {
  const parameters = request.nextUrl.searchParams;
  const keys = Array.from(parameters.keys());
  if (
    keys.length !== 2 ||
    parameters.getAll("sourceContactId").length !== 1 ||
    parameters.getAll("targetContactId").length !== 1 ||
    keys.some((key) => key !== "sourceContactId" && key !== "targetContactId")
  ) {
    return null;
  }
  const sourceContactId = parameters.get("sourceContactId");
  const targetContactId = parameters.get("targetContactId");
  if (
    !isExactContactMergeUuid(sourceContactId) ||
    !isExactContactMergeUuid(targetContactId)
  ) {
    return null;
  }
  return { sourceContactId, targetContactId };
}

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
    "The merge request could not be read safely.",
    { retryable: true },
  );
}

function mergeErrorResponse(error: unknown): Response {
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

function asMergeMutationFailure(error: unknown): unknown {
  const databaseCode =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (databaseCode === "40001" || databaseCode === "40P01") {
    return new TeamMutationFailure(
      "conflict",
      "Another merge changed this contact scope first. Refresh the dependency preview before trying again.",
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
    same_contact: "Choose two different contacts before merging.",
    contact_not_found:
      "A selected contact no longer exists. Refresh and search again.",
    merge_contact_version_conflict:
      "One of the contacts changed after preview. Refresh and review the latest records.",
    merge_preview_conflict:
      "A linked record changed after preview. Refresh and review the complete dependency list.",
    merge_contact_inactive:
      "A selected contact is no longer active. Refresh and choose active contacts.",
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
    messages[error.code] ?? "The contacts could not be merged safely.",
    // A preview-bound 409 is terminal for this exact idempotency key. The
    // failure settlement stores and replays it; a refreshed preview must use
    // a new key and hash rather than silently changing the original request.
    { retryable: false },
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "contacts.merge");
  if (permissionError) return permissionError;

  const ids = readPreviewContactIds(request);
  if (!ids) {
    return NextResponse.json(
      { error: "contact_ids_required" },
      { status: 422 },
    );
  }

  try {
    return NextResponse.json(
      { preview: await getMergePreview(ids) },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return mergeErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["contacts.merge"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "contact.merged",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  if (request.nextUrl.search.length > 0) {
    return teamMutationErrorResponse(
      "invalid",
      "Merge requests do not accept query parameters.",
      { correlationId: mutation.correlationId },
    );
  }
  const actorAuthMethod = mutation.actor.authMethod;
  if (!actorAuthMethod) {
    return teamMutationErrorResponse(
      "internal",
      "Verified session attribution is unavailable; no merge was attempted.",
      { correlationId: mutation.correlationId },
    );
  }
  const idempotencyKeyHash = mutation.idempotencyKeyHash;
  if (!idempotencyKeyHash) {
    return teamMutationErrorResponse(
      "internal",
      "Durable duplicate protection is unavailable; no merge was attempted.",
      { correlationId: mutation.correlationId },
    );
  }
  if (actorAuthMethod !== "team_session" && actorAuthMethod !== "break_glass") {
    return teamMutationErrorResponse(
      "internal",
      "Only an attributed human session can perform a contact merge.",
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
      "Verified member and session attribution is required for a contact merge.",
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
  const payload = parseManualContactMergePayload(candidate);
  if (!payload) {
    return teamMutationErrorResponse(
      "invalid",
      "The merge preview, confirmation, or reason is invalid.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          contacts: "Select two valid contacts from a fresh preview.",
          version: "Refresh the merge preview and dependency list.",
        },
      },
    );
  }
  const ids = {
    sourceContactId: payload.sourceContactId,
    targetContactId: payload.targetContactId,
  };
  if (ids.sourceContactId === ids.targetContactId) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose two different contacts before merging.",
      { correlationId: mutation.correlationId },
    );
  }
  if (
    payload.confirmation !==
    buildMergeConfirmation(ids.sourceContactId, ids.targetContactId)
  ) {
    return teamMutationErrorResponse(
      "invalid",
      "The typed merge confirmation does not match this preview.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { confirmation: "Type the exact confirmation shown." },
      },
    );
  }

  const { expectedSourceUpdatedAt, expectedTargetUpdatedAt } = payload;
  const expectedPreviewHash = payload.expectedPreviewHash;
  if (mutation.expectedVersion !== expectedPreviewHash) {
    return teamMutationErrorResponse(
      "invalid",
      "The merge preview is missing its contact versions. Refresh and review it again.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          version: "Refresh the merge preview and dependency list.",
        },
      },
    );
  }

  const reason = payload.reason;
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;

  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/merge",
      entityType: "contact",
      entityId: ids.targetContactId,
      payload: {
        sourceContactId: ids.sourceContactId,
        reason,
        expectedSourceUpdatedAt,
        expectedTargetUpdatedAt,
        expectedPreviewHash,
      },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(
      async (tx) => {
        const mergeResult = await mergeContactsInTransaction(tx, {
          ...ids,
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
          },
        });
        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: "contact",
          entityId: ids.targetContactId,
          before: {
            sourceContactId: ids.sourceContactId,
            sourceUpdatedAt: expectedSourceUpdatedAt,
            targetUpdatedAt: expectedTargetUpdatedAt,
          },
          after: {
            targetContactId: ids.targetContactId,
            targetUpdatedAt: mergeResult.targetVersion,
            recoveryLedgerId: mergeResult.recoveryLedgerId,
            previewHash: mergeResult.previewHash,
          },
          metadata: {
            reason,
            moved: mergeResult.moved,
            updatedFields: mergeResult.updatedFields,
            recoveryPolicy: "append_only_ledger_manual_assessment",
            recoveryAssessmentPath: mergeResult.recoveryAssessmentPath,
          },
        });
        const mutationResult = teamMutationSuccessResult(
          mutation,
          {
            merged: true,
            sourceContactId: ids.sourceContactId,
            targetContactId: ids.targetContactId,
            moved: mergeResult.moved,
            version: mergeResult.targetVersion,
            previewHash: mergeResult.previewHash,
            recoveryLedgerId: mergeResult.recoveryLedgerId,
            recoveryAssessmentPath: mergeResult.recoveryAssessmentPath,
          },
          {
            auditEventId: audit.auditEventId,
            committedAt: audit.committedAt,
            entityType: "contact_merge_recovery",
            entityId: mergeResult.recoveryLedgerId,
            version: mergeResult.targetVersion,
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
      },
      { isolationLevel: "serializable" },
    );
    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    const failure = asMergeMutationFailure(error);
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
