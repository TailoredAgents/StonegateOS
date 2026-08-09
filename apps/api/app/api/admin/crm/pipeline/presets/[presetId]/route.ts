import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, teamPipelineFilterPresets } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationExceptionResult,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ presetId?: string }> };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DELETE_BODY_MAXIMUM_BYTES = 2 * 1024;
const DELETE_BODY_DEADLINE_MS = 5_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseExpectedVersion(
  value: unknown,
  boundaryVersion: string | null,
): number {
  const payload = record(value);
  const keys = payload ? Object.keys(payload) : [];
  const expectedVersion = payload?.["expectedVersion"];
  if (
    !payload ||
    keys.length !== 1 ||
    keys[0] !== "expectedVersion" ||
    !Number.isSafeInteger(expectedVersion) ||
    Number(expectedVersion) < 1 ||
    Number(expectedVersion) > 2_147_483_647 ||
    boundaryVersion === null ||
    boundaryVersion === "*" ||
    boundaryVersion !== String(expectedVersion)
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The exact saved-filter version is required in If-Match and expectedVersion.",
      { fieldErrors: { version: "Refresh saved filters and try again." } },
    );
  }
  return Number(expectedVersion);
}

function inputFailure(error: unknown): TeamMutationFailure {
  if (!(error instanceof BoundedJsonRequestError)) {
    return error instanceof TeamMutationFailure
      ? error
      : new TeamMutationFailure("invalid", "The delete payload is invalid.");
  }
  return error.code === "body_timeout"
    ? new TeamMutationFailure(
        "timeout",
        "The delete request body timed out before validation.",
        { retryable: true },
      )
    : new TeamMutationFailure("invalid", error.message, {
        fieldErrors: { body: "Send one bounded JSON delete request." },
      });
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["pipeline.read"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "pipeline.filter_preset.deleted",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const teamMemberId = mutation.actor.id ?? "";
  if (!UUID_PATTERN.test(teamMemberId)) {
    return teamMutationErrorResponse(
      "internal",
      "The verified team member is incomplete.",
      { correlationId: mutation.correlationId },
    );
  }

  const { presetId: rawPresetId } = await context.params;
  const presetId = rawPresetId?.trim() ?? "";
  if (!UUID_PATTERN.test(presetId)) {
    const failure = new TeamMutationFailure(
      "invalid",
      "Choose a valid saved pipeline filter to delete.",
      { fieldErrors: { presetId: "Refresh saved filters and try again." } },
    );
    await recordTeamMutationFailure(mutation, {
      entityType: "team_pipeline_filter_preset",
      code: failure.code,
      metadata: { boundary: "preset_id" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  let expectedVersion: number;
  try {
    expectedVersion = parseExpectedVersion(
      await readBoundedJsonRequest(request, {
        maximumBytes: DELETE_BODY_MAXIMUM_BYTES,
        deadlineMs: DELETE_BODY_DEADLINE_MS,
      }),
      mutation.expectedVersion,
    );
  } catch (error) {
    const failure = inputFailure(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "team_pipeline_filter_preset",
      entityId: presetId,
      code: failure.code,
      metadata: { boundary: "input" },
    });
    return teamMutationExceptionResponse(failure, mutation);
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "DELETE /api/admin/crm/pipeline/presets/:presetId",
      entityType: "team_pipeline_filter_preset",
      entityId: presetId,
      payload: { expectedVersion },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [preset] = await tx
        .select({
          id: teamPipelineFilterPresets.id,
          searchQuery: teamPipelineFilterPresets.searchQuery,
          stage: teamPipelineFilterPresets.stage,
          excludeOutbound: teamPipelineFilterPresets.excludeOutbound,
          view: teamPipelineFilterPresets.view,
          version: teamPipelineFilterPresets.version,
        })
        .from(teamPipelineFilterPresets)
        .where(
          and(
            eq(teamPipelineFilterPresets.id, presetId),
            eq(teamPipelineFilterPresets.teamMemberId, teamMemberId),
          ),
        )
        .for("update")
        .limit(1);
      if (!preset) {
        throw new TeamMutationFailure(
          "invalid",
          "That saved pipeline filter no longer exists.",
          { status: 404, fieldErrors: { presetId: "Refresh saved filters." } },
        );
      }
      assertTeamMutationExpectedVersion(mutation, preset.version);

      const [deleted] = await tx
        .delete(teamPipelineFilterPresets)
        .where(
          and(
            eq(teamPipelineFilterPresets.id, presetId),
            eq(teamPipelineFilterPresets.teamMemberId, teamMemberId),
            eq(teamPipelineFilterPresets.version, expectedVersion),
          ),
        )
        .returning({ id: teamPipelineFilterPresets.id });
      if (!deleted) {
        throw new TeamMutationFailure(
          "conflict",
          "The saved pipeline filter changed while it was being deleted. Refresh and try again.",
          { fieldErrors: { version: "Refresh saved filters." } },
        );
      }

      const committedAt = new Date();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "team_pipeline_filter_preset",
        entityId: preset.id,
        before: {
          hasSearch: preset.searchQuery.length > 0,
          stage: preset.stage,
          excludeOutbound: preset.excludeOutbound,
          view: preset.view,
          version: preset.version,
        },
        after: null,
        metadata: { memberScoped: true },
        committedAt,
      });
      const data = { deletedPresetId: preset.id };
      const mutationResult = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "team_pipeline_filter_preset",
        entityId: preset.id,
        version: String(preset.version),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
        committedAt,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(
      result as MutationResult<{ deletedPresetId: string }>,
      200,
      mutation.correlationId,
      { "Cache-Control": "private, no-store, max-age=0" },
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[pipeline-filter-presets] settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    const failure = teamMutationExceptionResult(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "team_pipeline_filter_preset",
      entityId: presetId,
      code: failure.result.code,
      metadata: { boundary: "operation" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
