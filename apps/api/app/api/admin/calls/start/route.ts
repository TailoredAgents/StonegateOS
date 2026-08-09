import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  finalizeManualCallOperation,
  prepareManualCallOperation,
  reconcileManualCallAfterTerminalStorageFailure,
  type FinalizedManualCallOperation,
  type ManualCallAttemptMetadata,
  type PreparedManualCallOperation,
} from "@/lib/manual-call-operations";
import {
  TeamMutationFailure,
  beginTeamMutation,
  recordTeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
} from "@/lib/team-mutation";
import {
  claimTeamMutationIdempotency,
  extendTeamMutationIdempotencyLease,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import { createTwilioOutboundCall } from "@/lib/twilio-calls";
import {
  buildTwilioWebhookUrl,
  getTwilioWebhookPublicBaseUrl,
} from "@/lib/twilio-webhook-auth";

type StartCallPayload = {
  contactId?: string;
  taskId?: string | null;
  agentMemberId?: string | null;
};

function withCallAttemptHeaders(
  response: Response,
  attempt: Partial<ManualCallAttemptMetadata> & {
    state: ManualCallAttemptMetadata["state"];
    newAttempt: ManualCallAttemptMetadata["newAttempt"];
  },
): Response {
  response.headers.set("x-call-attempt-state", attempt.state);
  response.headers.set("x-call-new-attempt", attempt.newAttempt);
  if (attempt.operationId) {
    response.headers.set("x-call-operation-id", attempt.operationId);
  }
  if (attempt.operationVersion) {
    response.headers.set(
      "x-call-operation-version",
      String(attempt.operationVersion),
    );
  }
  return response;
}

function finalizedCallResponse(
  finalized: FinalizedManualCallOperation,
  correlationId: string,
): Response {
  return withCallAttemptHeaders(
    teamMutationResultResponse(
      finalized.result,
      finalized.status,
      correlationId,
    ),
    finalized.callAttempt,
  );
}

function replayCallResponse(
  replay: Parameters<typeof teamMutationIdempotencyReplayResponse>[0],
): Response {
  const result = replay.result as typeof replay.result & {
    callAttempt?: ManualCallAttemptMetadata;
    data?: { callOperationId?: unknown; state?: unknown };
    receipt?: { version?: unknown };
  };
  const response = teamMutationIdempotencyReplayResponse(replay);
  if (result.callAttempt) {
    return withCallAttemptHeaders(response, result.callAttempt);
  }
  if (
    result.ok &&
    typeof result.data?.callOperationId === "string" &&
    Number.isInteger(result.receipt?.version)
  ) {
    return withCallAttemptHeaders(response, {
      operationId: result.data.callOperationId,
      operationVersion: Number(result.receipt?.version),
      state:
        result.data.state === "succeeded"
          ? "succeeded"
          : result.data.state === "failed"
            ? "failed"
            : "active",
      newAttempt: result.data.state === "failed" ? "explicit" : "none",
    });
  }
  return response;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

async function invalidCallRequest(
  mutation: Parameters<typeof recordTeamMutationFailure>[0],
  input: {
    message: string;
    fieldErrors: Record<string, string>;
    entityId?: string | null;
  },
): Promise<Response> {
  await recordTeamMutationFailure(mutation, {
    entityType: input.entityId ? "contact" : "team_call",
    entityId: input.entityId ?? null,
    code: "invalid",
    metadata: { boundary: "input_validation", providerCalled: false },
  });
  return withCallAttemptHeaders(
    teamMutationErrorResponse("invalid", input.message, {
      fieldErrors: input.fieldErrors,
      correlationId: mutation.correlationId,
    }),
    { state: "confirmed_not_sent", newAttempt: "explicit" },
  );
}

function providerUrls(
  publicBaseUrl: string,
  operation: PreparedManualCallOperation,
): { requestUrl: string; statusCallbackUrl: string } {
  const callbackUrl = buildTwilioWebhookUrl(
    "/api/webhooks/twilio/connect",
    publicBaseUrl,
  );
  callbackUrl.searchParams.set("requestKey", operation.providerRequestKey);
  const statusCallbackUrl = buildTwilioWebhookUrl(
    "/api/webhooks/twilio/call-status",
    publicBaseUrl,
  );
  statusCallbackUrl.searchParams.set("leg", "agent");
  statusCallbackUrl.searchParams.set(
    "requestKey",
    operation.providerRequestKey,
  );
  return {
    requestUrl: callbackUrl.toString(),
    statusCallbackUrl: statusCallbackUrl.toString(),
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  // The verified principal, permission, Origin, kill switch, and required
  // caller key are checked before request parsing or database/provider work.
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["calls.place"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "call.started",
  });
  if (!boundary.ok) {
    return withCallAttemptHeaders(boundary.response, {
      state: "confirmed_not_sent",
      newAttempt: "explicit",
    });
  }
  const { mutation } = boundary;

  let parsedJson: unknown;
  try {
    parsedJson = await request.json();
  } catch {
    return invalidCallRequest(mutation, {
      message: "The call request is not valid JSON.",
      fieldErrors: { request: "Send a valid JSON object." },
    });
  }
  if (!isRecord(parsedJson)) {
    return invalidCallRequest(mutation, {
      message: "The call request must be a JSON object.",
      fieldErrors: { request: "Send one valid call object." },
    });
  }
  const json = parsedJson as StartCallPayload;

  const contactId = readString(json.contactId);
  const taskId = readString(json.taskId);
  const requestedAgentMemberId = readString(json.agentMemberId);
  if (!contactId || !isUuid(contactId)) {
    return invalidCallRequest(mutation, {
      message: "A valid contact is required.",
      fieldErrors: { contactId: "Choose a valid contact." },
    });
  }
  if (
    (json.taskId !== undefined &&
      json.taskId !== null &&
      typeof json.taskId !== "string") ||
    (taskId !== null && !isUuid(taskId))
  ) {
    return invalidCallRequest(mutation, {
      message: "The call task is invalid.",
      fieldErrors: { taskId: "Refresh the Sales queue." },
      entityId: contactId,
    });
  }
  if (
    (json.agentMemberId !== undefined &&
      json.agentMemberId !== null &&
      typeof json.agentMemberId !== "string") ||
    (requestedAgentMemberId !== null && !isUuid(requestedAgentMemberId))
  ) {
    return invalidCallRequest(mutation, {
      message: "The selected salesperson is invalid.",
      fieldErrors: { agentMemberId: "Choose an active salesperson." },
      entityId: contactId,
    });
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  let dispatchedOperation: PreparedManualCallOperation | null = null;

  try {
    // Resolve the exact externally configured Twilio signing origin before a
    // durable operation can enter dispatched state.
    const twilioWebhookBaseUrl = getTwilioWebhookPublicBaseUrl();
    const claimResult = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/calls/start",
      entityType: "contact",
      entityId: contactId,
      payload: {
        contactId,
        taskId,
        requestedAgentMemberId,
      },
    });
    if (claimResult.kind === "replay") {
      return replayCallResponse(claimResult.replay);
    }
    claim = claimResult.claim;
    await extendTeamMutationIdempotencyLease(
      db,
      mutation,
      claim,
      2 * 60 * 1_000,
    );

    const prepared = await prepareManualCallOperation({
      db,
      mutation,
      claim,
      contactId,
      taskId,
      requestedAgentMemberId,
    });
    if (prepared.kind === "settled") {
      return finalizedCallResponse(prepared.finalized, mutation.correlationId);
    }
    dispatchedOperation = prepared.operation;

    const urls = providerUrls(twilioWebhookBaseUrl, dispatchedOperation);
    const providerResult = await createTwilioOutboundCall({
      to: dispatchedOperation.agentPhone,
      requestUrl: urls.requestUrl,
      statusCallbackUrl: urls.statusCallbackUrl,
    });

    try {
      const finalized = await finalizeManualCallOperation({
        db,
        mutation,
        claim,
        operationId: dispatchedOperation.id,
        providerResult,
      });
      return finalizedCallResponse(finalized, mutation.correlationId);
    } catch (settlementError) {
      // If the provider may have received work, never release the caller key
      // for automatic redispatch. Quarantine the durable dispatched attempt.
      try {
        const reconciled = await reconcileManualCallAfterTerminalStorageFailure(
          {
            db,
            mutation,
            claim,
            operationId: dispatchedOperation.id,
            providerOperationId: providerResult.ok
              ? providerResult.callSid
              : null,
          },
        );
        return finalizedCallResponse(reconciled, mutation.correlationId);
      } catch {
        await recordTeamMutationFailure(mutation, {
          entityType: "contact",
          entityId: contactId,
          code: "provider_failed",
          providerOperationId: providerResult.ok
            ? providerResult.callSid
            : null,
          metadata: {
            callOperationId: dispatchedOperation.id,
            boundary: "terminal_receipt",
            reconciliationRequired: true,
            providerExactlyOnceClaimed: false,
            settlementErrorName:
              settlementError instanceof Error
                ? settlementError.name
                : "UnknownError",
          },
        });
        return withCallAttemptHeaders(
          teamMutationErrorResponse(
            "provider_failed",
            "The call may have been accepted, but its CRM receipt could not be confirmed. Do not retry; check Twilio activity and reconcile this attempt.",
            {
              retryable: false,
              correlationId: mutation.correlationId,
            },
          ),
          {
            operationId: dispatchedOperation.id,
            operationVersion: dispatchedOperation.version,
            state: "reconciliation_required",
            newAttempt: "blocked",
          },
        );
      }
    }
  } catch (error) {
    // Only pre-dispatch failures may release or terminally store the generic
    // caller claim. A durable dispatched operation is handled above and is
    // never made automatically retryable.
    if (claim && !dispatchedOperation) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "contact",
      entityId: contactId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        boundary: dispatchedOperation ? "post_dispatch" : "pre_dispatch",
        providerCalled: false,
        redispatchAllowed: !dispatchedOperation,
      },
    });
    if (dispatchedOperation) {
      return withCallAttemptHeaders(
        teamMutationErrorResponse(
          "provider_failed",
          "The call dispatch result could not be confirmed. Do not retry; check Twilio activity and reconcile this attempt.",
          { retryable: false, correlationId: mutation.correlationId },
        ),
        {
          operationId: dispatchedOperation.id,
          operationVersion: dispatchedOperation.version,
          state: "reconciliation_required",
          newAttempt: "blocked",
        },
      );
    }
    return withCallAttemptHeaders(
      teamMutationExceptionResponse(error, mutation),
      { state: "confirmed_not_sent", newAttempt: "explicit" },
    );
  }
}
