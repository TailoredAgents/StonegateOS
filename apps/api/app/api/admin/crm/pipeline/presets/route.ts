import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, asc, count, eq } from "drizzle-orm";
import { getDb, teamMembers, teamPipelineFilterPresets } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
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
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationExceptionResult,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { getVerifiedRequestActor } from "@/lib/verified-actor-context";
import { PIPELINE_STAGE_SET, type PipelineStage } from "../stages";

export const PIPELINE_FILTER_PRESET_LIMIT = 12;
const PIPELINE_FILTER_PRESET_BODY_MAXIMUM_BYTES = 8 * 1024;
const PIPELINE_FILTER_PRESET_BODY_DEADLINE_MS = 5_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 &'(),./_-]{0,59}$/u;
const CREATE_KEYS = ["excludeOutbound", "name", "q", "stage", "view"] as const;

type PipelinePresetView = "board" | "list";
type PipelineFilterPresetData = {
  id: string;
  name: string;
  q: string;
  stage: PipelineStage | null;
  excludeOutbound: boolean;
  view: PipelinePresetView;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type PipelineFilterPresetCreateInput = {
  name: string;
  nameNormalized: string;
  q: string;
  stage: PipelineStage | null;
  excludeOutbound: boolean;
  view: PipelinePresetView;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    sortedExpected.every((key, index) => keys[index] === key)
  );
}

function hasUnsafeTextCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 31 ||
      codePoint === 127 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

function normalizeSpaces(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function parseCreateInput(value: unknown): PipelineFilterPresetCreateInput {
  const payload = record(value);
  if (!payload || !exactKeys(payload, CREATE_KEYS)) {
    throw new TeamMutationFailure(
      "invalid",
      "Send exactly one complete pipeline filter preset.",
      {
        fieldErrors: {
          body: "Name, search, stage, outbound visibility, and view are required; unsupported fields are not accepted.",
        },
      },
    );
  }

  const name =
    typeof payload["name"] === "string" ? normalizeSpaces(payload["name"]) : "";
  if (!SAFE_NAME_PATTERN.test(name) || hasUnsafeTextCharacter(name)) {
    throw new TeamMutationFailure("invalid", "Enter a safe preset name.", {
      fieldErrors: {
        name: "Use 1–60 letters, numbers, spaces, or simple punctuation, starting with a letter or number.",
      },
    });
  }

  const q =
    typeof payload["q"] === "string" ? normalizeSpaces(payload["q"]) : "";
  if (q.length > 120 || hasUnsafeTextCharacter(q)) {
    throw new TeamMutationFailure(
      "invalid",
      "The saved pipeline search is invalid.",
      {
        fieldErrors: {
          q: "Keep the normalized search at 120 characters or fewer.",
        },
      },
    );
  }

  const rawStage = payload["stage"];
  const stage =
    rawStage === null
      ? null
      : typeof rawStage === "string" && PIPELINE_STAGE_SET.has(rawStage)
        ? (rawStage as PipelineStage)
        : undefined;
  if (stage === undefined) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a supported pipeline stage.",
      { fieldErrors: { stage: "Choose All stages or one listed stage." } },
    );
  }

  if (typeof payload["excludeOutbound"] !== "boolean") {
    throw new TeamMutationFailure(
      "invalid",
      "Choose whether outbound contacts are included.",
      {
        fieldErrors: {
          excludeOutbound: "Outbound visibility must be true or false.",
        },
      },
    );
  }
  const view = payload["view"];
  if (view !== "board" && view !== "list") {
    throw new TeamMutationFailure(
      "invalid",
      "Choose the Board or List pipeline view.",
      { fieldErrors: { view: "Choose Board or List." } },
    );
  }

  return {
    name,
    nameNormalized: name.toLowerCase(),
    q,
    stage,
    excludeOutbound: payload["excludeOutbound"],
    view,
  };
}

function inputFailure(error: unknown): TeamMutationFailure {
  if (!(error instanceof BoundedJsonRequestError)) {
    return error instanceof TeamMutationFailure
      ? error
      : new TeamMutationFailure("invalid", "The preset payload is invalid.");
  }
  return error.code === "body_timeout"
    ? new TeamMutationFailure(
        "timeout",
        "The preset body timed out before it could be validated.",
        { retryable: true },
      )
    : new TeamMutationFailure("invalid", error.message, {
        fieldErrors: { body: "Send one bounded JSON preset." },
      });
}

function serializePreset(row: {
  id: string;
  name: string;
  searchQuery: string;
  stage: PipelineStage | null;
  excludeOutbound: boolean;
  view: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): PipelineFilterPresetData {
  return {
    id: row.id,
    name: row.name,
    q: row.searchQuery,
    stage: row.stage,
    excludeOutbound: row.excludeOutbound,
    view: row.view === "list" ? "list" : "board",
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniquePresetNameViolation(error: unknown): boolean {
  const details = record(error);
  const cause = details ? record(details["cause"]) : null;
  const candidate = cause ?? details;
  return Boolean(
    candidate &&
      (candidate["constraint"] ===
        "team_pipeline_filter_presets_member_name_key" ||
        candidate["constraint_name"] ===
          "team_pipeline_filter_presets_member_name_key"),
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, "pipeline.read");
  if (permissionError) return permissionError;
  const actor = getVerifiedRequestActor(request);
  if (actor?.type !== "human" || !actor.id || !UUID_PATTERN.test(actor.id)) {
    return teamMutationErrorResponse(
      "unauthorized",
      "A verified team member is required to load saved pipeline filters.",
    );
  }

  try {
    const rows = await getDb()
      .select({
        id: teamPipelineFilterPresets.id,
        name: teamPipelineFilterPresets.name,
        searchQuery: teamPipelineFilterPresets.searchQuery,
        stage: teamPipelineFilterPresets.stage,
        excludeOutbound: teamPipelineFilterPresets.excludeOutbound,
        view: teamPipelineFilterPresets.view,
        version: teamPipelineFilterPresets.version,
        createdAt: teamPipelineFilterPresets.createdAt,
        updatedAt: teamPipelineFilterPresets.updatedAt,
      })
      .from(teamPipelineFilterPresets)
      .where(eq(teamPipelineFilterPresets.teamMemberId, actor.id))
      .orderBy(
        asc(teamPipelineFilterPresets.nameNormalized),
        asc(teamPipelineFilterPresets.id),
      )
      .limit(PIPELINE_FILTER_PRESET_LIMIT + 1);
    if (rows.length > PIPELINE_FILTER_PRESET_LIMIT) {
      return teamMutationErrorResponse(
        "internal",
        "Saved pipeline filters exceed the supported per-user limit. Contact support before changing them.",
      );
    }
    return Response.json(
      {
        presets: rows.map(serializePreset),
        limit: PIPELINE_FILTER_PRESET_LIMIT,
      },
      {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  } catch {
    return teamMutationErrorResponse(
      "internal",
      "Saved pipeline filters could not be loaded. Retry this section.",
      { retryable: true },
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["pipeline.read"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "pipeline.filter_preset.created",
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

  let input: PipelineFilterPresetCreateInput;
  try {
    input = parseCreateInput(
      await readBoundedJsonRequest(request, {
        maximumBytes: PIPELINE_FILTER_PRESET_BODY_MAXIMUM_BYTES,
        deadlineMs: PIPELINE_FILTER_PRESET_BODY_DEADLINE_MS,
      }),
    );
  } catch (error) {
    const failure = inputFailure(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "team_pipeline_filter_preset",
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
      route: "POST /api/admin/crm/pipeline/presets",
      entityType: "team_pipeline_filter_preset",
      entityId: teamMemberId,
      payload: input,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [member] = await tx
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(eq(teamMembers.id, teamMemberId))
        .for("update")
        .limit(1);
      if (!member) {
        throw new TeamMutationFailure(
          "unauthorized",
          "The verified team member is no longer available.",
        );
      }

      const [existing] = await tx
        .select({ id: teamPipelineFilterPresets.id })
        .from(teamPipelineFilterPresets)
        .where(
          and(
            eq(teamPipelineFilterPresets.teamMemberId, teamMemberId),
            eq(teamPipelineFilterPresets.nameNormalized, input.nameNormalized),
          ),
        )
        .for("update")
        .limit(1);
      if (existing) {
        throw new TeamMutationFailure(
          "conflict",
          "You already have a saved pipeline filter with that name.",
          { fieldErrors: { name: "Choose a unique preset name." } },
        );
      }

      const [countRow] = await tx
        .select({ value: count() })
        .from(teamPipelineFilterPresets)
        .where(eq(teamPipelineFilterPresets.teamMemberId, teamMemberId));
      if (Number(countRow?.value ?? 0) >= PIPELINE_FILTER_PRESET_LIMIT) {
        throw new TeamMutationFailure(
          "conflict",
          `You can save up to ${PIPELINE_FILTER_PRESET_LIMIT} pipeline filters. Delete one before saving another.`,
        );
      }

      const now = new Date();
      const [created] = await tx
        .insert(teamPipelineFilterPresets)
        .values({
          teamMemberId,
          name: input.name,
          nameNormalized: input.nameNormalized,
          searchQuery: input.q,
          stage: input.stage,
          excludeOutbound: input.excludeOutbound,
          view: input.view,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: teamPipelineFilterPresets.id,
          name: teamPipelineFilterPresets.name,
          searchQuery: teamPipelineFilterPresets.searchQuery,
          stage: teamPipelineFilterPresets.stage,
          excludeOutbound: teamPipelineFilterPresets.excludeOutbound,
          view: teamPipelineFilterPresets.view,
          version: teamPipelineFilterPresets.version,
          createdAt: teamPipelineFilterPresets.createdAt,
          updatedAt: teamPipelineFilterPresets.updatedAt,
        });
      if (!created) {
        throw new TeamMutationFailure(
          "internal",
          "The saved pipeline filter could not be created.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "team_pipeline_filter_preset",
        entityId: created.id,
        after: {
          hasSearch: input.q.length > 0,
          stage: input.stage,
          excludeOutbound: input.excludeOutbound,
          view: input.view,
          version: created.version,
        },
        metadata: { memberScoped: true },
        committedAt: now,
      });
      const data = { preset: serializePreset(created) };
      const mutationResult = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "team_pipeline_filter_preset",
        entityId: created.id,
        version: String(created.version),
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        201,
        now,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(
      result as MutationResult<{ preset: PipelineFilterPresetData }>,
      201,
      mutation.correlationId,
      { "Cache-Control": "private, no-store, max-age=0" },
    );
  } catch (rawError) {
    const error = isUniquePresetNameViolation(rawError)
      ? new TeamMutationFailure(
          "conflict",
          "You already have a saved pipeline filter with that name.",
          { fieldErrors: { name: "Choose a unique preset name." } },
        )
      : rawError;
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
      code: failure.result.code,
      metadata: { boundary: "operation" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
