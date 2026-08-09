import { createHash } from "node:crypto";

export type CallReconciliationKind = "manual" | "sales_escalation";

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  throw new TypeError("Call reconciliation payload must be JSON-compatible.");
}

export function buildCallReconciliationScope(
  kind: CallReconciliationKind,
  operationId: string,
  expectedVersion: number,
): string {
  const prefix = kind === "sales_escalation" ? "sales-call" : "call";
  return `${prefix}-reconcile:${operationId}:v${expectedVersion}`;
}

/**
 * Stable across a refresh for the same operation version and exact evidence.
 * The payload digest allows a corrected request to receive a new identity,
 * while the API independently binds the raw key to its canonical request hash.
 */
export function buildCallReconciliationIdempotencyKey(input: {
  kind: CallReconciliationKind;
  operationId: string;
  expectedVersion: number;
  payload: unknown;
}): string {
  const scope = buildCallReconciliationScope(
    input.kind,
    input.operationId,
    input.expectedVersion,
  );
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(canonicalize(input.payload)), "utf8")
    .digest("hex");
  return `${scope}:${payloadHash}`;
}
