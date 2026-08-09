import type { MutationResult } from "@myst-os/sdk";
import {
  AGENT_ACTION_PERMISSIONS,
  AGENT_ACTION_TYPES,
  canonicalAgentActionJson,
  describeAgentOperationalResult,
  isAgentActionId,
  isAgentActionType,
  isAgentIdempotencyKey,
  isAgentVersionedAction,
  isExactAgentRecordVersion,
  parseAgentActionApprovalProof,
  parseAgentActionPayload,
  parseAgentOperationalMutationResult,
  type AgentActionApprovalProof,
  type AgentActionResultDescriptor,
  type AgentActionType,
} from "@myst-os/sdk";

export {
  AGENT_ACTION_PERMISSIONS,
  AGENT_ACTION_TYPES,
  canonicalAgentActionJson,
  describeAgentOperationalResult as describeAgentActionResult,
  isAgentActionId as isAgentApprovalId,
  isAgentActionType,
  isAgentIdempotencyKey,
  isAgentVersionedAction,
  isExactAgentRecordVersion,
  parseAgentActionApprovalProof,
  parseAgentActionPayload,
  parseAgentOperationalMutationResult,
};
export type {
  AgentActionApprovalProof,
  AgentActionResultDescriptor,
  AgentActionType,
};

export type AgentActionMutationData = {
  actionType: AgentActionType;
  result: Record<string, unknown>;
};

export type AgentActionMutationSuccess = Extract<
  MutationResult<AgentActionMutationData>,
  { ok: true }
>;

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

/**
 * The Agent UI accepts success only when the final envelope and its nested
 * operational evidence both match the approving actor, action, entity, and
 * record version. A bare or synthetic 2xx is never rendered as success.
 */
export function parseAgentActionMutationSuccess(
  value: unknown,
  expected: {
    actionType: AgentActionType;
    actorId: string;
    targetEntityId?: string | null;
    expectedVersion?: string | null;
  },
): AgentActionMutationSuccess | null {
  const envelope = record(value);
  if (
    !envelope ||
    !hasExactKeys(envelope, ["data", "ok", "receipt"]) ||
    envelope["ok"] !== true
  ) {
    return null;
  }
  const data = record(envelope["data"]);
  if (
    !data ||
    !hasExactKeys(data, ["actionType", "result"]) ||
    data["actionType"] !== expected.actionType ||
    !record(data["result"])
  ) {
    return null;
  }
  const operational = parseAgentOperationalMutationResult(
    expected.actionType,
    {
      ok: true,
      data: data["result"],
      receipt: envelope["receipt"],
    },
    expected,
  );
  return operational?.ok ? (envelope as AgentActionMutationSuccess) : null;
}
