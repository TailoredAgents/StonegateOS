import crypto from "node:crypto";
import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { auditLogs, getDb, paymentAttempts } from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  BoundedJsonRequestError,
  parseJsonRejectingDuplicateObjectKeys,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { isSquarePosEnabled } from "@/lib/payment-feature-flags";
import {
  hashSquareAttemptLaunchBinding,
  isSquareAttemptLaunchBinding,
} from "@/lib/square-attempt-binding";
import {
  isRetryableSquarePosError,
  parseSquarePosCallback,
  verifySquarePosState,
  type SquarePosCallback,
} from "@/lib/square-pos";
import {
  hashSquareReturnNonce,
  reconcileSquareAttempt,
  type SquareAttemptReconciliationResult,
} from "@/lib/square-payments";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  extendTeamMutationIdempotencyLease,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationExceptionResult,
  teamMutationSuccessResult,
  type TeamMutationContext,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const MAXIMUM_RETURN_BODY_BYTES = 20 * 1024;
const MAXIMUM_CALLBACK_VALUE_BYTES = 16 * 1024;
const MAXIMUM_PROVIDER_REFERENCE_BYTES = 500;
const LEGACY_BINDING_CUTOFF = new Date("2026-08-09T00:00:00.000-04:00");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/u;
const IOS_QUERY_KEYS = new Set(["data"]);
const IOS_DATA_KEYS = new Set([
  "status",
  "state",
  "transaction_id",
  "client_transaction_id",
  "error_code",
  "error_description",
]);
const ANDROID_QUERY_KEYS = new Set([
  "com.squareup.pos.SERVER_TRANSACTION_ID",
  "com.squareup.pos.ERROR_CODE",
  "com.squareup.pos.REQUEST_METADATA",
  "com.squareup.pos.CLIENT_TRANSACTION_ID",
  "com.squareup.pos.ERROR_DESCRIPTION",
]);

type SquareReturnStatus =
  | "verified"
  | "pending_verification"
  | "canceled"
  | "failed"
  | "needs_review";

type SquareReturnData = {
  status: SquareReturnStatus;
  appointmentId: string;
  attemptId: string;
  errorCode: string | null;
  retryable: boolean;
};

type SquareReturnResult = MutationResult<SquareReturnData>;
type SquareReturnSuccess = Extract<SquareReturnResult, { ok: true }>;
type SquareReturnFailure = Extract<SquareReturnResult, { ok: false }>;
type SquareReturnPhase =
  | "requested"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "reconciliation_required";

type SquareReturnOperation = {
  version: 1;
  phase: SquareReturnPhase;
  operationId: string;
  correlationId: string;
  callbackHash: string;
  nonceHash: string;
  bindingHash: string | null;
  legacyBinding: boolean;
  memberId: string;
  sessionId: string;
  authMethod: "team_session" | "break_glass";
  providerOrderId: string | null;
  requestedAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  result?: SquareReturnSuccess;
  responseStatus?: 200;
};

type ParsedSquareReturn = {
  callback: SquarePosCallback & { state: string };
  callbackHash: string;
};

type PreparedSquareReturn =
  | {
      kind: "response";
      result: SquareReturnResult;
      status: number;
      replayed: boolean;
    }
  | {
      kind: "execute";
      attempt: AttemptRow;
      operation: SquareReturnOperation;
    };

type AttemptRow = {
  id: string;
  appointmentId: string;
  status: string;
  clientRequestId: string;
  requestedJobAmountCents: number;
  currency: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  squareLocationId: string | null;
  initiatedByMemberId: string | null;
  returnNonceHash: string | null;
  returnStateExpiresAt: Date | null;
  expiresAt: Date;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

const ATTEMPT_SELECTION = {
  id: paymentAttempts.id,
  // This staff POS return route handles appointment attempts only. Quote
  // deposits use the capability-scoped checkout reconciliation path.
  appointmentId: sql<string>`${paymentAttempts.appointmentId}`,
  status: paymentAttempts.status,
  clientRequestId: paymentAttempts.clientRequestId,
  requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
  currency: paymentAttempts.currency,
  providerOrderId: paymentAttempts.providerOrderId,
  providerPaymentId: paymentAttempts.providerPaymentId,
  squareLocationId: paymentAttempts.squareLocationId,
  initiatedByMemberId: paymentAttempts.initiatedByMemberId,
  returnNonceHash: paymentAttempts.returnNonceHash,
  returnStateExpiresAt: paymentAttempts.returnStateExpiresAt,
  expiresAt: paymentAttempts.expiresAt,
  metadata: paymentAttempts.metadata,
  createdAt: paymentAttempts.createdAt,
  updatedAt: paymentAttempts.updatedAt,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): boolean {
  const allowedKeys = new Set(allowed);
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validCallbackValue(value: string, maximumBytes: number): boolean {
  const hasUnsafeControl = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
      codePoint === 127
    );
  });
  return (
    value.length > 0 && byteLength(value) <= maximumBytes && !hasUnsafeControl
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) sorted[key] = canonicalize(item);
    }
    return sorted;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function normalizeErrorCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 200);
  return SAFE_ERROR_CODE_PATTERN.test(normalized) ? normalized : null;
}

export function parseStrictSquareReturnBody(
  value: unknown,
): ParsedSquareReturn {
  if (!isRecord(value) || !hasExactKeys(value, ["query"])) {
    throw new TeamMutationFailure(
      "invalid",
      "The Square return body must contain exactly one callback query.",
    );
  }
  const rawQuery = value["query"];
  if (!isRecord(rawQuery)) {
    throw new TeamMutationFailure("invalid", "The Square callback is invalid.");
  }
  const entries = Object.entries(rawQuery);
  if (entries.length < 1 || entries.length > ANDROID_QUERY_KEYS.size) {
    throw new TeamMutationFailure("invalid", "The Square callback is invalid.");
  }
  const query: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      key.length < 1 ||
      key.length > 100 ||
      typeof item !== "string" ||
      !validCallbackValue(item, MAXIMUM_CALLBACK_VALUE_BYTES)
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The Square callback is invalid.",
      );
    }
    query[key] = item;
  }

  if (Object.hasOwn(query, "data")) {
    if (
      entries.length !== 1 ||
      [...Object.keys(query)].some((key) => !IOS_QUERY_KEYS.has(key))
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The iOS Square callback contains ambiguous fields.",
      );
    }
    let parsed: unknown;
    try {
      parsed = parseJsonRejectingDuplicateObjectKeys(query["data"]!);
    } catch {
      throw new TeamMutationFailure(
        "invalid",
        "The iOS Square callback is invalid.",
      );
    }
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).some((key) => !IOS_DATA_KEYS.has(key)) ||
      !Object.hasOwn(parsed, "state") ||
      !Object.hasOwn(parsed, "status")
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The iOS Square callback is invalid.",
      );
    }
    for (const item of Object.values(parsed)) {
      if (
        item !== null &&
        (typeof item !== "string" ||
          !validCallbackValue(item, MAXIMUM_CALLBACK_VALUE_BYTES))
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "The iOS Square callback is invalid.",
        );
      }
    }
    const status =
      typeof parsed["status"] === "string"
        ? parsed["status"].trim().toLowerCase()
        : "";
    const transactionId =
      typeof parsed["transaction_id"] === "string"
        ? parsed["transaction_id"].trim()
        : "";
    const errorCode =
      typeof parsed["error_code"] === "string"
        ? parsed["error_code"].trim()
        : "";
    if (
      (status !== "ok" && status !== "error") ||
      (status === "ok" && (!transactionId || errorCode)) ||
      (status === "error" && !errorCode)
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The iOS Square callback status is contradictory or incomplete.",
      );
    }
  } else {
    if (Object.keys(query).some((key) => !ANDROID_QUERY_KEYS.has(key))) {
      throw new TeamMutationFailure(
        "invalid",
        "The Android Square callback contains unknown fields.",
      );
    }
    const state = query["com.squareup.pos.REQUEST_METADATA"]?.trim() ?? "";
    const transactionId =
      query["com.squareup.pos.SERVER_TRANSACTION_ID"]?.trim() ?? "";
    const errorCode = query["com.squareup.pos.ERROR_CODE"]?.trim() ?? "";
    if (!state || (!transactionId && !errorCode)) {
      throw new TeamMutationFailure(
        "invalid",
        "The Android Square callback is incomplete.",
      );
    }
  }

  const params = new URLSearchParams();
  for (const [key, item] of Object.entries(query)) params.set(key, item);
  const callback = parseSquarePosCallback(params);
  if (
    !callback?.state ||
    !validCallbackValue(callback.state, 4_096) ||
    (callback.transactionId !== null &&
      !validCallbackValue(
        callback.transactionId,
        MAXIMUM_PROVIDER_REFERENCE_BYTES,
      )) ||
    (callback.clientTransactionId !== null &&
      !validCallbackValue(
        callback.clientTransactionId,
        MAXIMUM_PROVIDER_REFERENCE_BYTES,
      )) ||
    (callback.errorCode !== null &&
      !validCallbackValue(callback.errorCode, 200))
  ) {
    throw new TeamMutationFailure("invalid", "The Square callback is invalid.");
  }
  return {
    callback: { ...callback, state: callback.state },
    callbackHash: sha256(canonicalJson(query)),
  };
}

function squareStateSecret(): string {
  const secret = process.env["SQUARE_POS_STATE_SECRET"]?.trim() ?? "";
  if (byteLength(secret) < 32 || byteLength(secret) > 4_096) {
    throw new TeamMutationFailure(
      "internal",
      "Square payment return verification is not securely configured.",
      { status: 503 },
    );
  }
  return secret;
}

function getStoredOperation(
  metadata: Record<string, unknown> | null,
): SquareReturnOperation | null {
  const operation = metadata?.["squareReturnOperation"];
  if (!isRecord(operation)) return null;
  return operation as SquareReturnOperation;
}

function isSquareReturnSuccess(
  value: unknown,
  attempt: Pick<AttemptRow, "id" | "appointmentId">,
): value is SquareReturnSuccess {
  if (!isRecord(value) || value["ok"] !== true) return false;
  const data = value["data"];
  const receipt = value["receipt"];
  if (!isRecord(data) || !isRecord(receipt)) return false;
  return (
    [
      "verified",
      "pending_verification",
      "canceled",
      "failed",
      "needs_review",
    ].includes(String(data["status"])) &&
    data["appointmentId"] === attempt.appointmentId &&
    data["attemptId"] === attempt.id &&
    (data["errorCode"] === null ||
      (typeof data["errorCode"] === "string" &&
        SAFE_ERROR_CODE_PATTERN.test(data["errorCode"]))) &&
    typeof data["retryable"] === "boolean" &&
    typeof receipt["operationId"] === "string" &&
    UUID_PATTERN.test(receipt["operationId"]) &&
    typeof receipt["correlationId"] === "string" &&
    receipt["correlationId"].length >= 8 &&
    typeof receipt["actorId"] === "string" &&
    UUID_PATTERN.test(receipt["actorId"]) &&
    typeof receipt["committedAt"] === "string" &&
    Number.isFinite(Date.parse(receipt["committedAt"])) &&
    typeof receipt["auditEventId"] === "string" &&
    UUID_PATTERN.test(receipt["auditEventId"]) &&
    receipt["entityType"] === "payment_attempt" &&
    receipt["entityId"] === attempt.id &&
    typeof receipt["version"] === "string" &&
    Number.isFinite(Date.parse(receipt["version"]))
  );
}

export function squareReturnOperationIdentityMatches(
  operation: SquareReturnOperation,
  input: {
    callbackHash: string;
    nonceHash: string;
    bindingHash: string | null;
    legacyBinding: boolean;
    memberId: string;
    sessionId: string;
    authMethod: "team_session" | "break_glass";
    providerOrderId: string | null;
  },
): boolean {
  return (
    operation.version === 1 &&
    safeEqual(operation.callbackHash, input.callbackHash) &&
    safeEqual(operation.nonceHash, input.nonceHash) &&
    operation.bindingHash === input.bindingHash &&
    operation.legacyBinding === input.legacyBinding &&
    operation.memberId === input.memberId &&
    operation.sessionId === input.sessionId &&
    operation.authMethod === input.authMethod &&
    operation.providerOrderId === input.providerOrderId
  );
}

function sanitizedAttemptMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> {
  const safe = { ...(metadata ?? {}) };
  delete safe["squareReturnState"];
  delete safe["launchUrl"];
  return safe;
}

function squareReturnResponse(
  result: SquareReturnResult,
  status: number,
  correlationId: string,
  options: { replayed?: boolean; retryAfter?: string | null } = {},
): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    "x-correlation-id": correlationId,
  });
  if (options.replayed) headers.set("idempotency-replayed", "true");
  if (options.retryAfter) headers.set("Retry-After", options.retryAfter);
  return new Response(canonicalJson(result), { status, headers });
}

async function insertAttemptedAudit(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  attempt: AttemptRow,
  metadata: Record<string, unknown>,
): Promise<void> {
  const eventId = crypto.randomUUID();
  await tx.insert(auditLogs).values({
    id: eventId,
    actorType: mutation.actor.type,
    actorId: mutation.actor.id,
    actorRole: mutation.actor.role ?? null,
    actorLabel: mutation.actor.label ?? null,
    sessionId: mutation.actor.sessionId,
    authMethod: mutation.actor.authMethod,
    correlationId: mutation.correlationId,
    requiredPermissions: mutation.policy.requiredPermissions,
    outcome: "attempted",
    surface: "mobile/payment-return",
    providerOperationId: null,
    idempotencyKeyHash: mutation.idempotencyKeyHash,
    action: mutation.policy.auditAction,
    entityType: "payment_attempt",
    entityId: attempt.id,
    meta: sanitizeAuditMetadata({
      eventId,
      operationId: mutation.operationId,
      correlationId: mutation.correlationId,
      appointmentId: attempt.appointmentId,
      sessionId: mutation.actor.sessionId,
      authMethod: mutation.actor.authMethod,
      requiredPermissions: mutation.policy.requiredPermissions,
      risk: mutation.policy.risk,
      outcome: "attempted",
      ...metadata,
    }),
    createdAt: new Date(),
  });
}

async function completeClaimedFailure(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  input: {
    attemptId: string;
    appointmentId?: string;
    result: SquareReturnFailure;
    status: number;
    metadata?: Record<string, unknown>;
  },
): Promise<{ result: SquareReturnFailure; status: number }> {
  if (!mutation.audit.insertFailure) {
    throw new TeamMutationFailure(
      "internal",
      "The financial failure audit boundary is unavailable.",
      { retryable: true },
    );
  }
  await mutation.audit.insertFailure(tx, {
    outcome: input.result.code === "forbidden" ? "denied" : "failed",
    entityType: "payment_attempt",
    entityId: input.attemptId,
    code: input.result.code,
    metadata: {
      appointmentId: input.appointmentId ?? null,
      responseStatus: input.status,
      ...(input.metadata ?? {}),
    },
  });
  await completeTeamMutationIdempotency(
    tx,
    mutation,
    claim,
    input.result,
    input.status,
  );
  return { result: input.result, status: input.status };
}

async function finalizeReturn(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  attempt: AttemptRow,
  operation: SquareReturnOperation,
  input: {
    phase: Exclude<SquareReturnPhase, "requested" | "dispatched">;
    data: SquareReturnData;
    providerOperationId?: string | null;
  },
): Promise<SquareReturnSuccess> {
  if (!mutation.audit.insertFailure) {
    throw new TeamMutationFailure(
      "internal",
      "The financial outcome audit boundary is unavailable.",
      { retryable: true },
    );
  }
  const committedAt = new Date(
    Math.max(Date.now(), attempt.updatedAt.getTime() + 1),
  );
  const auditInput = {
    entityType: "payment_attempt",
    entityId: attempt.id,
    providerOperationId: input.providerOperationId ?? null,
    committedAt,
    metadata: {
      appointmentId: attempt.appointmentId,
      returnStatus: input.data.status,
      errorCode: input.data.errorCode,
      callbackHash: operation.callbackHash,
      bindingHash: operation.bindingHash,
      legacyBinding: operation.legacyBinding,
      externalEffectPhase: input.phase,
    },
  };
  const auditReceipt =
    input.phase === "succeeded"
      ? await mutation.audit.insertSuccess(tx, auditInput)
      : await mutation.audit.insertFailure(tx, {
          outcome: "failed",
          entityType: auditInput.entityType,
          entityId: auditInput.entityId,
          code: "provider_failed",
          providerOperationId: auditInput.providerOperationId,
          occurredAt: committedAt,
          metadata: auditInput.metadata,
        });
  const result = teamMutationSuccessResult<SquareReturnData>(
    mutation,
    input.data,
    {
      ...auditReceipt,
      entityType: "payment_attempt",
      entityId: attempt.id,
      version: committedAt.toISOString(),
      ...(input.providerOperationId
        ? { providerOperationId: input.providerOperationId }
        : {}),
    },
  );
  const terminalOperation: SquareReturnOperation = {
    ...operation,
    phase: input.phase,
    completedAt: committedAt.toISOString(),
    result,
    responseStatus: 200,
  };
  const [updated] = await tx
    .update(paymentAttempts)
    .set({
      returnNonceHash: null,
      metadata: {
        ...sanitizedAttemptMetadata(attempt.metadata),
        squareReturnOperation: terminalOperation,
      },
      updatedAt: committedAt,
    })
    .where(eq(paymentAttempts.id, attempt.id))
    .returning({ id: paymentAttempts.id });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The Square attempt changed before its return receipt committed.",
      { retryable: true },
    );
  }
  await completeTeamMutationIdempotency(tx, mutation, claim, result, 200);
  return result;
}

function validateAttemptBinding(input: {
  attempt: AttemptRow;
  callback: ParsedSquareReturn["callback"];
  state: NonNullable<ReturnType<typeof verifySquarePosState>>;
  mutation: TeamMutationContext;
  now: Date;
}): { bindingHash: string | null; legacyBinding: boolean } {
  const { attempt, callback, state, mutation, now } = input;
  if (
    !mutation.actor.id ||
    !mutation.actor.sessionId ||
    !UUID_PATTERN.test(mutation.actor.id) ||
    !UUID_PATTERN.test(mutation.actor.sessionId) ||
    (mutation.actor.authMethod !== "team_session" &&
      mutation.actor.authMethod !== "break_glass")
  ) {
    throw new TeamMutationFailure(
      "internal",
      "The verified Square return session is incomplete.",
    );
  }
  if (attempt.initiatedByMemberId !== mutation.actor.id) {
    throw new TeamMutationFailure(
      "forbidden",
      "This Square return belongs to a different staff member.",
    );
  }
  if (
    !attempt.returnStateExpiresAt ||
    attempt.returnStateExpiresAt.getTime() < now.getTime() ||
    attempt.expiresAt.getTime() < now.getTime()
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This Square return has expired. Review the attempt before trying again.",
    );
  }

  const launchBinding = attempt.metadata?.["launchBinding"];
  const launchBindingHash = attempt.metadata?.["launchBindingHash"];
  if (
    isSquareAttemptLaunchBinding(launchBinding) &&
    typeof launchBindingHash === "string" &&
    /^[0-9a-f]{64}$/u.test(launchBindingHash)
  ) {
    const calculated = hashSquareAttemptLaunchBinding(launchBinding);
    if (
      !state.bindingHash ||
      !safeEqual(calculated, launchBindingHash) ||
      !safeEqual(state.bindingHash, launchBindingHash) ||
      launchBinding.platform !== callback.platform ||
      launchBinding.amountCents !== attempt.requestedJobAmountCents ||
      attempt.currency !== "USD" ||
      launchBinding.appointmentId !== attempt.appointmentId ||
      launchBinding.attemptId !== attempt.id ||
      launchBinding.clientRequestId !== attempt.clientRequestId ||
      launchBinding.memberId !== mutation.actor.id ||
      launchBinding.sessionId !== mutation.actor.sessionId ||
      launchBinding.authMethod !== mutation.actor.authMethod ||
      launchBinding.expiresAt !== attempt.returnStateExpiresAt.toISOString() ||
      launchBinding.expiresAt !== attempt.expiresAt.toISOString() ||
      state.expiresAt.toISOString() !== launchBinding.expiresAt
    ) {
      throw new TeamMutationFailure(
        "forbidden",
        "The Square return is not bound to this exact launch and session.",
      );
    }
    return { bindingHash: launchBindingHash, legacyBinding: false };
  }

  const legacyPlatform = attempt.metadata?.["platform"];
  if (
    attempt.createdAt.getTime() >= LEGACY_BINDING_CUTOFF.getTime() ||
    state.bindingHash !== undefined ||
    (legacyPlatform !== "ios" && legacyPlatform !== "android") ||
    legacyPlatform !== callback.platform
  ) {
    throw new TeamMutationFailure(
      "forbidden",
      "This unbound Square return cannot be accepted.",
    );
  }
  return { bindingHash: null, legacyBinding: true };
}

function reconciliationData(
  result: SquareAttemptReconciliationResult,
): SquareReturnData {
  return {
    status: result.status,
    appointmentId: result.appointmentId,
    attemptId: result.attemptId,
    errorCode:
      result.status === "verified"
        ? null
        : (normalizeErrorCode(result.errorCode) ??
          "square_verification_failed"),
    retryable: false,
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["payments.collect"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "team_api.payments.square.return.post",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;

  let database: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  let terminalHandled = false;
  let providerDispatchStarted = false;
  try {
    if (
      !mutation.actor.id ||
      !mutation.actor.sessionId ||
      !UUID_PATTERN.test(mutation.actor.id) ||
      !UUID_PATTERN.test(mutation.actor.sessionId) ||
      (mutation.actor.authMethod !== "team_session" &&
        mutation.actor.authMethod !== "break_glass")
    ) {
      throw new TeamMutationFailure(
        "internal",
        "The verified Square return session is incomplete.",
      );
    }
    if (request.nextUrl.search.length > 0) {
      throw new TeamMutationFailure(
        "invalid",
        "Square return requests do not accept API query parameters.",
      );
    }
    if (!isSquarePosEnabled()) {
      throw new TeamMutationFailure(
        "forbidden",
        "Square payment collection is temporarily unavailable.",
        { status: 503 },
      );
    }

    let body: unknown;
    try {
      body = await readBoundedJsonRequest(request, {
        maximumBytes: MAXIMUM_RETURN_BODY_BYTES,
        deadlineMs: 8_000,
        rejectDuplicateObjectKeys: true,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        throw new TeamMutationFailure(
          error.code === "body_timeout" ? "timeout" : "invalid",
          error.message,
          {
            status: error.status,
            retryable: error.code === "body_timeout",
          },
        );
      }
      throw error;
    }
    const parsed = parseStrictSquareReturnBody(body);
    const state = verifySquarePosState({
      state: parsed.callback.state,
      secret: squareStateSecret(),
    });
    if (!state) {
      throw new TeamMutationFailure(
        "invalid",
        "The Square return state is invalid or expired.",
      );
    }

    database = getDb();
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/payments/square/return",
      entityType: "payment_attempt",
      entityId: state.attemptId,
      payload: {
        callbackHash: parsed.callbackHash,
        stateBindingHash: state.bindingHash ?? null,
      },
    });
    if (claimed.kind === "replay") {
      return squareReturnResponse(
        claimed.replay.result as SquareReturnResult,
        claimed.replay.status,
        claimed.replay.correlationId,
        { replayed: true },
      );
    }
    claim = claimed.claim;
    const nonceHash = hashSquareReturnNonce(state.nonce);
    const now = new Date();

    const prepared = await database.transaction(
      async (tx): Promise<PreparedSquareReturn> => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('square_payment_attempt'), hashtext(${state.attemptId}))`,
        );
        const [attempt] = await tx
          .select(ATTEMPT_SELECTION)
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.id, state.attemptId),
              eq(paymentAttempts.provider, "square"),
            ),
          )
          .for("update")
          .limit(1);
        if (!attempt) {
          const completed = await completeClaimedFailure(
            tx,
            mutation,
            claimed.claim,
            {
              attemptId: state.attemptId,
              result: {
                ok: false,
                code: "invalid",
                message: "The Square payment attempt no longer exists.",
                retryable: false,
              },
              status: 404,
            },
          );
          return { kind: "response", ...completed, replayed: false };
        }
        if (!attempt.appointmentId) {
          const completed = await completeClaimedFailure(
            tx,
            mutation,
            claimed.claim,
            {
              attemptId: attempt.id,
              result: {
                ok: false,
                code: "conflict",
                message:
                  "Quote deposits must be reconciled through the quote checkout flow.",
                retryable: false,
              },
              status: 409,
              metadata: { boundary: "payment_attempt_purpose" },
            },
          );
          return { kind: "response", ...completed, replayed: false };
        }

        let binding: { bindingHash: string | null; legacyBinding: boolean };
        try {
          binding = validateAttemptBinding({
            attempt,
            callback: parsed.callback,
            state,
            mutation,
            now,
          });
        } catch (error) {
          const failure = teamMutationExceptionResult(error);
          const completed = await completeClaimedFailure(
            tx,
            mutation,
            claimed.claim,
            {
              attemptId: attempt.id,
              appointmentId: attempt.appointmentId,
              result: failure.result,
              status: failure.status,
              metadata: { boundary: "launch_binding" },
            },
          );
          return { kind: "response", ...completed, replayed: false };
        }

        const identity = {
          callbackHash: parsed.callbackHash,
          nonceHash,
          bindingHash: binding.bindingHash,
          legacyBinding: binding.legacyBinding,
          memberId: mutation.actor.id!,
          sessionId: mutation.actor.sessionId!,
          authMethod: mutation.actor.authMethod as
            | "team_session"
            | "break_glass",
          providerOrderId: parsed.callback.transactionId,
        };
        const storedOperation = getStoredOperation(attempt.metadata);
        if (
          parsed.callback.transactionId &&
          attempt.providerOrderId &&
          attempt.providerOrderId !== parsed.callback.transactionId
        ) {
          const completed = await completeClaimedFailure(
            tx,
            mutation,
            claimed.claim,
            {
              attemptId: attempt.id,
              appointmentId: attempt.appointmentId,
              result: {
                ok: false,
                code: "conflict",
                message:
                  "The Square callback order does not match the order already bound to this attempt.",
                retryable: false,
              },
              status: 409,
              metadata: { boundary: "provider_order_binding" },
            },
          );
          return { kind: "response", ...completed, replayed: false };
        }
        if (storedOperation) {
          if (
            !squareReturnOperationIdentityMatches(storedOperation, identity)
          ) {
            const completed = await completeClaimedFailure(
              tx,
              mutation,
              claimed.claim,
              {
                attemptId: attempt.id,
                appointmentId: attempt.appointmentId,
                result: {
                  ok: false,
                  code: "conflict",
                  message:
                    "This Square state was already used with a different callback or session.",
                  retryable: false,
                },
                status: 409,
                metadata: { boundary: "callback_replay_mismatch" },
              },
            );
            return { kind: "response", ...completed, replayed: false };
          }
          if (
            ["succeeded", "failed", "reconciliation_required"].includes(
              storedOperation.phase,
            )
          ) {
            if (!isSquareReturnSuccess(storedOperation.result, attempt)) {
              throw new TeamMutationFailure(
                "internal",
                "The original Square return receipt is incomplete. Contact support before retrying.",
              );
            }
            await insertAttemptedAudit(tx, mutation, attempt, {
              callbackHash: parsed.callbackHash,
              replayed: true,
              originalOperationId: storedOperation.operationId,
            });
            await completeTeamMutationIdempotency(
              tx,
              mutation,
              claimed.claim,
              storedOperation.result,
              200,
            );
            return {
              kind: "response",
              result: storedOperation.result,
              status: 200,
              replayed: true,
            };
          }
          if (storedOperation.phase === "dispatched") {
            const reconciliationRequired: SquareReturnData = {
              status: "pending_verification",
              appointmentId: attempt.appointmentId,
              attemptId: attempt.id,
              errorCode: "square_return_reconciliation_required",
              retryable: false,
            };
            await insertAttemptedAudit(tx, mutation, attempt, {
              callbackHash: parsed.callbackHash,
              recoveredAfterDispatch: true,
              abandonedOperationId: storedOperation.operationId,
            });
            const takeover: SquareReturnOperation = {
              ...storedOperation,
              operationId: mutation.operationId,
              correlationId: mutation.correlationId,
            };
            await tx
              .update(paymentAttempts)
              .set({
                status: "pending_verification",
                errorCode: "square_return_reconciliation_required",
                errorMessage: null,
                resolvedAt: null,
              })
              .where(eq(paymentAttempts.id, attempt.id));
            const refreshedAttempt: AttemptRow = {
              ...attempt,
              status: "pending_verification",
            };
            const result = await finalizeReturn(
              tx,
              mutation,
              claimed.claim,
              refreshedAttempt,
              takeover,
              {
                phase: "reconciliation_required",
                data: reconciliationRequired,
                providerOperationId: storedOperation.providerOrderId,
              },
            );
            return {
              kind: "response",
              result,
              status: 200,
              replayed: false,
            };
          }
        }

        if (
          !storedOperation &&
          !["launched", "pending_verification", "completed"].includes(
            attempt.status,
          )
        ) {
          const completed = await completeClaimedFailure(
            tx,
            mutation,
            claimed.claim,
            {
              attemptId: attempt.id,
              appointmentId: attempt.appointmentId,
              result: {
                ok: false,
                code: "conflict",
                message:
                  "This Square attempt is not in a returnable state. Review it before retrying.",
                retryable: false,
              },
              status: 409,
              metadata: {
                boundary: "attempt_status",
                attemptStatus: attempt.status,
              },
            },
          );
          return { kind: "response", ...completed, replayed: false };
        }

        if (storedOperation?.phase !== "requested") {
          if (
            !attempt.returnNonceHash ||
            !safeEqual(attempt.returnNonceHash, nonceHash)
          ) {
            const completed = await completeClaimedFailure(
              tx,
              mutation,
              claimed.claim,
              {
                attemptId: attempt.id,
                appointmentId: attempt.appointmentId,
                result: {
                  ok: false,
                  code: "conflict",
                  message:
                    "This Square return state has already been consumed or does not match the attempt.",
                  retryable: false,
                },
                status: 409,
                metadata: { boundary: "return_nonce" },
              },
            );
            return { kind: "response", ...completed, replayed: false };
          }
        }

        const requestedAt = new Date().toISOString();
        const operation: SquareReturnOperation = {
          version: 1,
          phase: "requested",
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          ...identity,
          requestedAt,
        };
        await insertAttemptedAudit(tx, mutation, attempt, {
          callbackHash: parsed.callbackHash,
          bindingHash: binding.bindingHash,
          legacyBinding: binding.legacyBinding,
          callbackPlatform: parsed.callback.platform,
          providerOrderPresent: parsed.callback.transactionId !== null,
          resumedRequestedOperation: storedOperation?.phase === "requested",
        });
        const [consumed] = await tx
          .update(paymentAttempts)
          .set({
            returnNonceHash: null,
            providerOrderId:
              parsed.callback.transactionId ?? attempt.providerOrderId,
            metadata: {
              ...sanitizedAttemptMetadata(attempt.metadata),
              squareReturnOperation: operation,
            },
            updatedAt: new Date(),
          })
          .where(
            storedOperation?.phase === "requested"
              ? eq(paymentAttempts.id, attempt.id)
              : and(
                  eq(paymentAttempts.id, attempt.id),
                  eq(paymentAttempts.returnNonceHash, attempt.returnNonceHash!),
                ),
          )
          .returning({ id: paymentAttempts.id });
        if (!consumed) {
          throw new TeamMutationFailure(
            "conflict",
            "The Square return was consumed concurrently. Review the attempt before retrying.",
            { retryable: true },
          );
        }
        return { kind: "execute", attempt, operation };
      },
    );

    if (prepared.kind === "response") {
      terminalHandled = true;
      return squareReturnResponse(
        prepared.result,
        prepared.status,
        prepared.result.ok
          ? prepared.result.receipt.correlationId
          : mutation.correlationId,
        { replayed: prepared.replayed },
      );
    }

    const { attempt, operation } = prepared;
    const retryableWithoutTransaction =
      parsed.callback.status === "error" &&
      !parsed.callback.transactionId &&
      !attempt.providerOrderId &&
      !attempt.providerPaymentId &&
      isRetryableSquarePosError(parsed.callback.errorCode);
    if (!parsed.callback.transactionId) {
      const result = await database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('square_payment_attempt'), hashtext(${attempt.id}))`,
        );
        const [locked] = await tx
          .select(ATTEMPT_SELECTION)
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, attempt.id))
          .for("update")
          .limit(1);
        const current = getStoredOperation(locked?.metadata ?? null);
        if (
          !locked ||
          !current ||
          current.phase !== "requested" ||
          current.operationId !== operation.operationId ||
          current.callbackHash !== operation.callbackHash ||
          current.providerOrderId !== null
        ) {
          throw new TeamMutationFailure(
            "conflict",
            "The Square return changed before it could be recorded.",
            { retryable: true },
          );
        }
        const errorCode =
          normalizeErrorCode(parsed.callback.errorCode) ??
          (retryableWithoutTransaction
            ? "square_pos_error"
            : "square_transaction_id_missing");
        const normalizedCallbackError =
          parsed.callback.errorCode?.trim().toLowerCase() ?? "";
        const canceled =
          normalizedCallbackError === "payment_canceled" ||
          normalizedCallbackError === "transaction_canceled";
        const data: SquareReturnData = {
          status: retryableWithoutTransaction
            ? canceled
              ? "canceled"
              : "failed"
            : "pending_verification",
          appointmentId: locked.appointmentId,
          attemptId: locked.id,
          errorCode,
          retryable: retryableWithoutTransaction,
        };
        const updatedAt = new Date();
        await tx
          .update(paymentAttempts)
          .set({
            status: retryableWithoutTransaction
              ? "retryable"
              : "pending_verification",
            errorCode,
            errorMessage: null,
            resolvedAt: retryableWithoutTransaction ? updatedAt : null,
            updatedAt,
          })
          .where(eq(paymentAttempts.id, locked.id));
        return finalizeReturn(tx, mutation, claimed.claim, locked, operation, {
          phase: retryableWithoutTransaction
            ? "failed"
            : "reconciliation_required",
          data,
        });
      });
      terminalHandled = true;
      return squareReturnResponse(result, 200, result.receipt.correlationId);
    }

    await database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('square_payment_attempt'), hashtext(${attempt.id}))`,
      );
      const [locked] = await tx
        .select(ATTEMPT_SELECTION)
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, attempt.id))
        .for("update")
        .limit(1);
      const current = getStoredOperation(locked?.metadata ?? null);
      if (
        !locked ||
        !current ||
        current.phase !== "requested" ||
        current.operationId !== operation.operationId ||
        current.callbackHash !== operation.callbackHash ||
        current.providerOrderId !== parsed.callback.transactionId
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "The Square return changed before provider verification began.",
          { retryable: true },
        );
      }
      const dispatched: SquareReturnOperation = {
        ...current,
        phase: "dispatched",
        dispatchedAt: new Date().toISOString(),
      };
      await tx
        .update(paymentAttempts)
        .set({
          status: "pending_verification",
          providerOrderId: parsed.callback.transactionId,
          errorCode: normalizeErrorCode(parsed.callback.errorCode),
          errorMessage: null,
          resolvedAt: null,
          metadata: {
            ...sanitizedAttemptMetadata(locked.metadata),
            squareReturnOperation: dispatched,
          },
          updatedAt: new Date(),
        })
        .where(eq(paymentAttempts.id, locked.id));
    });
    providerDispatchStarted = true;

    await extendTeamMutationIdempotencyLease(
      database,
      mutation,
      claimed.claim,
      120_000,
    );
    const finalizedResult: { value: SquareReturnSuccess | null } = {
      value: null,
    };
    const reconciled = await reconcileSquareAttempt({
      attemptId: attempt.id,
      orderId: parsed.callback.transactionId,
      expectedReturnOperation: {
        operationId: operation.operationId,
        callbackHash: operation.callbackHash,
        providerOrderId: parsed.callback.transactionId,
      },
      finalize: async (tx, reconciliation) => {
        const [locked] = await tx
          .select(ATTEMPT_SELECTION)
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, attempt.id))
          .limit(1);
        if (!locked) throw new Error("payment_attempt_not_found");
        const current = getStoredOperation(locked.metadata);
        if (
          !current ||
          current.phase !== "dispatched" ||
          current.operationId !== operation.operationId ||
          current.callbackHash !== operation.callbackHash ||
          current.providerOrderId !== parsed.callback.transactionId
        ) {
          throw new TeamMutationFailure(
            "conflict",
            "The Square return operation changed before reconciliation committed.",
            { retryable: true },
          );
        }
        const data = reconciliationData(reconciliation);
        finalizedResult.value = await finalizeReturn(
          tx,
          mutation,
          claimed.claim,
          locked,
          current,
          {
            phase:
              reconciliation.status === "verified"
                ? "succeeded"
                : "reconciliation_required",
            data,
            providerOperationId: parsed.callback.transactionId,
          },
        );
      },
    });
    if (!finalizedResult.value) {
      throw new TeamMutationFailure(
        "internal",
        "Square reconciliation ended without a durable return receipt.",
        { retryable: true },
      );
    }
    terminalHandled = true;
    void reconciled;
    return squareReturnResponse(
      finalizedResult.value,
      200,
      finalizedResult.value.receipt.correlationId,
    );
  } catch (error) {
    if (database && claim && !terminalHandled) {
      await settleTeamMutationIdempotencyFailure(
        database,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    const failure = teamMutationExceptionResult(error);
    if (!terminalHandled) {
      await recordTeamMutationFailure(mutation, {
        outcome: failure.result.code === "forbidden" ? "denied" : "failed",
        entityType: "payment_attempt",
        code: failure.result.code,
        metadata: {
          boundary: "square_return",
          responseStatus: failure.status,
          providerDispatchMayHaveStarted: providerDispatchStarted,
        },
      });
    }
    return squareReturnResponse(
      failure.result,
      failure.status,
      mutation.correlationId,
      { retryAfter: failure.retryAfter },
    );
  }
}
