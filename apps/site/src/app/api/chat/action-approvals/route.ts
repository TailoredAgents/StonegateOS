import type { MutationResult } from "@myst-os/sdk";
import {
  AGENT_ACTION_PERMISSIONS,
  isAgentActionId,
  isAgentActionType,
  isAgentIdempotencyKey,
  isAgentVersionedAction,
  isExactAgentRecordVersion,
  parseAgentActionApprovalProof,
  parseAgentActionPayload,
} from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamRequestPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";
import { agentActionTemporaryBlocker } from "@/app/team/lib/agent-action-availability";
import {
  BoundedRequestBodyError,
  readBoundedRequestBytes,
} from "@/app/team/lib/bounded-request";
import { hasTeamPermission } from "@/lib/team-principal";

const MAXIMUM_REQUEST_BYTES = 32 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function failure(
  status: number,
  message: string,
  fieldErrors?: Record<string, string>,
): NextResponse<MutationResult<never>> {
  return NextResponse.json(
    {
      ok: false,
      code:
        status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : status === 409
              ? "conflict"
              : "invalid",
      message,
      retryable: false,
      ...(fieldErrors ? { fieldErrors } : {}),
    },
    { status },
  );
}

function expectedVersionFromRequest(request: NextRequest): string | null {
  let candidate = request.headers.get("if-match")?.trim() ?? "";
  if (candidate.startsWith('W/"') && candidate.endsWith('"')) {
    candidate = candidate.slice(3, -1);
  } else if (candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1);
  }
  return isExactAgentRecordVersion(candidate) ? candidate : null;
}

export async function POST(request: NextRequest): Promise<Response> {
  // Verify the human session before reading attacker-controlled bytes.
  const auth = await requireTeamRequestPrincipal(request, { returnJson: true });
  if (!auth.ok) return auth.response;

  let input: unknown;
  try {
    const bytes = await readBoundedRequestBytes(request, MAXIMUM_REQUEST_BYTES);
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    const oversized =
      error instanceof BoundedRequestBodyError && error.reason === "too_large";
    return failure(
      oversized ? 413 : 422,
      oversized
        ? "The Agent proposal is too large to approve safely."
        : "Send one valid Agent proposal for approval.",
      { request: "Review the displayed proposal and try again." },
    );
  }

  const body = record(input);
  if (
    !body ||
    !exactKeys(body, ["actionType", "actionId", "payload"]) ||
    !isAgentActionType(body["actionType"]) ||
    !isAgentActionId(body["actionId"])
  ) {
    return failure(422, "Choose one exact displayed Agent proposal.");
  }
  const actionType = body["actionType"];
  const actionId = body["actionId"];
  const parsed = parseAgentActionPayload(actionType, body["payload"]);
  if (!parsed.ok) {
    return failure(422, parsed.message, parsed.fieldErrors);
  }
  const temporaryBlocker = agentActionTemporaryBlocker(actionType);
  if (temporaryBlocker) {
    return NextResponse.json(
      {
        ok: false,
        code: "provider_failed",
        message: temporaryBlocker,
        retryable: false,
      } satisfies MutationResult<never>,
      { status: 503 },
    );
  }
  const missing = AGENT_ACTION_PERMISSIONS[actionType].filter(
    (permission) => !hasTeamPermission(auth.principal, permission),
  );
  if (missing.length) {
    return failure(403, "You do not have permission to approve this action.", {
      permission: `Missing: ${missing.join(", ")}`,
    });
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!isAgentIdempotencyKey(idempotencyKey)) {
    return failure(422, "A stable approval key is required.", {
      idempotencyKey: "Review the proposal and approve it again.",
    });
  }
  const payloadVersion = isAgentVersionedAction(actionType)
    ? parsed.payload["expectedVersion"]
    : null;
  const headerVersion = expectedVersionFromRequest(request);
  if (
    (isAgentVersionedAction(actionType) &&
      (!isExactAgentRecordVersion(payloadVersion) ||
        headerVersion !== payloadVersion)) ||
    (!isAgentVersionedAction(actionType) && request.headers.has("if-match"))
  ) {
    return failure(422, "The proposal is not bound to the current version.", {
      version: "Refresh the current record and review the proposal again.",
    });
  }

  try {
    const headers = new Headers({
      "Idempotency-Key": idempotencyKey,
      "X-Correlation-Id": crypto.randomUUID(),
    });
    if (headerVersion) headers.set("If-Match", `"${headerVersion}"`);
    const response = await callAdminApiAs(
      auth.principal,
      "/api/admin/agent/action-approvals",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ actionType, actionId, payload: parsed.payload }),
      },
    );
    const candidate: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(candidate, {
        status: response.status,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          ...(response.headers.get("idempotency-replayed") === "true"
            ? { "idempotency-replayed": "true" }
            : {}),
        },
      });
    }
    const envelope = record(candidate);
    const data = record(envelope?.["data"]);
    const receipt = record(envelope?.["receipt"]);
    const proof = parseAgentActionApprovalProof(
      data
        ? {
            approvalId: data["approvalId"],
            approvalToken: data["approvalToken"],
            expiresAt: data["expiresAt"],
          }
        : null,
    );
    if (
      envelope?.["ok"] !== true ||
      !proof ||
      data?.["actionType"] !== actionType ||
      data["actionId"] !== actionId ||
      data["actorId"] !== auth.principal.memberId ||
      data["sessionId"] !== auth.principal.sessionId ||
      receipt?.["actorId"] !== auth.principal.memberId
    ) {
      return failure(
        502,
        "The approval service returned an unreadable proof. No action was executed.",
      );
    }
    return NextResponse.json(
      {
        ok: true,
        data: { proof },
        receipt: candidate && envelope ? envelope["receipt"] : null,
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          ...(response.headers.get("idempotency-replayed") === "true"
            ? { "idempotency-replayed": "true" }
            : {}),
        },
      },
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "provider_failed",
        message:
          "The approval service could not be reached, so no action was executed.",
        retryable: true,
      } satisfies MutationResult<never>,
      { status: 503 },
    );
  }
}
