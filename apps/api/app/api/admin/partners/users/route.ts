import { randomUUID } from "node:crypto";
import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  auditLogs,
  contacts,
  getDb,
  partnerInviteOperations,
  partnerLoginTokens,
  partnerSessions,
  partnerUsers,
} from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import {
  getClientIp,
  getUserAgent,
  normalizeEmail,
  normalizePhoneE164,
  replacePartnerLoginTokenInTransaction,
  resolvePublicSiteBaseUrl,
} from "@/lib/partner-portal-auth";
import {
  type PartnerInviteChannel,
  type PartnerInviteDeliverySummary,
  type PartnerInviteProviderEvidence,
} from "@/lib/partner-invite-delivery";
import {
  buildPartnerInviteOperationAuditRecord,
  capturePartnerInviteProviderResult,
  isPartnerInviteUnresolvedState,
  partnerInviteProviderEvidenceMetadata,
  partnerInviteProviderRequestKey,
  partnerInviteSemanticHash,
  planPartnerInviteTerminal,
  recordPartnerInviteLateProviderEvidence,
  transitionPartnerInviteOperationToDispatched,
  transitionPartnerInviteOperationToTerminal,
} from "@/lib/partner-invite-operations";
import { sendEmailMessage, sendSmsMessage } from "@/lib/messaging";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  extendTeamMutationIdempotencyLease,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  type TeamMutationIdempotencyInput,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  assertTeamMutationExpectedVersion,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationExceptionResult,
  teamMutationResultResponse,
  teamMutationSuccessResult,
  type TeamMutationContext,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const INVITE_SURFACE = "team.sales.outbound.partners";
const INVITE_ATTEMPTED_ACTION = "partner_user.invite.attempted";
const INVITE_ROUTE = "POST /api/admin/partners/users";
const INVITE_TTL_MINUTES = 30;
const INVITE_BODY_MAXIMUM_BYTES = 4 * 1024;
const INVITE_BODY_DEADLINE_MS = 10_000;
const INVITE_IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000;
const INVITE_BODY_KEYS = ["email", "name", "orgContactId", "phone"] as const;
const ACCESS_BODY_KEYS = [
  "active",
  "confirmation",
  "orgContactId",
  "userId",
] as const;

const USER_SELECTION = {
  id: partnerUsers.id,
  orgContactId: partnerUsers.orgContactId,
  email: partnerUsers.email,
  phone: partnerUsers.phone,
  phoneE164: partnerUsers.phoneE164,
  name: partnerUsers.name,
  active: partnerUsers.active,
  createdAt: partnerUsers.createdAt,
  updatedAt: partnerUsers.updatedAt,
};

type PartnerInviteUser = {
  id: string;
  orgContactId: string;
  email: string;
  phone: string | null;
  phoneE164: string | null;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type PreparedPartnerInvite = {
  user: PartnerInviteUser;
  rawToken: string;
  expiresAt: Date;
  operationId: string;
  attemptedAuditEventId: string;
};

type PartnerInviteTerminal = {
  result: MutationResult<unknown>;
  status: number;
  state: PartnerInviteDeliverySummary["state"];
};

class PartnerInviteUnresolvedFailure extends TeamMutationFailure {
  readonly operationState:
    | "requested"
    | "dispatched"
    | "reconciliation_required";

  constructor(
    operationState: "requested" | "dispatched" | "reconciliation_required",
  ) {
    super(
      "conflict",
      operationState === "requested"
        ? "A durable invite is already prepared for this portal user. Review that operation before starting another invite."
        : "A partner invite is already in flight or awaiting reconciliation. Do not resend it until the existing operation is resolved.",
    );
    this.operationState = operationState;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key, index) => keys[index] === key)
  );
}

function hasExactInviteKeys(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, INVITE_BODY_KEYS);
}

function translateInviteInputError(error: unknown): TeamMutationFailure {
  if (error instanceof TeamMutationFailure) return error;
  if (error instanceof BoundedJsonRequestError) {
    return new TeamMutationFailure(
      error.code === "body_timeout" ? "timeout" : "invalid",
      error.message,
      {
        status: error.status,
        retryable: error.code === "body_timeout",
        fieldErrors: { request: error.message },
      },
    );
  }
  return new TeamMutationFailure(
    "invalid",
    "Send exactly one valid partner-invite JSON object.",
    { fieldErrors: { request: "The request body is invalid." } },
  );
}

async function inviteFailureResponse(
  mutation: TeamMutationContext,
  failure: TeamMutationFailure,
  input: {
    boundary: "input" | "provider_configuration" | "principal";
    orgContactId?: string | null;
  },
): Promise<Response> {
  await recordTeamMutationFailure(mutation, {
    outcome:
      failure.code === "invalid" || failure.code === "conflict"
        ? "denied"
        : "failed",
    entityType: "partner_user",
    entityId:
      input.orgContactId && UUID_PATTERN.test(input.orgContactId)
        ? input.orgContactId
        : null,
    code: failure.code,
    metadata: { boundary: input.boundary },
  });
  return teamMutationExceptionResponse(failure, mutation);
}

async function partnerUserAccessFailureResponse(
  mutation: TeamMutationContext,
  failure: TeamMutationFailure,
  input: {
    boundary: "input" | "mutation";
    orgContactId?: string | null;
    userId?: string | null;
  },
): Promise<Response> {
  await recordTeamMutationFailure(mutation, {
    outcome:
      failure.code === "invalid" || failure.code === "conflict"
        ? "denied"
        : "failed",
    entityType: "partner_user",
    entityId:
      input.userId && UUID_PATTERN.test(input.userId) ? input.userId : null,
    code: failure.code,
    metadata: {
      boundary: input.boundary,
      ...(input.orgContactId && UUID_PATTERN.test(input.orgContactId)
        ? { orgContactId: input.orgContactId }
        : {}),
    },
  });
  return teamMutationExceptionResponse(failure, mutation);
}

function serializedUser(user: PartnerInviteUser) {
  return {
    id: user.id,
    orgContactId: user.orgContactId,
    email: user.email,
    phone: user.phone,
    phoneE164: user.phoneE164,
    name: user.name,
    active: user.active,
    createdAt: user.createdAt.toISOString(),
  };
}

function providerEvidenceMetadata(
  evidence: readonly PartnerInviteProviderEvidence[],
) {
  return partnerInviteProviderEvidenceMetadata(evidence);
}

async function insertPartnerInviteAudit(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  input: {
    action: string;
    outcome: "attempted" | "succeeded" | "failed";
    userId?: string | null;
    providerOperationId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: Date;
  },
): Promise<{ auditEventId: string; committedAt: string }> {
  const record = buildPartnerInviteOperationAuditRecord(
    {
      actorType: mutation.actor.type,
      actorId: mutation.actor.id ?? null,
      actorRole: mutation.actor.role ?? null,
      actorLabel: mutation.actor.label ?? null,
      sessionId: mutation.actor.sessionId ?? null,
      authMethod: mutation.actor.authMethod,
      correlationId: mutation.correlationId,
      requiredPermissions: [...mutation.policy.requiredPermissions],
      surface: INVITE_SURFACE,
      idempotencyKeyHash: mutation.idempotencyKeyHash,
      operationId: mutation.operationId,
      risk: mutation.policy.risk,
    },
    input,
  );
  await tx.insert(auditLogs).values(record);
  return {
    auditEventId: record.id,
    committedAt: record.createdAt.toISOString(),
  };
}

async function markPartnerInviteDispatched(
  db: ReturnType<typeof getDb>,
  mutation: TeamMutationContext,
  input: {
    operationId: string;
    userId: string;
    orgContactId: string;
    requestedChannels: PartnerInviteChannel[];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    const dispatchAudit = await insertPartnerInviteAudit(tx, mutation, {
      action: "partner_user.invite.dispatched",
      outcome: "attempted",
      userId: input.userId,
      metadata: {
        operationId: input.operationId,
        orgContactId: input.orgContactId,
        requestedChannels: input.requestedChannels,
        deliveryState: "dispatched",
        providerExactlyOnceClaimed: false,
      },
      createdAt: now,
    });
    await transitionPartnerInviteOperationToDispatched(tx, {
      operationId: input.operationId,
      dispatchAuditEventId: dispatchAudit.auditEventId,
      dispatchedAt: now,
    });
  });
}

async function recordLatePartnerInviteEvidence(
  db: ReturnType<typeof getDb>,
  mutation: TeamMutationContext,
  input: {
    userId: string | null;
    orgContactId: string;
    evidence: PartnerInviteProviderEvidence[];
    reason: string;
  },
): Promise<void> {
  await recordPartnerInviteLateProviderEvidence(
    db,
    {
      actorType: mutation.actor.type,
      actorId: mutation.actor.id ?? null,
      actorRole: mutation.actor.role ?? null,
      actorLabel: mutation.actor.label ?? null,
      sessionId: mutation.actor.sessionId ?? null,
      authMethod: mutation.actor.authMethod,
      correlationId: mutation.correlationId,
      requiredPermissions: [...mutation.policy.requiredPermissions],
      surface: INVITE_SURFACE,
      idempotencyKeyHash: mutation.idempotencyKeyHash,
      operationId: mutation.operationId,
      risk: mutation.policy.risk,
    },
    {
      actionRoot: "partner_user.invite",
      ...input,
    },
  );
}

async function finalizePartnerInvite(
  db: ReturnType<typeof getDb>,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  input: {
    operationId: string;
    user: PartnerInviteUser | null;
    userId: string | null;
    orgContactId: string;
    requestedChannels: PartnerInviteChannel[];
    evidence: PartnerInviteProviderEvidence[];
    summary: PartnerInviteDeliverySummary;
    attemptedAuditEventId?: string | null;
    reason?: string;
    redispatchPrevented?: boolean;
  },
): Promise<PartnerInviteTerminal> {
  return db.transaction(async (tx) => {
    const now = new Date();
    for (const item of input.evidence) {
      await insertPartnerInviteAudit(tx, mutation, {
        action:
          item.state === "succeeded"
            ? "partner_user.invite.channel.succeeded"
            : item.state === "failed"
              ? "partner_user.invite.channel.failed"
              : "partner_user.invite.channel.reconciliation_required",
        outcome: item.state === "succeeded" ? "succeeded" : "failed",
        userId: input.userId,
        providerOperationId: item.providerOperationId,
        metadata: {
          orgContactId: input.orgContactId,
          channel: item.channel,
          state: item.state,
          provider: item.provider,
          providerOperationIds: item.providerOperationIds,
          providerIdempotencySupported: item.providerIdempotencySupported,
          providerExactlyOnceClaimed: false,
          detail: item.detail,
        },
        createdAt: now,
      });
    }

    const metadata = {
      orgContactId: input.orgContactId,
      deliveryState: input.summary.state,
      requestedChannels: input.requestedChannels,
      acceptedChannels: input.summary.acceptedChannels,
      failedChannels: input.summary.failedChannels,
      uncertainChannels: input.summary.uncertainChannels,
      providerOperationIds: input.summary.providerOperationIds,
      providerEvidence: providerEvidenceMetadata(input.evidence),
      providerExactlyOnceClaimed: false,
      attemptedAuditEventId: input.attemptedAuditEventId ?? null,
      operationId: input.operationId,
      redispatchPrevented: input.redispatchPrevented === true,
      reason: input.reason ?? null,
    };

    if (input.summary.state === "succeeded" && input.user) {
      const providerOperationId =
        input.summary.providerOperationIds[0] ?? undefined;
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_user",
        entityId: input.user.id,
        before: { deliveryState: "requested" },
        after: { deliveryState: "succeeded" },
        metadata,
        ...(providerOperationId ? { providerOperationId } : {}),
        committedAt: now,
      });
      await transitionPartnerInviteOperationToTerminal(tx, {
        operationId: input.operationId,
        summary: input.summary,
        evidence: input.evidence,
        terminalAuditEventId: audit.auditEventId,
        completedAt: now,
      });
      const result = teamMutationSuccessResult(
        mutation,
        {
          user: serializedUser(input.user),
          delivery: {
            ...input.summary,
            providerExactlyOnceClaimed: false as const,
          },
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_user",
          entityId: input.user.id,
          ...(providerOperationId ? { providerOperationId } : {}),
        },
      );
      await completeTeamMutationIdempotency(tx, mutation, claim, result, 200);
      return { result, status: 200, state: "succeeded" };
    }

    const reconciliationRequired =
      input.summary.state === "reconciliation_required";
    const failure = reconciliationRequired
      ? new TeamMutationFailure(
          "conflict",
          "One or more providers may have accepted this partner invite. The operation requires reconciliation and was not sent again. Do not submit another invite until the audit record is reviewed.",
        )
      : new TeamMutationFailure(
          "provider_failed",
          "No delivery provider accepted this partner invite. Check the email and SMS provider status, then refresh before making a new delivery attempt.",
          { retryable: true },
        );
    const terminal = teamMutationExceptionResult(failure);
    const terminalAudit = await insertPartnerInviteAudit(tx, mutation, {
      action: reconciliationRequired
        ? "partner_user.invite.reconciliation_required"
        : "partner_user.invite.failed",
      outcome: "failed",
      userId: input.userId,
      providerOperationId: input.summary.providerOperationIds[0] ?? null,
      metadata,
      createdAt: now,
    });
    await transitionPartnerInviteOperationToTerminal(tx, {
      operationId: input.operationId,
      summary: input.summary,
      evidence: input.evidence,
      terminalAuditEventId: terminalAudit.auditEventId,
      completedAt: now,
      failureDetail: input.reason,
    });
    await completeTeamMutationIdempotency(
      tx,
      mutation,
      claim,
      terminal.result,
      terminal.status,
    );
    return {
      result: terminal.result,
      status: terminal.status,
      state: input.summary.state,
    };
  });
}

function inviteTerminalResponse(
  terminal: PartnerInviteTerminal,
  mutation: TeamMutationContext,
): Response {
  return teamMutationResultResponse(
    terminal.result,
    terminal.status,
    mutation.correlationId,
    { "x-operation-state": terminal.state },
  );
}

function translatedInviteError(error: unknown): unknown {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  ) {
    const constraint =
      "constraint" in error && typeof error.constraint === "string"
        ? error.constraint
        : "";
    if (
      constraint === "partner_invite_operations_unresolved_target_key" ||
      constraint === "partner_invite_operations_actor_request_key" ||
      constraint === "partner_invite_operations_public_request_key"
    ) {
      return new PartnerInviteUnresolvedFailure("reconciliation_required");
    }
    return new TeamMutationFailure(
      "conflict",
      "That email address or phone number is already assigned to another partner portal user.",
    );
  }
  return error;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "partners.read");
  if (permissionError) return permissionError;

  const url = new URL(request.url);
  const queryEntries = Array.from(url.searchParams.entries());
  const orgContactId =
    queryEntries.length === 1 && queryEntries[0]?.[0] === "orgContactId"
      ? queryEntries[0][1].trim()
      : "";
  const noStoreHeaders = {
    "cache-control": "private, no-store, max-age=0",
    pragma: "no-cache",
  };
  if (!UUID_PATTERN.test(orgContactId)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_query",
        message:
          "Provide exactly one valid orgContactId and no other query parameters.",
      },
      { status: 400, headers: noStoreHeaders },
    );
  }

  try {
    const db = getDb();
    const result = await db.transaction(
      async (tx) => {
        const [organization] = await tx
          .select({
            id: contacts.id,
            partnerStatus: contacts.partnerStatus,
            deletedAt: contacts.deletedAt,
            updatedAt: contacts.updatedAt,
          })
          .from(contacts)
          .where(eq(contacts.id, orgContactId))
          .limit(1);
        if (!organization || organization.deletedAt) return null;

        const rows = await tx
          .select({
            id: partnerUsers.id,
            orgContactId: partnerUsers.orgContactId,
            email: partnerUsers.email,
            phone: partnerUsers.phone,
            phoneE164: partnerUsers.phoneE164,
            name: partnerUsers.name,
            active: partnerUsers.active,
            passwordSetAt: partnerUsers.passwordSetAt,
            createdAt: partnerUsers.createdAt,
            updatedAt: partnerUsers.updatedAt,
          })
          .from(partnerUsers)
          .where(eq(partnerUsers.orgContactId, orgContactId))
          .orderBy(asc(partnerUsers.createdAt), asc(partnerUsers.id))
          .limit(101);
        return { organization, rows };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    if (!result) {
      return NextResponse.json(
        {
          ok: false,
          error: "partner_organization_not_found",
          message: "The selected partner organization was not found.",
        },
        { status: 404, headers: noStoreHeaders },
      );
    }
    if (result.rows.length > 100) {
      return NextResponse.json(
        {
          ok: false,
          error: "portal_user_limit_exceeded",
          message:
            "This organization has more portal users than this view can safely return. Contact support with the organization ID.",
        },
        { status: 409, headers: noStoreHeaders },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        organization: {
          id: result.organization.id,
          partnerStatus: result.organization.partnerStatus,
          version: result.organization.updatedAt.toISOString(),
        },
        users: result.rows.map((row) => ({
          ...row,
          passwordSetAt: row.passwordSetAt
            ? row.passwordSetAt.toISOString()
            : null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    console.error("[partners] portal_users_read_failed", {
      orgContactId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "portal_users_unavailable",
        message: "Portal users could not be loaded. Try again.",
      },
      { status: 500, headers: noStoreHeaders },
    );
  }
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(
    request,
    {
      principalTypes: ["human"],
      requiredPermissions: ["partners.invite"],
      risk: "destructive",
      requiresIdempotency: true,
      auditAction: "partner_user.access_changed",
    },
    {
      // `partners.invite` is shared with the provider-send action, but changing
      // access performs no send. Keep this operation behind the destructive
      // safety boundary so an external-send freeze cannot block revocation.
      ignoredPermissionKillSwitches: ["external_sends"],
    },
  );
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let input: {
    active: boolean;
    confirmation: "ACTIVATE" | "DEACTIVATE";
    orgContactId: string;
    userId: string;
  };
  try {
    const candidate = await readBoundedJsonRequest(request, {
      maximumBytes: 2 * 1024,
      deadlineMs: INVITE_BODY_DEADLINE_MS,
    });
    if (!isRecord(candidate) || !hasExactKeys(candidate, ACCESS_BODY_KEYS)) {
      throw new TeamMutationFailure(
        "invalid",
        "Send exactly orgContactId, userId, active, and confirmation.",
        { fieldErrors: { request: "The access request is incomplete." } },
      );
    }
    const orgContactId = readString(candidate["orgContactId"]);
    const userId = readString(candidate["userId"]);
    const active = candidate["active"];
    const confirmation = candidate["confirmation"];
    if (
      !UUID_PATTERN.test(orgContactId) ||
      !UUID_PATTERN.test(userId) ||
      typeof active !== "boolean" ||
      confirmation !== (active ? "ACTIVATE" : "DEACTIVATE")
    ) {
      throw new TeamMutationFailure(
        "invalid",
        active === false
          ? "Type DEACTIVATE to disable this portal user."
          : "Confirm ACTIVATE to enable this portal user.",
        {
          fieldErrors: {
            ...(!UUID_PATTERN.test(orgContactId)
              ? { orgContactId: "Choose a valid partner organization." }
              : {}),
            ...(!UUID_PATTERN.test(userId)
              ? { userId: "Choose a valid portal user." }
              : {}),
            ...(typeof active !== "boolean"
              ? { active: "Choose active or inactive." }
              : {}),
            ...(confirmation !== (active ? "ACTIVATE" : "DEACTIVATE")
              ? { confirmation: "Enter the exact confirmation." }
              : {}),
          },
        },
      );
    }
    input = {
      active,
      confirmation: active ? "ACTIVATE" : "DEACTIVATE",
      orgContactId,
      userId,
    };
  } catch (error) {
    return partnerUserAccessFailureResponse(
      mutation,
      translateInviteInputError(error),
      { boundary: "input" },
    );
  }

  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return partnerUserAccessFailureResponse(
      mutation,
      new TeamMutationFailure(
        "invalid",
        "The current portal-user version is required. Reload before changing access.",
        { fieldErrors: { version: "Reload this partner workspace." } },
      ),
      { boundary: "input", ...input },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PATCH /api/admin/partners/users",
      entityType: "partner_user",
      entityId: input.userId,
      payload: input,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [organization] = await tx
        .select({
          id: contacts.id,
          partnerStatus: contacts.partnerStatus,
          deletedAt: contacts.deletedAt,
        })
        .from(contacts)
        .where(eq(contacts.id, input.orgContactId))
        .for("update")
        .limit(1);
      if (!organization || organization.deletedAt) {
        throw new TeamMutationFailure(
          "conflict",
          "This partner organization is missing or in recovery. No portal access changed.",
        );
      }
      if (organization.partnerStatus !== "partner") {
        throw new TeamMutationFailure(
          "conflict",
          "Portal access can change only for an active partner organization.",
        );
      }

      const [user] = await tx
        .select({
          id: partnerUsers.id,
          orgContactId: partnerUsers.orgContactId,
          active: partnerUsers.active,
          updatedAt: partnerUsers.updatedAt,
        })
        .from(partnerUsers)
        .where(eq(partnerUsers.id, input.userId))
        .for("update")
        .limit(1);
      if (!user || user.orgContactId !== input.orgContactId) {
        throw new TeamMutationFailure(
          "conflict",
          "This portal user no longer belongs to the selected partner. Refresh before changing access.",
        );
      }
      assertTeamMutationExpectedVersion(mutation, user.updatedAt);
      if (user.active === input.active) {
        throw new TeamMutationFailure(
          "conflict",
          input.active
            ? "This portal user is already active."
            : "This portal user is already inactive.",
        );
      }

      const [unresolvedInvite] = await tx
        .select({
          id: partnerInviteOperations.id,
          state: partnerInviteOperations.state,
          version: partnerInviteOperations.version,
          dispatchedAt: partnerInviteOperations.dispatchedAt,
        })
        .from(partnerInviteOperations)
        .where(
          and(
            eq(partnerInviteOperations.partnerUserId, input.userId),
            inArray(partnerInviteOperations.state, [
              "requested",
              "dispatched",
              "reconciliation_required",
            ]),
            isNull(partnerInviteOperations.resolvedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (unresolvedInvite && input.active) {
        throw new TeamMutationFailure(
          "conflict",
          `Portal access cannot change while invite ${unresolvedInvite.id} is ${unresolvedInvite.state}. Resolve that operation first.`,
        );
      }

      const now = new Date(
        Math.max(
          Date.now(),
          user.updatedAt.getTime() + 1,
          (unresolvedInvite?.dispatchedAt?.getTime() ?? 0) + 1,
        ),
      );
      let inviteDisposition: {
        operationId: string;
        before: "requested" | "dispatched" | "reconciliation_required";
        after: "failed" | "reconciliation_required";
      } | null = null;
      if (unresolvedInvite && !input.active) {
        if (unresolvedInvite.state === "requested") {
          const terminalAudit = await insertPartnerInviteAudit(tx, mutation, {
            action: "partner_user.invite.quarantined",
            outcome: "failed",
            userId: input.userId,
            metadata: {
              operationId: unresolvedInvite.id,
              orgContactId: input.orgContactId,
              deliveryState: "failed",
              reason: "partner_user_deactivated_before_provider_dispatch",
              providerBoundaryCrossed: false,
              retryable: false,
            },
            createdAt: now,
          });
          const [settled] = await tx
            .update(partnerInviteOperations)
            .set({
              state: "failed",
              version: unresolvedInvite.version + 1,
              terminalAuditEventId: terminalAudit.auditEventId,
              failureCode: "partner_user_deactivated",
              failureDetail:
                "partner_user_deactivated_before_provider_dispatch",
              retryable: false,
              quarantinedAt: now,
              quarantinedBy:
                mutation.actor.id && UUID_PATTERN.test(mutation.actor.id)
                  ? mutation.actor.id
                  : null,
              quarantineReason: "partner_user_deactivated",
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(partnerInviteOperations.id, unresolvedInvite.id),
                eq(partnerInviteOperations.state, "requested"),
                eq(partnerInviteOperations.version, unresolvedInvite.version),
              ),
            )
            .returning({ id: partnerInviteOperations.id });
          if (!settled?.id) {
            throw new TeamMutationFailure(
              "conflict",
              "The pending invite changed while portal access was being disabled. Refresh and try again.",
              { retryable: true },
            );
          }
          inviteDisposition = {
            operationId: unresolvedInvite.id,
            before: "requested",
            after: "failed",
          };
        } else if (unresolvedInvite.state === "dispatched") {
          const terminalAudit = await insertPartnerInviteAudit(tx, mutation, {
            action: "partner_user.invite.reconciliation_required",
            outcome: "failed",
            userId: input.userId,
            metadata: {
              operationId: unresolvedInvite.id,
              orgContactId: input.orgContactId,
              deliveryState: "reconciliation_required",
              reason: "partner_user_deactivated_during_provider_dispatch",
              providerBoundaryCrossed: true,
              redispatchPrevented: true,
            },
            createdAt: now,
          });
          const [settled] = await tx
            .update(partnerInviteOperations)
            .set({
              state: "reconciliation_required",
              version: unresolvedInvite.version + 1,
              terminalAuditEventId: terminalAudit.auditEventId,
              failureCode: "partner_user_deactivated_during_dispatch",
              failureDetail:
                "partner_user_deactivated_during_provider_dispatch",
              retryable: false,
              completedAt: now,
              reconciliationRequiredAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(partnerInviteOperations.id, unresolvedInvite.id),
                eq(partnerInviteOperations.state, "dispatched"),
                eq(partnerInviteOperations.version, unresolvedInvite.version),
              ),
            )
            .returning({ id: partnerInviteOperations.id });
          if (!settled?.id) {
            throw new TeamMutationFailure(
              "conflict",
              "The in-flight invite changed while portal access was being disabled. Refresh and verify access before retrying.",
              { retryable: true },
            );
          }
          inviteDisposition = {
            operationId: unresolvedInvite.id,
            before: "dispatched",
            after: "reconciliation_required",
          };
        } else {
          inviteDisposition = {
            operationId: unresolvedInvite.id,
            before: "reconciliation_required",
            after: "reconciliation_required",
          };
        }
      }
      const [updated] = await tx
        .update(partnerUsers)
        .set({ active: input.active, updatedAt: now })
        .where(
          and(
            eq(partnerUsers.id, input.userId),
            eq(partnerUsers.orgContactId, input.orgContactId),
            eq(partnerUsers.active, user.active),
            eq(partnerUsers.updatedAt, user.updatedAt),
          ),
        )
        .returning({ id: partnerUsers.id });
      if (!updated?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The portal user changed while access was being updated. Refresh and try again.",
          { retryable: true },
        );
      }

      const revokedSessions = input.active
        ? []
        : await tx
            .update(partnerSessions)
            .set({ revokedAt: now })
            .where(
              and(
                eq(partnerSessions.partnerUserId, input.userId),
                isNull(partnerSessions.revokedAt),
              ),
            )
            .returning({ id: partnerSessions.id });
      const invalidatedTokens = input.active
        ? []
        : await tx
            .update(partnerLoginTokens)
            .set({ usedAt: now })
            .where(
              and(
                eq(partnerLoginTokens.partnerUserId, input.userId),
                isNull(partnerLoginTokens.usedAt),
              ),
            )
            .returning({ id: partnerLoginTokens.id });

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_user",
        entityId: input.userId,
        before: { active: user.active, version: user.updatedAt.toISOString() },
        after: { active: input.active, version: now.toISOString() },
        metadata: {
          orgContactId: input.orgContactId,
          sessionsRevokedCount: revokedSessions.length,
          loginTokensInvalidatedCount: invalidatedTokens.length,
          existingSessionsRestored: false,
          existingTokensRestored: false,
          unresolvedInviteDisposition: inviteDisposition,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          userId: input.userId,
          orgContactId: input.orgContactId,
          active: input.active,
          version: now.toISOString(),
          sessionsRevoked: revokedSessions.length,
          tokensInvalidated: invalidatedTokens.length,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_user",
          entityId: input.userId,
          version: now.toISOString(),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    const failure =
      error instanceof TeamMutationFailure
        ? error
        : new TeamMutationFailure(
            "internal",
            "Portal access could not be changed. Try again.",
            { retryable: true },
          );
    return partnerUserAccessFailureResponse(mutation, failure, {
      boundary: "mutation",
      ...input,
    });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.invite"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "partner_user.invited",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let payload: Record<string, unknown>;
  try {
    const candidate = await readBoundedJsonRequest(request, {
      maximumBytes: INVITE_BODY_MAXIMUM_BYTES,
      deadlineMs: INVITE_BODY_DEADLINE_MS,
    });
    if (!isRecord(candidate) || !hasExactInviteKeys(candidate)) {
      throw new TeamMutationFailure(
        "invalid",
        "Send exactly orgContactId, name, email, and phone.",
        {
          fieldErrors: {
            request:
              "Remove unsupported fields and include every invite field.",
          },
        },
      );
    }
    payload = candidate;
  } catch (error) {
    return inviteFailureResponse(mutation, translateInviteInputError(error), {
      boundary: "input",
    });
  }
  const orgContactId = readString(payload?.["orgContactId"]);
  const email = normalizeEmail(payload?.["email"]);
  const name = readString(payload?.["name"]);
  const phone = readString(payload?.["phone"]);
  const phoneE164 = phone.length ? normalizePhoneE164(phone) : null;

  if (
    !UUID_PATTERN.test(orgContactId) ||
    !email ||
    email.length > 320 ||
    !EMAIL_PATTERN.test(email) ||
    !name ||
    name.length > 200
  ) {
    return inviteFailureResponse(
      mutation,
      new TeamMutationFailure(
        "invalid",
        "Select a partner and enter a valid name and email address.",
        {
          fieldErrors: {
            ...(!UUID_PATTERN.test(orgContactId)
              ? { orgContactId: "Select a valid partner." }
              : {}),
            ...(!name || name.length > 200
              ? { name: "Enter a name using 200 characters or fewer." }
              : {}),
            ...(!email || email.length > 320 || !EMAIL_PATTERN.test(email)
              ? { email: "Enter a valid email address." }
              : {}),
          },
        },
      ),
      { boundary: "input", orgContactId },
    );
  }
  if (phone.length > 64 || (phone.length > 0 && !phoneE164)) {
    return inviteFailureResponse(
      mutation,
      new TeamMutationFailure(
        "invalid",
        "Enter a valid phone number or leave it blank.",
        { fieldErrors: { phone: "Use a valid phone number." } },
      ),
      { boundary: "input", orgContactId },
    );
  }

  const siteBaseUrl = resolvePublicSiteBaseUrl();
  if (!siteBaseUrl) {
    return inviteFailureResponse(
      mutation,
      new TeamMutationFailure(
        "provider_failed",
        "The public Partner Portal URL is not configured. No invite was created or sent.",
      ),
      { boundary: "provider_configuration", orgContactId },
    );
  }
  if (
    !mutation.idempotencyKeyHash ||
    !mutation.actor.id ||
    !UUID_PATTERN.test(mutation.actor.id) ||
    (mutation.actor.sessionId !== null &&
      mutation.actor.sessionId !== undefined &&
      !UUID_PATTERN.test(mutation.actor.sessionId)) ||
    (mutation.actor.authMethod !== "team_session" &&
      mutation.actor.authMethod !== "break_glass")
  ) {
    return inviteFailureResponse(
      mutation,
      new TeamMutationFailure(
        "internal",
        "The verified invitation request is incomplete.",
      ),
      { boundary: "principal", orgContactId },
    );
  }
  const actorMemberId = mutation.actor.id;
  const idempotencyKeyHash = mutation.idempotencyKeyHash;

  const requestedChannels: PartnerInviteChannel[] = phoneE164
    ? ["email", "sms"]
    : ["email"];
  const idempotencyInput: TeamMutationIdempotencyInput = {
    route: INVITE_ROUTE,
    entityType: "partner_organization",
    entityId: orgContactId,
    payload: { orgContactId, email, name, phoneE164 },
  };
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  let dispatchBoundaryCrossed = false;
  let preparedUser: PartnerInviteUser | null = null;
  let attemptedAuditEventId: string | null = null;
  let evidence: PartnerInviteProviderEvidence[] = [];

  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(
      db,
      mutation,
      idempotencyInput,
    );
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    await extendTeamMutationIdempotencyLease(
      db,
      mutation,
      claim,
      INVITE_IDEMPOTENCY_LEASE_MS,
    );

    const prepared = await db.transaction(
      async (tx): Promise<PreparedPartnerInvite> => {
        let now = new Date();
        const [org] = await tx
          .select({
            id: contacts.id,
            partnerStatus: contacts.partnerStatus,
            partnerSince: contacts.partnerSince,
            deletedAt: contacts.deletedAt,
          })
          .from(contacts)
          .where(eq(contacts.id, orgContactId))
          .for("update")
          .limit(1);
        if (!org?.id) {
          throw new TeamMutationFailure(
            "invalid",
            "The selected partner was not found.",
            { status: 404, fieldErrors: { orgContactId: "Select a partner." } },
          );
        }
        if (org.deletedAt) {
          throw new TeamMutationFailure(
            "conflict",
            "This partner is in recovery. Restore it before inviting a portal user.",
          );
        }
        if (org.partnerStatus !== "partner") {
          throw new TeamMutationFailure(
            "conflict",
            "Portal users can be invited only after this organization is explicitly activated as a partner.",
            {
              fieldErrors: {
                orgContactId: "Activate the partner before inviting users.",
              },
            },
          );
        }

        const [existing] = await tx
          .select(USER_SELECTION)
          .from(partnerUsers)
          .where(eq(partnerUsers.email, email))
          .for("update")
          .limit(1);
        if (existing) {
          if (
            mutation.expectedVersion === null ||
            mutation.expectedVersion === "*" ||
            mutation.expectedVersion === "new"
          ) {
            throw new TeamMutationFailure(
              "conflict",
              "This email already belongs to a portal user. Reload the partner workspace and resend from that user row.",
              {
                fieldErrors: {
                  version: "Use the existing user's current version.",
                },
              },
            );
          }
          assertTeamMutationExpectedVersion(mutation, existing.updatedAt);
          now = new Date(
            Math.max(Date.now(), existing.updatedAt.getTime() + 1),
          );
        } else if (mutation.expectedVersion !== "new") {
          throw new TeamMutationFailure(
            "conflict",
            "The portal-user list changed after this invite form loaded. Reload before creating the user.",
            { fieldErrors: { version: "Reload the partner workspace." } },
          );
        }
        if (phoneE164) {
          const [phoneTaken] = await tx
            .select({
              id: partnerUsers.id,
              orgContactId: partnerUsers.orgContactId,
            })
            .from(partnerUsers)
            .where(eq(partnerUsers.phoneE164, phoneE164))
            .for("update")
            .limit(1);
          if (phoneTaken?.id && phoneTaken.id !== existing?.id) {
            throw new TeamMutationFailure(
              "conflict",
              "That phone number is already assigned to another partner portal user.",
              {
                fieldErrors: {
                  phone: "Use the existing user or another phone.",
                },
              },
            );
          }
        }

        let user: PartnerInviteUser | null = null;
        if (existing) {
          if (existing.orgContactId !== orgContactId) {
            throw new TeamMutationFailure(
              "conflict",
              "That email address is already assigned to another partner.",
              {
                fieldErrors: {
                  email: "Use the existing user or another email.",
                },
              },
            );
          }
          if (!existing.active) {
            throw new TeamMutationFailure(
              "conflict",
              "This partner portal user is inactive. Reactivate the user before sending a new invite.",
            );
          }
          if (
            phoneE164 &&
            existing.phoneE164 &&
            existing.phoneE164 !== phoneE164
          ) {
            throw new TeamMutationFailure(
              "conflict",
              "The entered phone number does not match this existing portal user.",
              { fieldErrors: { phone: "Use the existing phone number." } },
            );
          }
          const [updated] = await tx
            .update(partnerUsers)
            .set({
              name,
              ...(phoneE164 ? { phone, phoneE164 } : {}),
              updatedAt: now,
            })
            .where(
              and(
                eq(partnerUsers.id, existing.id),
                eq(partnerUsers.updatedAt, existing.updatedAt),
              ),
            )
            .returning(USER_SELECTION);
          user = updated ?? null;
        } else {
          const [created] = await tx
            .insert(partnerUsers)
            .values({
              orgContactId,
              email,
              name,
              phone: phone.length > 0 ? phone : null,
              phoneE164,
              active: true,
              createdAt: now,
              updatedAt: now,
            })
            .returning(USER_SELECTION);
          user = created ?? null;
        }
        if (!user) {
          throw new TeamMutationFailure(
            "internal",
            "The partner portal user could not be prepared. No invite was sent.",
          );
        }

        const [unresolved] = await tx
          .select({
            id: partnerInviteOperations.id,
            state: partnerInviteOperations.state,
          })
          .from(partnerInviteOperations)
          .where(
            and(
              eq(partnerInviteOperations.partnerUserId, user.id),
              inArray(partnerInviteOperations.state, [
                "requested",
                "dispatched",
                "reconciliation_required",
              ]),
              isNull(partnerInviteOperations.resolvedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (unresolved && isPartnerInviteUnresolvedState(unresolved.state)) {
          throw new PartnerInviteUnresolvedFailure(unresolved.state);
        }

        const { rawToken, expiresAt } =
          await replacePartnerLoginTokenInTransaction(tx, {
            partnerUserId: user.id,
            requestedIp: getClientIp(request),
            userAgent: getUserAgent(request),
            ttlMinutes: INVITE_TTL_MINUTES,
            now,
          });
        const attempted = await insertPartnerInviteAudit(tx, mutation, {
          action: INVITE_ATTEMPTED_ACTION,
          outcome: "attempted",
          userId: user.id,
          metadata: {
            orgContactId,
            requestedChannels,
            deliveryState: "requested",
            tokenExpiresAt: expiresAt.toISOString(),
            providerExactlyOnceClaimed: false,
          },
          createdAt: now,
        });
        const providerRequestKey = randomUUID();
        await tx.insert(partnerInviteOperations).values({
          id: mutation.operationId,
          orgContactId,
          partnerUserId: user.id,
          operationKind: "team_invite",
          initiatorType: "team_member",
          semanticHash: partnerInviteSemanticHash({
            operationKind: "team_invite",
            orgContactId,
            partnerUserId: user.id,
            email,
            phoneE164,
            requestedChannels,
          }),
          requestedChannels,
          correlationId: mutation.correlationId,
          idempotencyKeyHash,
          actorMemberId,
          actorRole: mutation.actor.role ?? null,
          actorLabel: mutation.actor.label ?? null,
          sessionId: mutation.actor.sessionId ?? null,
          authMethod: mutation.actor.authMethod,
          state: "requested",
          version: 1,
          providerRequestKey,
          requestedAuditEventId: attempted.auditEventId,
          requestedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        return {
          user,
          rawToken,
          expiresAt,
          operationId: mutation.operationId,
          attemptedAuditEventId: attempted.auditEventId,
        };
      },
    );

    attemptedAuditEventId = prepared.attemptedAuditEventId;
    preparedUser = prepared.user;
    await extendTeamMutationIdempotencyLease(
      db,
      mutation,
      claim,
      INVITE_IDEMPOTENCY_LEASE_MS,
    );
    await markPartnerInviteDispatched(db, mutation, {
      operationId: prepared.operationId,
      userId: prepared.user.id,
      orgContactId,
      requestedChannels,
    });
    dispatchBoundaryCrossed = true;
    const url = new URL("/partners/auth", siteBaseUrl);
    url.searchParams.set("token", prepared.rawToken);
    const subject = "You've been invited to the Stonegate Partner Portal";
    const body = [
      `Hi ${name},`,
      "",
      "You now have access to the Stonegate Partner Portal to request and schedule service.",
      "",
      `Use this link to log in (expires in about ${INVITE_TTL_MINUTES} minutes):`,
      url.toString(),
      "",
      `Expires at: ${prepared.expiresAt.toISOString()}`,
      "",
      "After login, you can optionally set a password for faster sign-in next time.",
    ].join("\n");
    const smsBody = `Stonegate Partner Portal invite: ${url.toString()} (expires ${prepared.expiresAt.toISOString()})`;

    evidence = await Promise.all([
      capturePartnerInviteProviderResult("email", () =>
        sendEmailMessage(email, subject, body, {
          idempotencyKey: partnerInviteProviderRequestKey(
            prepared.operationId,
            "email",
          ),
        }),
      ),
      ...(phoneE164
        ? [
            capturePartnerInviteProviderResult("sms", () =>
              sendSmsMessage(phoneE164, smsBody, null, {
                idempotencyKey: partnerInviteProviderRequestKey(
                  prepared.operationId,
                  "sms",
                ),
              }),
            ),
          ]
        : []),
    ]);
    const summary = planPartnerInviteTerminal(requestedChannels, evidence);
    const terminal = await finalizePartnerInvite(db, mutation, claim, {
      operationId: prepared.operationId,
      user: prepared.user,
      userId: prepared.user.id,
      orgContactId,
      requestedChannels,
      evidence,
      summary,
      attemptedAuditEventId: prepared.attemptedAuditEventId,
      reason:
        summary.state === "succeeded" && summary.failedChannels.length > 0
          ? "partial_known_channel_failure"
          : undefined,
      redispatchPrevented: summary.state === "reconciliation_required",
    });
    return inviteTerminalResponse(terminal, mutation);
  } catch (caughtError) {
    const error = translatedInviteError(caughtError);
    if (db && claim && dispatchBoundaryCrossed) {
      // A durable attempted marker already exists. Never settle this claim as
      // retryable: providers do not promise exactly-once delivery.
      try {
        const recovered = await claimTeamMutationIdempotency(
          db,
          mutation,
          idempotencyInput,
        );
        if (recovered.kind === "replay") {
          await recordLatePartnerInviteEvidence(db, mutation, {
            userId: preparedUser?.id ?? null,
            orgContactId,
            evidence,
            reason: "terminal_receipt_recovered_after_dispatch",
          });
          return teamMutationIdempotencyReplayResponse(recovered.replay);
        }
      } catch {
        // The current claim is normally still active; reconcile it below.
      }

      try {
        const knownSummary = planPartnerInviteTerminal(
          requestedChannels,
          evidence,
        );
        const allProvidersConfirmedNoSend =
          evidence.length === requestedChannels.length &&
          evidence.every((item) => item.state === "failed");
        const terminal = await finalizePartnerInvite(db, mutation, claim, {
          operationId: mutation.operationId,
          user: null,
          userId: preparedUser?.id ?? null,
          orgContactId,
          requestedChannels,
          evidence,
          summary: allProvidersConfirmedNoSend
            ? knownSummary
            : {
                ...knownSummary,
                state: "reconciliation_required",
                uncertainChannels:
                  knownSummary.uncertainChannels.length > 0
                    ? knownSummary.uncertainChannels
                    : requestedChannels,
              },
          attemptedAuditEventId,
          reason: allProvidersConfirmedNoSend
            ? "known_provider_non_send_finalization_retry"
            : "invite_dispatch_finalization_interrupted",
          redispatchPrevented: !allProvidersConfirmedNoSend,
        });
        return inviteTerminalResponse(terminal, mutation);
      } catch (reconciliationError) {
        try {
          const recovered = await claimTeamMutationIdempotency(
            db,
            mutation,
            idempotencyInput,
          );
          if (recovered.kind === "replay") {
            await recordLatePartnerInviteEvidence(db, mutation, {
              userId: preparedUser?.id ?? null,
              orgContactId,
              evidence,
              reason: "terminal_receipt_recovered_after_reconciliation_error",
            });
            return teamMutationIdempotencyReplayResponse(recovered.replay);
          }
        } catch {
          // The durable attempted audit still prevents a future redispatch.
        }
        console.error("[partners] invite_reconciliation_persistence_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            reconciliationError instanceof Error
              ? reconciliationError.name
              : "UnknownError",
        });
        return teamMutationResultResponse(
          teamMutationExceptionResult(
            new TeamMutationFailure(
              "conflict",
              "The invite may have reached a provider, but its final record could not be confirmed. Do not resend it until the audit log is reviewed.",
            ),
          ).result,
          409,
          mutation.correlationId,
          { "x-operation-state": "reconciliation_required" },
        );
      }
    }

    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[partners] invite_idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    if (error instanceof PartnerInviteUnresolvedFailure) {
      const terminal = teamMutationExceptionResult(error);
      return teamMutationResultResponse(
        terminal.result,
        terminal.status,
        mutation.correlationId,
        { "x-operation-state": error.operationState },
      );
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
