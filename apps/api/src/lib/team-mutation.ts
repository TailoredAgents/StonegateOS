import { createHash, randomUUID } from "node:crypto";
import type {
  ActionPolicy,
  MutationErrorCode,
  MutationReceipt,
  MutationResult,
} from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { DatabaseClient } from "@/db";
import { auditLogs, getDb } from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { requirePermission } from "@/lib/permissions";
import {
  getTeamOperationKillSwitchForRisk,
  type TeamOperationKillSwitch,
} from "@/lib/team-operation-kill-switch";
import {
  getVerifiedRequestActor,
  type VerifiedRequestActor,
} from "@/lib/verified-actor-context";

export type TeamMutationTransaction = Parameters<
  DatabaseClient["transaction"]
>[0] extends (tx: infer Transaction) => Promise<unknown>
  ? Transaction
  : never;

type MutationPrincipalType = ActionPolicy["principalTypes"][number];

export type TeamMutationSuccessAuditInput = {
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  providerOperationId?: string | null;
  committedAt?: Date;
};

export type TeamMutationSuccessAuditReceipt = {
  auditEventId: string;
  committedAt: string;
};

export type TeamMutationFailureAuditInput = {
  outcome?: "denied" | "failed";
  entityType: string;
  entityId?: string | null;
  code: MutationErrorCode | "operation_disabled" | "invalid_origin";
  metadata?: Record<string, unknown> | null;
  providerOperationId?: string | null;
  occurredAt?: Date;
};

type TeamMutationFailureAuditEvent = typeof auditLogs.$inferInsert;
export type TeamMutationFailureAuditWriter = (
  event: TeamMutationFailureAuditEvent,
) => Promise<void>;

export type TeamMutationAuditWriter = {
  /**
   * Insert the success event through the caller's transaction. If this write
   * fails, the business mutation must roll back with it.
   */
  insertSuccess(
    tx: TeamMutationTransaction,
    input: TeamMutationSuccessAuditInput,
  ): Promise<TeamMutationSuccessAuditReceipt>;
  /** Co-commit a terminal denied/failed outcome with any reconciliation work. */
  insertFailure?(
    tx: TeamMutationTransaction,
    input: TeamMutationFailureAuditInput,
  ): Promise<TeamMutationSuccessAuditReceipt>;
};

export type TeamMutationContext = {
  policy: ActionPolicy;
  actor: VerifiedRequestActor;
  principalType: MutationPrincipalType;
  operationId: string;
  correlationId: string;
  /** Safe SHA-256 fingerprint. Raw client keys must never be persisted. */
  idempotencyKeyHash: string | null;
  expectedVersion: string | null;
  audit: TeamMutationAuditWriter;
};

export type TeamMutationBoundaryResult =
  | { ok: true; mutation: TeamMutationContext }
  | { ok: false; response: NextResponse<MutationResult<never>> };

export type TeamMutationBoundaryOptions = {
  /**
   * A route may ignore a permission-derived category only when its declared
   * risk remains the authoritative safety boundary. This is intended for
   * non-provider safety actions which share a permission with provider sends.
   */
  ignoredPermissionKillSwitches?: readonly TeamOperationKillSwitch[];
};

type TeamMutationErrorOptions = {
  status?: number;
  retryable?: boolean;
  fieldErrors?: Record<string, string>;
  retryAfter?: string | null;
};

const HIGH_RISK_ACTIONS = new Set<ActionPolicy["risk"]>([
  "external",
  "financial",
  "destructive",
]);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

const DEFAULT_STATUS: Record<MutationErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  invalid: 422,
  rate_limited: 429,
  timeout: 504,
  provider_failed: 502,
  internal: 500,
};

export class TeamMutationFailure extends Error {
  readonly code: MutationErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly fieldErrors?: Record<string, string>;
  readonly retryAfter?: string | null;

  constructor(
    code: MutationErrorCode,
    message: string,
    options: TeamMutationErrorOptions = {},
  ) {
    super(message);
    this.name = "TeamMutationFailure";
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.retryable = options.retryable ?? false;
    this.fieldErrors = options.fieldErrors;
    this.retryAfter = options.retryAfter;
  }
}

function mutationErrorResponse(
  error: TeamMutationFailure,
  correlationId?: string,
): NextResponse<MutationResult<never>> {
  const headers = new Headers();
  if (error.retryAfter) headers.set("Retry-After", error.retryAfter);
  if (correlationId) headers.set("x-correlation-id", correlationId);

  return NextResponse.json(
    {
      ok: false,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    },
    { status: error.status, headers },
  );
}

export function teamMutationErrorResponse(
  code: MutationErrorCode,
  message: string,
  options: TeamMutationErrorOptions & { correlationId?: string } = {},
): NextResponse<MutationResult<never>> {
  return mutationErrorResponse(
    new TeamMutationFailure(code, message, options),
    options.correlationId,
  );
}

export function teamMutationExceptionResponse(
  error: unknown,
  mutation?: Pick<TeamMutationContext, "correlationId">,
): NextResponse<MutationResult<never>> {
  if (error instanceof TeamMutationFailure) {
    return mutationErrorResponse(error, mutation?.correlationId);
  }
  return mutationErrorResponse(
    new TeamMutationFailure(
      "internal",
      "The operation could not be completed. Try again or contact support with the request ID.",
      { retryable: true },
    ),
    mutation?.correlationId,
  );
}

async function permissionFailureResponse(
  response: Response,
): Promise<NextResponse<MutationResult<never>>> {
  let errorName: string | null = null;
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    errorName = typeof body.error === "string" ? body.error : null;
  } catch {
    // Permission failures are deliberately converted to a stable public shape.
  }

  if (response.status === 401) {
    return mutationErrorResponse(
      new TeamMutationFailure(
        "unauthorized",
        "Your team session is missing, expired, or no longer active.",
      ),
    );
  }
  if (response.status === 403) {
    return mutationErrorResponse(
      new TeamMutationFailure(
        "forbidden",
        "You do not have permission to perform this action.",
      ),
    );
  }
  if (response.status === 429) {
    return mutationErrorResponse(
      new TeamMutationFailure(
        "rate_limited",
        "Too many attempts were made. Wait before trying again.",
        {
          retryable: true,
          retryAfter: response.headers.get("retry-after"),
        },
      ),
    );
  }
  if (response.status === 503 && errorName === "operation_disabled") {
    return mutationErrorResponse(
      new TeamMutationFailure(
        "forbidden",
        "This operation is temporarily disabled by a safety control.",
      ),
    );
  }

  return mutationErrorResponse(
    new TeamMutationFailure(
      "internal",
      "Authorization could not be verified. Try again.",
      { retryable: true },
    ),
  );
}

function firstHeaderValue(value: string | null): string | null {
  const normalized = value?.split(",", 1)[0]?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function expectedProtocol(request: NextRequest): string | null {
  const forwarded = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  if (forwarded) return forwarded.toLowerCase().replace(/:$/u, "");

  try {
    return request.nextUrl.protocol.toLowerCase().replace(/:$/u, "");
  } catch {
    return null;
  }
}

function validateSameOrigin(
  request: NextRequest,
  principalType: MutationPrincipalType,
): TeamMutationFailure | null {
  const rawOrigin = request.headers.get("origin")?.trim() ?? "";

  // Named service principals are authenticated with the internal key and a
  // narrow server-owned identity. They are not browser requests, so no Origin
  // is expected. If a service supplies Origin anyway, it must still be valid.
  if (principalType === "service" && rawOrigin.length === 0) return null;
  if (rawOrigin.length === 0 || rawOrigin === "null") {
    return new TeamMutationFailure(
      "forbidden",
      "The request origin could not be verified.",
    );
  }

  const expectedHost = firstHeaderValue(request.headers.get("host"));
  if (!expectedHost) {
    return new TeamMutationFailure(
      "forbidden",
      "The request host could not be verified.",
    );
  }

  try {
    const origin = new URL(rawOrigin);
    const protocol = expectedProtocol(request) ?? origin.protocol.slice(0, -1);
    if (
      (protocol !== "http" && protocol !== "https") ||
      /[@/\\\s]/u.test(expectedHost)
    ) {
      return new TeamMutationFailure(
        "forbidden",
        "The request host could not be verified.",
      );
    }
    const expectedOrigin = new URL(`${protocol}://${expectedHost}`).origin;
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      (origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.origin.toLowerCase() !== expectedOrigin.toLowerCase()
    ) {
      return new TeamMutationFailure(
        "forbidden",
        "The request origin does not match the API host.",
      );
    }
  } catch {
    return new TeamMutationFailure(
      "forbidden",
      "The request origin is malformed.",
    );
  }

  return null;
}

function normalizeIdempotencyKey(rawValue: string | null): string | null {
  if (rawValue === null) return null;
  const value = rawValue.normalize("NFKC").trim();
  return IDEMPOTENCY_KEY_PATTERN.test(value) ? value : null;
}

function hashIdempotencyKey(value: string | null): string | null {
  return value === null
    ? null
    : createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeVersion(rawValue: string | null): string | null {
  if (rawValue === null) return null;
  let value = rawValue.trim();
  if (value.startsWith("W/")) value = value.slice(2).trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }
  if (
    value.length === 0 ||
    value.length > 200 ||
    value.includes(",") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return null;
  }
  return value;
}

function readExpectedVersion(request: NextRequest): {
  value: string | null;
  error: TeamMutationFailure | null;
} {
  const ifMatchHeader = request.headers.get("if-match");
  const explicitHeader = request.headers.get("x-expected-version");
  const ifMatch = normalizeVersion(ifMatchHeader);
  const explicit = normalizeVersion(explicitHeader);

  if (ifMatchHeader !== null && ifMatch === null) {
    return {
      value: null,
      error: new TeamMutationFailure(
        "invalid",
        "If-Match must contain one valid record version.",
        { fieldErrors: { version: "Use the latest record version." } },
      ),
    };
  }
  if (explicitHeader !== null && explicit === null) {
    return {
      value: null,
      error: new TeamMutationFailure(
        "invalid",
        "The expected record version is invalid.",
        { fieldErrors: { version: "Use the latest record version." } },
      ),
    };
  }
  if (ifMatch !== null && explicit !== null && ifMatch !== explicit) {
    return {
      value: null,
      error: new TeamMutationFailure(
        "invalid",
        "If-Match and the expected record version do not agree.",
        { fieldErrors: { version: "Send one matching record version." } },
      ),
    };
  }

  return { value: ifMatch ?? explicit, error: null };
}

function readCorrelationId(request: NextRequest): string {
  const candidate = request.headers.get("x-correlation-id")?.trim() ?? "";
  return CORRELATION_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function principalTypeForActor(
  actor: VerifiedRequestActor,
): MutationPrincipalType {
  return actor.authMethod === "service" ? "service" : "human";
}

function createAuditWriter(
  mutation: Omit<TeamMutationContext, "audit">,
): TeamMutationAuditWriter {
  return {
    async insertSuccess(tx, input) {
      const auditEventId = randomUUID();
      const committedAt = input.committedAt ?? new Date();
      const actorId =
        mutation.principalType === "human" ? (mutation.actor.id ?? null) : null;
      const meta = sanitizeAuditMetadata({
        ...(input.metadata ?? {}),
        eventId: auditEventId,
        correlationId: mutation.correlationId,
        operationId: mutation.operationId,
        sessionId: mutation.actor.sessionId ?? null,
        authMethod: mutation.actor.authMethod,
        requiredPermissions: mutation.policy.requiredPermissions,
        risk: mutation.policy.risk,
        outcome: "succeeded",
        idempotencyKeyHash: mutation.idempotencyKeyHash,
        providerOperationId: input.providerOperationId ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
      });

      await tx.insert(auditLogs).values({
        id: auditEventId,
        actorType: mutation.actor.type,
        actorId,
        actorRole: mutation.actor.role ?? null,
        actorLabel: mutation.actor.label ?? null,
        sessionId: mutation.actor.sessionId ?? null,
        authMethod: mutation.actor.authMethod,
        correlationId: mutation.correlationId,
        requiredPermissions: mutation.policy.requiredPermissions,
        outcome: "succeeded",
        providerOperationId: input.providerOperationId ?? null,
        idempotencyKeyHash: mutation.idempotencyKeyHash,
        action: mutation.policy.auditAction,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        meta,
        createdAt: committedAt,
      });

      return {
        auditEventId,
        committedAt: committedAt.toISOString(),
      };
    },
    async insertFailure(tx, input) {
      const event = failureAuditEvent(mutation, input);
      await tx.insert(auditLogs).values(event);
      return {
        auditEventId: event.id ?? "",
        committedAt: (event.createdAt ?? new Date()).toISOString(),
      };
    },
  };
}

function failureAuditEvent(
  mutation: Omit<TeamMutationContext, "audit">,
  input: TeamMutationFailureAuditInput,
): TeamMutationFailureAuditEvent {
  const eventId = randomUUID();
  const occurredAt = input.occurredAt ?? new Date();
  const outcome = input.outcome ?? "failed";
  const actorId =
    mutation.principalType === "human" ? (mutation.actor.id ?? null) : null;
  const metadata = sanitizeAuditMetadata({
    ...(input.metadata ?? {}),
    eventId,
    correlationId: mutation.correlationId,
    operationId: mutation.operationId,
    sessionId: mutation.actor.sessionId ?? null,
    authMethod: mutation.actor.authMethod,
    requiredPermissions: mutation.policy.requiredPermissions,
    risk: mutation.policy.risk,
    outcome,
    failureCode: input.code,
    idempotencyKeyHash: mutation.idempotencyKeyHash,
    providerOperationId: input.providerOperationId ?? null,
  });

  return {
    id: eventId,
    actorType: mutation.actor.type,
    actorId,
    actorRole: mutation.actor.role ?? null,
    actorLabel: mutation.actor.label ?? null,
    sessionId: mutation.actor.sessionId ?? null,
    authMethod: mutation.actor.authMethod,
    correlationId: mutation.correlationId,
    requiredPermissions: mutation.policy.requiredPermissions,
    outcome,
    providerOperationId: input.providerOperationId ?? null,
    idempotencyKeyHash: mutation.idempotencyKeyHash,
    action: mutation.policy.auditAction,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    meta: metadata,
    createdAt: occurredAt,
  };
}

async function insertFailureAudit(
  event: TeamMutationFailureAuditEvent,
): Promise<void> {
  await getDb().insert(auditLogs).values(event);
}

/**
 * Best-effort evidence for an action which was already denied or failed.
 * This helper never runs the business mutation and never turns audit storage
 * failure into a successful response. Successful mutations continue to use
 * the transaction-bound writer above so an audit failure rolls them back.
 */
export async function recordTeamMutationFailure(
  mutation: Omit<TeamMutationContext, "audit">,
  input: TeamMutationFailureAuditInput,
  writer: TeamMutationFailureAuditWriter = insertFailureAudit,
): Promise<{ recorded: boolean; auditEventId: string | null }> {
  const event = failureAuditEvent(mutation, input);
  try {
    await writer(event);
    return { recorded: true, auditEventId: event.id ?? null };
  } catch {
    return { recorded: false, auditEventId: null };
  }
}

function boundaryMutationContext(
  request: NextRequest,
  policy: ActionPolicy,
): Omit<TeamMutationContext, "audit"> | null {
  const actor = getVerifiedRequestActor(request);
  if (!actor) return null;
  const principalType = principalTypeForActor(actor);
  const complete =
    principalType === "human"
      ? actor.type === "human" && Boolean(actor.id) && Boolean(actor.sessionId)
      : actor.type === "worker" && Boolean(actor.label);
  if (!complete) return null;

  return {
    policy,
    actor,
    principalType,
    operationId: randomUUID(),
    correlationId: readCorrelationId(request),
    idempotencyKeyHash: hashIdempotencyKey(
      normalizeIdempotencyKey(request.headers.get("idempotency-key")),
    ),
    expectedVersion: null,
  };
}

async function recordVerifiedBoundaryFailure(
  request: NextRequest,
  policy: ActionPolicy,
  input: TeamMutationFailureAuditInput,
): Promise<void> {
  const mutation = boundaryMutationContext(request, policy);
  if (!mutation) return;
  await recordTeamMutationFailure(mutation, input);
}

/**
 * Establish the shared boundary before reading params, URL state, request
 * bodies, or opening a database/provider connection.
 */
export async function beginTeamMutation(
  request: NextRequest,
  policy: ActionPolicy,
  options: TeamMutationBoundaryOptions = {},
): Promise<TeamMutationBoundaryResult> {
  if (
    policy.requiredPermissions.length === 0 ||
    policy.principalTypes.length === 0 ||
    policy.auditAction.trim().length === 0
  ) {
    return {
      ok: false,
      response: teamMutationErrorResponse(
        "internal",
        "The server action policy is incomplete.",
      ),
    };
  }

  let permissionError: Response | null;
  try {
    permissionError = await requirePermission(
      request,
      policy.requiredPermissions,
      {
        mode: "all",
        ...(options.ignoredPermissionKillSwitches?.length
          ? { ignoredKillSwitches: options.ignoredPermissionKillSwitches }
          : {}),
      },
    );
  } catch {
    return {
      ok: false,
      response: teamMutationErrorResponse(
        "internal",
        "Authorization could not be verified. Try again.",
        { retryable: true },
      ),
    };
  }
  if (permissionError) {
    const permissionErrorName = await permissionError
      .clone()
      .json()
      .then((body: unknown) =>
        body && typeof body === "object" && "error" in body
          ? String(body.error)
          : "authorization_denied",
      )
      .catch(() => "authorization_denied");
    if (permissionError.status !== 401) {
      await recordVerifiedBoundaryFailure(request, policy, {
        outcome: permissionError.status === 429 ? "failed" : "denied",
        entityType: "team_mutation",
        code:
          permissionErrorName === "operation_disabled"
            ? "operation_disabled"
            : permissionError.status === 429
              ? "rate_limited"
              : "forbidden",
        metadata: {
          boundary: "permission",
          permissionStatus: permissionError.status,
        },
      });
    }
    return {
      ok: false,
      response: await permissionFailureResponse(permissionError),
    };
  }

  const disabledRiskCategory = getTeamOperationKillSwitchForRisk(policy.risk);
  if (disabledRiskCategory) {
    await recordVerifiedBoundaryFailure(request, policy, {
      outcome: "denied",
      entityType: "team_mutation",
      code: "operation_disabled",
      metadata: {
        boundary: "risk_kill_switch",
        category: disabledRiskCategory,
        risk: policy.risk,
      },
    });
    return {
      ok: false,
      response: await permissionFailureResponse(
        NextResponse.json(
          {
            error: "operation_disabled",
            category: disabledRiskCategory,
            retryable: false,
          },
          { status: 503 },
        ),
      ),
    };
  }

  const actor = getVerifiedRequestActor(request);
  if (!actor) {
    return {
      ok: false,
      response: teamMutationErrorResponse(
        "internal",
        "The verified principal could not be resolved.",
        { retryable: true },
      ),
    };
  }

  const principalType = principalTypeForActor(actor);
  const actorIsComplete =
    principalType === "human"
      ? actor.type === "human" && Boolean(actor.id) && Boolean(actor.sessionId)
      : actor.type === "worker" && Boolean(actor.label);
  if (!actorIsComplete) {
    return {
      ok: false,
      response: teamMutationErrorResponse(
        "internal",
        "The verified principal is incomplete.",
      ),
    };
  }
  const boundaryAuditMutation: Omit<TeamMutationContext, "audit"> = {
    policy,
    actor,
    principalType,
    operationId: randomUUID(),
    correlationId: readCorrelationId(request),
    idempotencyKeyHash: hashIdempotencyKey(
      normalizeIdempotencyKey(request.headers.get("idempotency-key")),
    ),
    expectedVersion: null,
  };
  if (!policy.principalTypes.includes(principalType)) {
    await recordTeamMutationFailure(boundaryAuditMutation, {
      outcome: "denied",
      entityType: "team_mutation",
      code: "forbidden",
      metadata: { boundary: "principal_type" },
    });
    return {
      ok: false,
      response: teamMutationErrorResponse(
        "forbidden",
        "This type of principal cannot perform the action.",
      ),
    };
  }

  const originError = validateSameOrigin(request, principalType);
  if (originError) {
    await recordTeamMutationFailure(boundaryAuditMutation, {
      outcome: "denied",
      entityType: "team_mutation",
      code: "invalid_origin",
      metadata: { boundary: "same_origin" },
    });
    return { ok: false, response: mutationErrorResponse(originError) };
  }

  const requiresIdempotency =
    policy.requiresIdempotency || HIGH_RISK_ACTIONS.has(policy.risk);
  const rawIdempotencyKey = request.headers.get("idempotency-key");
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
  if (requiresIdempotency && idempotencyKey === null) {
    await recordTeamMutationFailure(boundaryAuditMutation, {
      entityType: "team_mutation",
      code: "invalid",
      metadata: {
        boundary:
          rawIdempotencyKey === null
            ? "idempotency_key_required"
            : "idempotency_key_malformed",
      },
    });
    return {
      ok: false,
      response: teamMutationErrorResponse(
        "invalid",
        "A valid Idempotency-Key is required for this high-risk action.",
        {
          fieldErrors: {
            idempotencyKey:
              "Use 16–200 letters, numbers, periods, underscores, colons, or hyphens.",
          },
        },
      ),
    };
  }
  if (rawIdempotencyKey !== null && idempotencyKey === null) {
    await recordTeamMutationFailure(boundaryAuditMutation, {
      entityType: "team_mutation",
      code: "invalid",
      metadata: { boundary: "idempotency_key_malformed" },
    });
    return {
      ok: false,
      response: teamMutationErrorResponse(
        "invalid",
        "Idempotency-Key is malformed.",
        { fieldErrors: { idempotencyKey: "Use a stable request key." } },
      ),
    };
  }

  const expectedVersion = readExpectedVersion(request);
  if (expectedVersion.error) {
    await recordTeamMutationFailure(boundaryAuditMutation, {
      entityType: "team_mutation",
      code: "invalid",
      metadata: { boundary: "expected_version" },
    });
    return {
      ok: false,
      response: mutationErrorResponse(expectedVersion.error),
    };
  }

  const mutationWithoutAudit: Omit<TeamMutationContext, "audit"> = {
    policy,
    actor,
    principalType,
    operationId: randomUUID(),
    correlationId: readCorrelationId(request),
    idempotencyKeyHash: hashIdempotencyKey(idempotencyKey),
    expectedVersion: expectedVersion.value,
  };
  const mutation: TeamMutationContext = {
    ...mutationWithoutAudit,
    audit: createAuditWriter(mutationWithoutAudit),
  };

  return { ok: true, mutation };
}

/**
 * Rebind an established mutation to additional permissions already verified
 * from the same request/session. This preserves the operation, correlation,
 * key, and expected-version identity while making the transaction-bound audit
 * record the stronger policy actually required by a data-dependent branch.
 */
export function strengthenTeamMutationPolicy(
  mutation: TeamMutationContext,
  verifiedAdditionalPermissions: ActionPolicy["requiredPermissions"],
): TeamMutationContext {
  const requiredPermissions = [
    ...new Set([
      ...mutation.policy.requiredPermissions,
      ...verifiedAdditionalPermissions,
    ]),
  ];
  const policy: ActionPolicy = {
    ...mutation.policy,
    requiredPermissions,
  };
  const mutationWithoutAudit: Omit<TeamMutationContext, "audit"> = {
    ...mutation,
    policy,
  };
  return {
    ...mutationWithoutAudit,
    audit: createAuditWriter(mutationWithoutAudit),
  };
}

/**
 * Build only the failure side of an audit writer for a permission which an
 * attempted branch required but the actor did not possess. It deliberately
 * does not return a full mutation context, so an unverified permission cannot
 * be used to write a success receipt.
 */
export function createTeamMutationDeniedAuditWriter(
  mutation: TeamMutationContext,
  deniedRequiredPermissions: ActionPolicy["requiredPermissions"],
): NonNullable<TeamMutationAuditWriter["insertFailure"]> {
  const requiredPermissions = [
    ...new Set([
      ...mutation.policy.requiredPermissions,
      ...deniedRequiredPermissions,
    ]),
  ];
  const policy: ActionPolicy = {
    ...mutation.policy,
    requiredPermissions,
  };
  const mutationWithoutAudit: Omit<TeamMutationContext, "audit"> = {
    ...mutation,
    policy,
  };
  const auditWriter = createAuditWriter(mutationWithoutAudit);
  if (!auditWriter.insertFailure) {
    throw new TeamMutationFailure(
      "internal",
      "The denied-action audit writer is unavailable.",
    );
  }
  return (tx, input) => auditWriter.insertFailure!(tx, input);
}

export function assertTeamMutationExpectedVersion(
  mutation: Pick<TeamMutationContext, "expectedVersion">,
  actualVersion: string | number | Date,
): void {
  const expected = mutation.expectedVersion;
  if (expected === null || expected === "*") return;
  const rawActual =
    actualVersion instanceof Date
      ? actualVersion.toISOString()
      : String(actualVersion);
  const actual = normalizeVersion(rawActual);
  if (actual === null || actual !== expected) {
    throw new TeamMutationFailure(
      "conflict",
      "This record changed after it was loaded. Refresh it and try again.",
      {
        fieldErrors: {
          version: "The submitted version is stale.",
        },
      },
    );
  }
}

export function teamMutationSuccessResponse<T>(
  mutation: TeamMutationContext,
  data: T,
  input: Omit<MutationReceipt, "operationId" | "correlationId" | "actorId">,
  status = 200,
): NextResponse<MutationResult<T>> {
  const result = teamMutationSuccessResult(mutation, data, input);
  return teamMutationResultResponse(result, status, mutation.correlationId);
}

export function teamMutationSuccessResult<T>(
  mutation: TeamMutationContext,
  data: T,
  input: Omit<MutationReceipt, "operationId" | "correlationId" | "actorId">,
): Extract<MutationResult<T>, { ok: true }> {
  const actorId =
    mutation.actor.id ??
    (mutation.actor.label ? `service:${mutation.actor.label}` : "unknown");
  const receipt: MutationReceipt = {
    operationId: mutation.operationId,
    correlationId: mutation.correlationId,
    actorId,
    ...input,
  };

  return { ok: true, data, receipt };
}

export function teamMutationResultResponse<T>(
  result: MutationResult<T>,
  status: number,
  correlationId: string,
  headers?: HeadersInit,
): NextResponse<MutationResult<T>> {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("x-correlation-id", correlationId);
  return NextResponse.json(result, {
    status,
    headers: responseHeaders,
  });
}

export type TeamMutationExceptionResult = {
  result: Extract<MutationResult<never>, { ok: false }>;
  status: number;
  retryAfter: string | null;
};

export function teamMutationExceptionResult(
  error: unknown,
): TeamMutationExceptionResult {
  const failure =
    error instanceof TeamMutationFailure
      ? error
      : new TeamMutationFailure(
          "internal",
          "The operation could not be completed. Try again or contact support with the request ID.",
          { retryable: true },
        );
  return {
    result: {
      ok: false,
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      ...(failure.fieldErrors ? { fieldErrors: failure.fieldErrors } : {}),
    },
    status: failure.status,
    retryAfter: failure.retryAfter ?? null,
  };
}
