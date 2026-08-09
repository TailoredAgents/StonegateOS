import { createHash, randomUUID } from "node:crypto";
import type {
  ActionPolicy,
  MutationResult,
  TeamPermission,
} from "@myst-os/sdk";
import {
  AGENT_ACTION_PERMISSIONS,
  canonicalAgentActionJson,
  isAgentActionId,
  isAgentActionType,
  isAgentVersionedAction,
  isExactAgentRecordVersion,
  parseAgentActionApprovalProof,
  parseAgentActionPayload,
  parseAgentOperationalMutationResult,
  type AgentActionApprovalProof,
  type AgentActionType,
} from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { auditLogs, getDb, teamMutationIdempotency } from "@/db";
import {
  hashAgentActionPayload,
  parseStoredAgentActionApproval,
} from "@/lib/agent-action-approval";
import {
  buildAgentAuthoritativeOperationBinding,
  canBindAgentReservationFinalization,
  requireAgentAuthoritativeAuditAction,
  verifyAgentAuthoritativeOperationEvidence,
  type AgentAuthoritativeOperationBinding,
} from "@/lib/agent-action-authority";
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
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type ReservationData = {
  state: "reserved";
  reservationId: string;
  reservationToken: string;
  actionId: string;
  actionType: AgentActionType;
  approvalId: string;
  approvalTokenHash: string;
  approvalExpiresAt: string;
  payloadHash: string;
  actorId: string;
  sessionId: string;
  correlationId: string;
  expectedVersion: string | null;
  targetEntityId: string | null;
  operationBinding: AgentAuthoritativeOperationBinding;
  finalizationId: string | null;
  upstreamOperationId: string | null;
  upstreamHash: string | null;
};

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseOperationBinding(
  value: unknown,
): AgentAuthoritativeOperationBinding | null {
  const binding = record(value);
  if (
    !binding ||
    !hasExactKeys(binding, [
      "auditAction",
      "route",
      "entityType",
      "entityId",
      "keyHash",
      "scopeHash",
      "requestHash",
    ]) ||
    typeof binding["auditAction"] !== "string" ||
    typeof binding["route"] !== "string" ||
    typeof binding["entityType"] !== "string" ||
    typeof binding["entityId"] !== "string" ||
    typeof binding["keyHash"] !== "string" ||
    !HASH_PATTERN.test(binding["keyHash"]) ||
    typeof binding["scopeHash"] !== "string" ||
    !HASH_PATTERN.test(binding["scopeHash"]) ||
    typeof binding["requestHash"] !== "string" ||
    !HASH_PATTERN.test(binding["requestHash"])
  ) {
    return null;
  }
  return binding as AgentAuthoritativeOperationBinding;
}

function actionSummary(actionType: AgentActionType): string {
  switch (actionType) {
    case "create_contact":
      return "Contact created";
    case "create_quote":
      return "Quote created";
    case "create_task":
      return "Appointment task created";
    case "add_contact_note":
      return "Note added";
    case "create_reminder":
      return "Reminder created";
    case "book_appointment":
      return "Appointment booked";
    case "cancel_appointment":
      return "Appointment canceled";
    case "reschedule_appointment":
      return "Appointment rescheduled";
    case "send_text":
      return "Message queued";
    case "google_ads_recommendations_bulk_update":
      return "Recommendation review state updated";
    case "google_ads_recommendations_bulk_apply":
      return "Google Ads changes requested";
  }
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
      : "You no longer have permission to execute this Agent action.",
    { status: denied.status },
  );
}

function parseReservationData(value: unknown): ReservationData | null {
  const envelope = record(value);
  const data = record(envelope?.["data"]);
  const receipt = record(envelope?.["receipt"]);
  if (
    envelope?.["ok"] !== true ||
    !data ||
    !hasExactKeys(data, [
      "state",
      "reservationId",
      "reservationToken",
      "actionId",
      "actionType",
      "approvalId",
      "approvalTokenHash",
      "approvalExpiresAt",
      "payloadHash",
      "actorId",
      "sessionId",
      "correlationId",
      "expectedVersion",
      "targetEntityId",
      "operationBinding",
      "finalizationId",
      "upstreamOperationId",
      "upstreamHash",
    ]) ||
    data["state"] !== "reserved" ||
    typeof data["reservationId"] !== "string" ||
    typeof data["reservationToken"] !== "string" ||
    !isAgentActionId(data["actionId"]) ||
    !isAgentActionType(data["actionType"]) ||
    typeof data["approvalId"] !== "string" ||
    typeof data["approvalTokenHash"] !== "string" ||
    !HASH_PATTERN.test(data["approvalTokenHash"]) ||
    typeof data["approvalExpiresAt"] !== "string" ||
    typeof data["payloadHash"] !== "string" ||
    !HASH_PATTERN.test(data["payloadHash"]) ||
    typeof data["actorId"] !== "string" ||
    typeof data["sessionId"] !== "string" ||
    typeof data["correlationId"] !== "string" ||
    (data["expectedVersion"] !== null &&
      !isExactAgentRecordVersion(data["expectedVersion"])) ||
    (data["targetEntityId"] !== null &&
      typeof data["targetEntityId"] !== "string") ||
    !parseOperationBinding(data["operationBinding"]) ||
    (data["finalizationId"] !== null &&
      typeof data["finalizationId"] !== "string") ||
    (data["upstreamOperationId"] !== null &&
      typeof data["upstreamOperationId"] !== "string") ||
    (data["upstreamHash"] !== null &&
      (typeof data["upstreamHash"] !== "string" ||
        !HASH_PATTERN.test(data["upstreamHash"]))) ||
    receipt?.["actorId"] !== data["actorId"] ||
    receipt["correlationId"] !== data["correlationId"] ||
    receipt["entityType"] !== "agent_action" ||
    receipt["entityId"] !== data["approvalId"]
  ) {
    return null;
  }
  return data as ReservationData;
}

function assertReservationScope(
  reservation: ReservationData,
  expected: {
    actorId: string;
    sessionId: string;
    actionType: AgentActionType;
    actionId?: string;
    payloadHash?: string;
    approval?: AgentActionApprovalProof;
    reservationId?: string;
    reservationToken?: string;
    correlationId?: string;
    expectedVersion: string | null;
  },
): void {
  if (
    reservation.actorId !== expected.actorId ||
    reservation.sessionId !== expected.sessionId ||
    reservation.actionType !== expected.actionType ||
    (expected.actionId && reservation.actionId !== expected.actionId) ||
    (expected.payloadHash &&
      reservation.payloadHash !== expected.payloadHash) ||
    (expected.approval &&
      (reservation.approvalId !== expected.approval.approvalId ||
        reservation.approvalExpiresAt !== expected.approval.expiresAt ||
        reservation.approvalTokenHash !==
          sha256(expected.approval.approvalToken))) ||
    (expected.reservationId &&
      reservation.reservationId !== expected.reservationId) ||
    (expected.reservationToken &&
      reservation.reservationToken !== expected.reservationToken) ||
    (expected.correlationId &&
      reservation.correlationId !== expected.correlationId) ||
    reservation.expectedVersion !== expected.expectedVersion
  ) {
    throw new TeamMutationFailure(
      "forbidden",
      "The Agent reservation does not match this actor, session, proposal, and version.",
    );
  }
}

function boundedFailure(error: BoundedJsonRequestError): TeamMutationFailure {
  return new TeamMutationFailure("invalid", error.message, {
    status: error.status,
    fieldErrors: { request: "Send one bounded application/json object." },
  });
}

function upstreamStatus(body: Record<string, unknown>): number {
  const status = body["upstreamStatus"];
  if (
    typeof status !== "number" ||
    !Number.isSafeInteger(status) ||
    status < 200 ||
    status > 599
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The operational response status is invalid.",
    );
  }
  return status;
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["messages.read"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "agent.action.execution",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    let input: unknown;
    try {
      input = await readBoundedJsonRequest(request, {
        maximumBytes: 64 * 1024,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) throw boundedFailure(error);
      throw error;
    }
    const body = record(input);
    const phase = body?.["phase"];
    const actionType = body?.["actionType"];
    if (
      !body ||
      (phase !== "reserve" && phase !== "finalize") ||
      !isAgentActionType(actionType)
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose one supported Agent execution phase and action.",
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
    db = getDb();

    if (phase === "reserve") {
      if (
        !hasExactKeys(body, [
          "phase",
          "actionType",
          "actionId",
          "payload",
          "approval",
        ]) ||
        !isAgentActionId(body["actionId"])
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "The exact approved Agent proposal is required.",
        );
      }
      const actionId = body["actionId"];
      const parsed = parseAgentActionPayload(actionType, body["payload"]);
      if (!parsed.ok) {
        throw new TeamMutationFailure("invalid", parsed.message, {
          fieldErrors: parsed.fieldErrors,
        });
      }
      const approval = parseAgentActionApprovalProof(body["approval"]);
      if (!approval) {
        throw new TeamMutationFailure(
          "forbidden",
          "A valid server-issued approval proof is required.",
        );
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
        (!isAgentVersionedAction(actionType) &&
          mutation.expectedVersion !== null)
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "The approved record version does not match If-Match.",
          {
            fieldErrors: { version: "Refresh and review the current record." },
          },
        );
      }
      const hash = hashAgentActionPayload(actionType, parsed.payload);
      const claimed = await claimTeamMutationIdempotency(db, mutation, {
        route: "POST /api/admin/agent/action-executions/reserve",
        entityType: "agent_action",
        entityId: actionId,
        payload: {
          actionType,
          actionId,
          approvalId: approval.approvalId,
          payloadHash: hash,
          sessionId,
        },
      });
      if (claimed.kind === "replay") {
        const reservation = parseReservationData(claimed.replay.result);
        if (!reservation) {
          throw new TeamMutationFailure(
            "internal",
            "The stored Agent reservation is unreadable. Contact support before retrying.",
          );
        }
        assertReservationScope(reservation, {
          actorId,
          sessionId,
          actionType,
          actionId,
          payloadHash: hash,
          approval,
          expectedVersion,
        });
        return teamMutationIdempotencyReplayResponse(claimed.replay);
      }
      claim = claimed.claim;
      const reservationToken = randomUUID();
      const operationBinding = buildAgentAuthoritativeOperationBinding(
        actionType,
        parsed.payload,
        `${reservationToken}:execute`,
      );
      if (!operationBinding) {
        throw new TeamMutationFailure(
          "provider_failed",
          "This Agent action has no authoritative operational binding.",
          { status: 503 },
        );
      }
      const parsedTargetEntityId = parsed.payload["appointmentId"];
      const targetEntityId = isAgentVersionedAction(actionType)
        ? typeof parsedTargetEntityId === "string"
          ? parsedTargetEntityId
          : ""
        : null;
      const result = await db.transaction(async (tx) => {
        const [approvalRow] = await tx
          .select()
          .from(teamMutationIdempotency)
          .where(eq(teamMutationIdempotency.id, approval.approvalId))
          .for("update")
          .limit(1);
        const storedApproval = parseStoredAgentActionApproval(
          approvalRow?.responseBody,
        );
        if (
          !approvalRow ||
          approvalRow.action !== "agent.action.approved" ||
          approvalRow.status !== "succeeded" ||
          !storedApproval ||
          storedApproval.approvalToken !== approval.approvalToken ||
          storedApproval.expiresAt !== approval.expiresAt ||
          storedApproval.actorId !== actorId ||
          storedApproval.sessionId !== sessionId ||
          storedApproval.actionId !== actionId ||
          storedApproval.actionType !== actionType ||
          storedApproval.payloadHash !== hash ||
          storedApproval.expectedVersion !== expectedVersion
        ) {
          throw new TeamMutationFailure(
            "forbidden",
            "The server-issued approval proof does not match this proposal and session.",
          );
        }
        if (Date.parse(storedApproval.expiresAt) <= Date.now()) {
          throw new TeamMutationFailure(
            "conflict",
            "This approval expired. Review the current proposal and approve it again.",
          );
        }
        if (
          storedApproval.consumedByReservationId &&
          storedApproval.consumedByReservationId !== claimed.claim.id
        ) {
          throw new TeamMutationFailure(
            "conflict",
            "This approval was already consumed by a different execution.",
          );
        }
        const approvalEnvelope = record(approvalRow.responseBody);
        if (!approvalEnvelope) {
          throw new TeamMutationFailure(
            "internal",
            "The approval proof could not be consumed safely.",
          );
        }
        await tx
          .update(teamMutationIdempotency)
          .set({
            responseBody: {
              ...approvalEnvelope,
              data: {
                ...storedApproval,
                consumedByReservationId: claimed.claim.id,
              },
            },
            updatedAt: new Date(),
          })
          .where(eq(teamMutationIdempotency.id, approvalRow.id));

        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: "agent_action",
          entityId: approval.approvalId,
          after: { state: "reserved", actionId, actionType },
          metadata: {
            surface: "/team/tools/agent",
            approvalId: approval.approvalId,
            actionPermissions: [...AGENT_ACTION_PERMISSIONS[actionType]],
            externalEffect: "not_dispatched",
          },
        });
        const response = teamMutationSuccessResult<ReservationData>(
          mutation,
          {
            state: "reserved",
            reservationId: claimed.claim.id,
            reservationToken,
            actionId,
            actionType,
            approvalId: approval.approvalId,
            approvalTokenHash: sha256(approval.approvalToken),
            approvalExpiresAt: approval.expiresAt,
            payloadHash: hash,
            actorId,
            sessionId,
            correlationId: mutation.correlationId,
            expectedVersion,
            targetEntityId,
            operationBinding,
            finalizationId: null,
            upstreamOperationId: null,
            upstreamHash: null,
          },
          {
            auditEventId: audit.auditEventId,
            committedAt: audit.committedAt,
            entityType: "agent_action",
            entityId: approval.approvalId,
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
    }

    if (
      !hasExactKeys(body, [
        "phase",
        "actionType",
        "reservationId",
        "reservationToken",
        "upstreamStatus",
        "upstream",
      ]) ||
      typeof body["reservationId"] !== "string" ||
      typeof body["reservationToken"] !== "string"
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The Agent finalization request is incomplete.",
      );
    }
    const reservationId = body["reservationId"];
    const reservationToken = body["reservationToken"];
    const status = upstreamStatus(body);
    const [reservationRow] = await db
      .select()
      .from(teamMutationIdempotency)
      .where(eq(teamMutationIdempotency.id, reservationId))
      .limit(1);
    const reservation = parseReservationData(reservationRow?.responseBody);
    if (
      !reservationRow ||
      reservationRow.action !== "agent.action.execution" ||
      reservationRow.status !== "succeeded" ||
      !reservation
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "The Agent execution reservation could not be verified.",
      );
    }
    assertReservationScope(reservation, {
      actorId,
      sessionId,
      actionType,
      reservationId,
      reservationToken,
      correlationId: mutation.correlationId,
      expectedVersion: mutation.expectedVersion,
    });
    const upstream = parseAgentOperationalMutationResult(
      actionType,
      body["upstream"],
      {
        actorId,
        targetEntityId: reservation.targetEntityId,
        expectedVersion: reservation.expectedVersion,
      },
    );
    if (!upstream) {
      throw new TeamMutationFailure(
        "invalid",
        "The operational API result lacks verified actor, entity, and version evidence.",
      );
    }
    if (
      (upstream.ok && (status < 200 || status >= 300)) ||
      (!upstream.ok && status < 400)
    ) {
      throw new TeamMutationFailure(
        "invalid",
        "The operational status and result do not agree.",
      );
    }
    const upstreamHash = sha256(canonicalAgentActionJson(body["upstream"]));
    const finalClaim = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/agent/action-executions/finalize",
      entityType: "agent_action_reservation",
      entityId: reservation.reservationId,
      payload: {
        actionType,
        actionId: reservation.actionId,
        approvalId: reservation.approvalId,
        payloadHash: reservation.payloadHash,
        reservationTokenHash: sha256(reservation.reservationToken),
        sessionId,
        upstreamHash,
      },
    });
    if (finalClaim.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(finalClaim.replay);
    }
    claim = finalClaim.claim;

    const finalized = await db.transaction(async (tx) => {
      const [lockedReservationRow] = await tx
        .select()
        .from(teamMutationIdempotency)
        .where(eq(teamMutationIdempotency.id, reservation.reservationId))
        .for("update")
        .limit(1);
      const lockedReservation = parseReservationData(
        lockedReservationRow?.responseBody,
      );
      if (
        !lockedReservationRow ||
        lockedReservationRow.action !== "agent.action.execution" ||
        lockedReservationRow.status !== "succeeded" ||
        !lockedReservation
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "The Agent execution reservation changed before finalization.",
          { retryable: true },
        );
      }
      assertReservationScope(lockedReservation, {
        actorId,
        sessionId,
        actionType,
        reservationId,
        reservationToken,
        correlationId: mutation.correlationId,
        expectedVersion: mutation.expectedVersion,
      });

      const operationRows = await tx
        .select({
          operationId: teamMutationIdempotency.operationId,
          action: teamMutationIdempotency.action,
          keyHash: teamMutationIdempotency.keyHash,
          scopeHash: teamMutationIdempotency.scopeHash,
          requestHash: teamMutationIdempotency.requestHash,
          status: teamMutationIdempotency.status,
          correlationId: teamMutationIdempotency.correlationId,
          responseStatus: teamMutationIdempotency.responseStatus,
          responseBody: teamMutationIdempotency.responseBody,
        })
        .from(teamMutationIdempotency)
        .where(
          upstream.ok
            ? and(
                eq(
                  teamMutationIdempotency.operationId,
                  upstream.receipt.operationId,
                ),
                eq(
                  teamMutationIdempotency.action,
                  lockedReservation.operationBinding.auditAction,
                ),
                eq(
                  teamMutationIdempotency.keyHash,
                  lockedReservation.operationBinding.keyHash,
                ),
              )
            : and(
                eq(
                  teamMutationIdempotency.action,
                  lockedReservation.operationBinding.auditAction,
                ),
                eq(
                  teamMutationIdempotency.keyHash,
                  lockedReservation.operationBinding.keyHash,
                ),
              ),
        )
        .limit(2);
      if (operationRows.length !== 1) {
        throw new TeamMutationFailure(
          "conflict",
          "The authoritative operational receipt is not available. Reconcile the operation before retrying.",
          { retryable: true },
        );
      }
      const operationRow = operationRows[0]!;
      if (operationRow.status === "in_progress") {
        throw new TeamMutationFailure(
          "conflict",
          "The operational endpoint has not durably finalized its result yet.",
          { retryable: true, retryAfter: "1" },
        );
      }

      let operationalAudit: {
        id: string;
        actorId: string | null;
        sessionId: string | null;
        authMethod: string | null;
        correlationId: string | null;
        requiredPermissions: string[] | null;
        outcome: string;
        providerOperationId: string | null;
        idempotencyKeyHash: string | null;
        action: string;
        entityType: string;
        entityId: string | null;
        createdAt: Date;
      } | null = null;
      if (upstream.ok) {
        const audits = await tx
          .select({
            id: auditLogs.id,
            actorId: auditLogs.actorId,
            sessionId: auditLogs.sessionId,
            authMethod: auditLogs.authMethod,
            correlationId: auditLogs.correlationId,
            requiredPermissions: auditLogs.requiredPermissions,
            outcome: auditLogs.outcome,
            providerOperationId: auditLogs.providerOperationId,
            idempotencyKeyHash: auditLogs.idempotencyKeyHash,
            action: auditLogs.action,
            entityType: auditLogs.entityType,
            entityId: auditLogs.entityId,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .where(eq(auditLogs.id, upstream.receipt.auditEventId))
          .limit(2);
        if (audits.length === 1) operationalAudit = audits[0]!;
      }

      const authority = verifyAgentAuthoritativeOperationEvidence({
        actionType,
        actorId,
        sessionId,
        authMethod: mutation.actor.authMethod,
        correlationId: mutation.correlationId,
        upstreamStatus: status,
        upstreamRaw: body["upstream"],
        upstream,
        binding: lockedReservation.operationBinding,
        idempotency: operationRow,
        audit: operationalAudit,
      });
      if (!authority.ok) {
        throw new TeamMutationFailure(
          "forbidden",
          "The operational response does not match authoritative idempotency and audit evidence.",
        );
      }

      const authoritativeOperationId = operationRow.operationId;
      if (
        !canBindAgentReservationFinalization(
          {
            finalizationId: lockedReservation.finalizationId,
            upstreamOperationId: lockedReservation.upstreamOperationId,
            upstreamHash: lockedReservation.upstreamHash,
          },
          {
            finalizationId: finalClaim.claim.id,
            upstreamOperationId: authoritativeOperationId,
            upstreamHash,
          },
        )
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "This reservation is already bound to a different finalization or operational result.",
        );
      }
      const reservationEnvelope = record(lockedReservationRow.responseBody);
      if (!reservationEnvelope) {
        throw new TeamMutationFailure(
          "internal",
          "The Agent reservation cannot be finalized safely.",
        );
      }
      await tx
        .update(teamMutationIdempotency)
        .set({
          responseBody: {
            ...reservationEnvelope,
            data: {
              ...lockedReservation,
              finalizationId: finalClaim.claim.id,
              upstreamOperationId: authoritativeOperationId,
              upstreamHash,
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(teamMutationIdempotency.id, lockedReservationRow.id));

      let result: MutationResult<{
        actionType: AgentActionType;
        result: Record<string, unknown>;
      }>;
      let responseStatus = status;
      if (upstream.ok) {
        const descriptor = upstream.descriptor;
        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: descriptor.entityType,
          entityId: descriptor.entityId,
          after: {
            actionType,
            version: descriptor.version,
            externalEffect:
              actionType === "send_text" ||
              actionType === "google_ads_recommendations_bulk_apply"
                ? "durably_requested"
                : "committed",
          },
          metadata: {
            surface: "/team/tools/agent",
            reservationId: lockedReservation.reservationId,
            approvalId: lockedReservation.approvalId,
            actionPermissions: [...AGENT_ACTION_PERMISSIONS[actionType]],
            upstreamOperationId: upstream.receipt.operationId,
            upstreamCorrelationId: upstream.receipt.correlationId,
            upstreamAuditEventId: upstream.receipt.auditEventId,
            upstreamCommittedAt: upstream.receipt.committedAt,
          },
          providerOperationId:
            upstream.receipt.providerOperationId ??
            descriptor.providerOperationId ??
            null,
        });
        result = {
          ok: true,
          data: {
            actionType,
            result: {
              ...upstream.data,
              summary:
                typeof upstream.data["summary"] === "string" &&
                upstream.data["summary"].trim()
                  ? upstream.data["summary"].trim()
                  : actionSummary(actionType),
            },
          },
          receipt: {
            operationId: finalClaim.claim.operationId,
            correlationId: mutation.correlationId,
            actorId,
            committedAt: audit.committedAt,
            auditEventId: audit.auditEventId,
            entityType: descriptor.entityType,
            entityId: descriptor.entityId,
            version: descriptor.version,
            ...(upstream.receipt.providerOperationId ||
            descriptor.providerOperationId
              ? {
                  providerOperationId:
                    upstream.receipt.providerOperationId ??
                    descriptor.providerOperationId,
                }
              : {}),
          },
        };
      } else {
        result = {
          ...upstream,
          // A failed, already-approved operation must be reviewed before a
          // different payload or key is issued. Exact retries replay this row.
          retryable: false,
        };
        await recordTeamMutationFailure(
          mutation,
          {
            outcome: "failed",
            entityType: "agent_action",
            entityId: lockedReservation.approvalId,
            code: upstream.code,
            metadata: {
              surface: "/team/tools/agent",
              reservationId: lockedReservation.reservationId,
              approvalId: lockedReservation.approvalId,
              actionType,
              downstreamStatus: status,
            },
          },
          async (event) => {
            await tx.insert(auditLogs).values(event);
          },
        );
        if (responseStatus < 400) responseStatus = 500;
      }
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        finalClaim.claim,
        result,
        responseStatus,
      );
      return { result, status: responseStatus };
    });
    return teamMutationResultResponse(
      finalized.result,
      finalized.status,
      mutation.correlationId,
      { "Cache-Control": "private, no-store, max-age=0" },
    );
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
