import { randomUUID } from "node:crypto";
import type { ActionPolicy, TeamPermission } from "@myst-os/sdk";
import {
  AGENT_ACTION_PERMISSIONS,
  isAgentActionId,
  isAgentActionType,
  isAgentVersionedAction,
  parseAgentActionPayload,
  type AgentActionType,
} from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  hashAgentActionPayload,
  parseStoredAgentActionApproval,
  type AgentActionApprovalData,
} from "@/lib/agent-action-approval";
import { requireAgentAuthoritativeAuditAction } from "@/lib/agent-action-authority";
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
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const APPROVAL_LIFETIME_MS = 5 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

async function requireActionPermissions(
  request: NextRequest,
  actionType: AgentActionType,
): Promise<void> {
  const denied = await requirePermission(
    request,
    [...AGENT_ACTION_PERMISSIONS[actionType]] as TeamPermission[],
    { mode: "all" },
  );
  if (!denied) return;
  throw new TeamMutationFailure(
    denied.status === 401 ? "unauthorized" : "forbidden",
    denied.status === 401
      ? "Your team session is no longer active."
      : "You no longer have permission to approve this Agent action.",
    { status: denied.status },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["messages.read"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "agent.action.approved",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    let input: unknown;
    try {
      input = await readBoundedJsonRequest(request, {
        maximumBytes: 32 * 1024,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        throw new TeamMutationFailure("invalid", error.message, {
          status: error.status,
          fieldErrors: {
            request: "Send one bounded application/json action object.",
          },
        });
      }
      throw error;
    }
    const body = record(input);
    if (
      !body ||
      !hasExactKeys(body, ["actionType", "actionId", "payload"]) ||
      !isAgentActionType(body["actionType"]) ||
      !isAgentActionId(body["actionId"])
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose one exact Agent proposal to approve.",
      );
    }
    const actionType = body["actionType"];
    const actionId = body["actionId"];
    const parsed = parseAgentActionPayload(actionType, body["payload"]);
    if (!parsed.ok) {
      throw new TeamMutationFailure("invalid", parsed.message, {
        fieldErrors: parsed.fieldErrors,
      });
    }
    const parsedVersion = parsed.payload["expectedVersion"];
    const expectedVersion = isAgentVersionedAction(actionType)
      ? typeof parsedVersion === "string"
        ? parsedVersion
        : ""
      : null;
    if (
      (isAgentVersionedAction(actionType) &&
        mutation.expectedVersion !== expectedVersion) ||
      (!isAgentVersionedAction(actionType) && mutation.expectedVersion !== null)
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The approved record version does not match If-Match.",
        { fieldErrors: { version: "Refresh and review the current record." } },
      );
    }
    await requireActionPermissions(request, actionType);
    if (!requireAgentAuthoritativeAuditAction(actionType)) {
      throw new TeamMutationFailure(
        "provider_failed",
        "This Agent action is unavailable until its operational endpoint provides authoritative idempotency and audit evidence.",
        { status: 503 },
      );
    }
    const actorId = mutation.actor.id;
    const sessionId = mutation.actor.sessionId;
    if (!actorId || !sessionId) {
      throw new TeamMutationFailure(
        "unauthorized",
        "A complete current team session is required.",
      );
    }
    const hash = hashAgentActionPayload(actionType, parsed.payload);
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/agent/action-approvals",
      entityType: "agent_action_approval",
      entityId: actionId,
      payload: { actionType, actionId, payloadHash: hash, sessionId },
    });
    if (claimed.kind === "replay") {
      const stored = parseStoredAgentActionApproval(claimed.replay.result);
      if (
        !stored ||
        stored.actorId !== actorId ||
        stored.sessionId !== sessionId ||
        stored.actionId !== actionId ||
        stored.actionType !== actionType ||
        stored.payloadHash !== hash ||
        stored.expectedVersion !== expectedVersion
      ) {
        throw new TeamMutationFailure(
          "forbidden",
          "The stored approval does not match this session and proposal.",
        );
      }
      if (Date.parse(stored.expiresAt) <= Date.now()) {
        throw new TeamMutationFailure(
          "conflict",
          "This approval expired. Review the current proposal and approve it again.",
        );
      }
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + APPROVAL_LIFETIME_MS);
    const approvalToken = randomUUID();
    const result = await db.transaction(async (tx) => {
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "agent_action_approval",
        entityId: claimed.claim.id,
        after: {
          actionId,
          actionType,
          expiresAt: expiresAt.toISOString(),
        },
        metadata: {
          surface: "/team/tools/agent",
          approvalOnly: true,
          actionPermissions: [...AGENT_ACTION_PERMISSIONS[actionType]],
        },
        committedAt: now,
      });
      const response = teamMutationSuccessResult<AgentActionApprovalData>(
        mutation,
        {
          state: "approved",
          approvalId: claimed.claim.id,
          approvalToken,
          actionId,
          actionType,
          payloadHash: hash,
          expectedVersion,
          actorId,
          sessionId,
          expiresAt: expiresAt.toISOString(),
          consumedByReservationId: null,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "agent_action_approval",
          entityId: claimed.claim.id,
          ...(expectedVersion ? { version: expectedVersion } : {}),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        response,
        201,
      );
      return response;
    });
    return teamMutationResultResponse(result, 201, mutation.correlationId, {
      "Cache-Control": "private, no-store, max-age=0",
    });
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch {
        // The active claim remains a duplicate barrier until safe reclaim.
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
