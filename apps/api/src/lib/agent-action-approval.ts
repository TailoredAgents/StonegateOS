import { createHash } from "node:crypto";
import {
  canonicalAgentActionJson,
  isAgentActionId,
  isAgentActionType,
  type AgentActionType,
} from "@myst-os/sdk";

export type AgentActionApprovalData = {
  state: "approved";
  approvalId: string;
  approvalToken: string;
  actionId: string;
  actionType: AgentActionType;
  payloadHash: string;
  expectedVersion: string | null;
  actorId: string;
  sessionId: string;
  expiresAt: string;
  consumedByReservationId: string | null;
};

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

export function hashAgentActionPayload(
  actionType: AgentActionType,
  payload: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(canonicalAgentActionJson({ actionType, payload }), "utf8")
    .digest("hex");
}

export function parseStoredAgentActionApproval(
  value: unknown,
): AgentActionApprovalData | null {
  const envelope = record(value);
  const data = record(envelope?.["data"]);
  if (
    envelope?.["ok"] !== true ||
    !data ||
    !hasExactKeys(data, [
      "state",
      "approvalId",
      "approvalToken",
      "actionId",
      "actionType",
      "payloadHash",
      "expectedVersion",
      "actorId",
      "sessionId",
      "expiresAt",
      "consumedByReservationId",
    ]) ||
    data["state"] !== "approved" ||
    typeof data["approvalId"] !== "string" ||
    typeof data["approvalToken"] !== "string" ||
    !isAgentActionId(data["actionId"]) ||
    !isAgentActionType(data["actionType"]) ||
    typeof data["payloadHash"] !== "string" ||
    typeof data["actorId"] !== "string" ||
    typeof data["sessionId"] !== "string" ||
    typeof data["expiresAt"] !== "string" ||
    (data["expectedVersion"] !== null &&
      typeof data["expectedVersion"] !== "string") ||
    (data["consumedByReservationId"] !== null &&
      typeof data["consumedByReservationId"] !== "string")
  ) {
    return null;
  }
  return data as AgentActionApprovalData;
}
