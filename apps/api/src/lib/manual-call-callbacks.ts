import { createHash, randomUUID } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  auditLogs,
  callRecords,
  contacts,
  crmTasks,
  outboxEvents,
  teamCallOperationCallbackEvents,
  teamCallOperationTaskIntents,
  teamCallOperations,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

type CallOperationRow = typeof teamCallOperations.$inferSelect;
type CallCallbackKind =
  | "connect"
  | "agent_status"
  | "customer_status"
  | "dial_action";
type CallLeg = "agent" | "customer";

const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/iu;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CALLBACK_DEADLINE_MS = 4 * 60 * 60 * 1_000;
const TERMINAL_CALLBACK_GRACE_MS = 5 * 60 * 1_000;
const ACTIVE_STATUSES = new Set([
  "queued",
  "initiated",
  "ringing",
  "answered",
  "in-progress",
]);
const NEGATIVE_TERMINAL_STATUSES = new Set([
  "busy",
  "no-answer",
  "failed",
  "canceled",
]);
const CALLBACK_STATUSES = new Set([
  ...ACTIVE_STATUSES,
  ...NEGATIVE_TERMINAL_STATUSES,
  "completed",
]);

async function ensureManualCallRecordAndRecording(
  tx: TeamMutationTransaction,
  input: {
    operation: CallOperationRow;
    parentCallSid: string;
    customerCallSid: string;
    status: string;
    durationSec: number | null;
    enqueueRecording: boolean;
    now: Date;
  },
): Promise<void> {
  const [existing] = await tx
    .select({
      id: callRecords.id,
      parentCallSid: callRecords.parentCallSid,
      contactId: callRecords.contactId,
      assignedTo: callRecords.assignedTo,
    })
    .from(callRecords)
    .where(eq(callRecords.callSid, input.customerCallSid))
    .for("update")
    .limit(1);
  if (
    existing &&
    (existing.parentCallSid !== input.parentCallSid ||
      existing.contactId !== input.operation.contactId ||
      existing.assignedTo !== input.operation.agentMemberId)
  ) {
    throw new ManualCallCallbackError("call_record_identity_mismatch", 409);
  }
  if (existing) {
    await tx
      .update(callRecords)
      .set({
        callStatus: input.status,
        callDurationSec: input.durationSec,
        updatedAt: input.now,
      })
      .where(eq(callRecords.id, existing.id));
  } else {
    await tx.insert(callRecords).values({
      callSid: input.customerCallSid,
      parentCallSid: input.parentCallSid,
      direction: "outbound",
      mode: "team_manual",
      from: null,
      to: null,
      contactId: input.operation.contactId,
      assignedTo: input.operation.agentMemberId,
      callStatus: input.status,
      callDurationSec: input.durationSec,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  if (!input.enqueueRecording) return;
  const [queued] = await tx
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, "call.recording.process"),
        isNull(outboxEvents.processedAt),
        isNull(outboxEvents.quarantinedAt),
        sql`${outboxEvents.payload} ->> 'callSid' = ${input.customerCallSid}`,
      ),
    )
    .limit(1);
  if (!queued?.id) {
    await tx.insert(outboxEvents).values({
      type: "call.recording.process",
      payload: {
        callSid: input.customerCallSid,
        recordingEmptyPolls: 0,
      },
      nextAttemptAt: new Date(input.now.getTime() + 60_000),
      createdAt: input.now,
    });
  }
}

export class ManualCallCallbackError extends Error {
  readonly status: 400 | 404 | 409 | 500;

  constructor(message: string, status: 400 | 404 | 409 | 500 = 409) {
    super(message);
    this.name = "ManualCallCallbackError";
    this.status = status;
  }
}

export type ManualCallDialOutcome =
  | { kind: "connected"; reason: "customer_bridge_completed" }
  | {
      kind: "not_connected";
      reason:
        | "customer_busy"
        | "customer_no_answer"
        | "customer_failed"
        | "customer_canceled";
    }
  | { kind: "reconciliation_required"; reason: string };

export type ManualCallCallbackResult = {
  operationId: string;
  operationVersion: number;
  state: "active" | "succeeded" | "failed" | "reconciliation_required";
  duplicate: boolean;
};

export type ManualCallConnectResult = ManualCallCallbackResult &
  (
    | {
        customerDialAllowed: true;
        customerPhone: string;
        taskId: string | null;
      }
    | { customerDialAllowed: false; customerPhone: null; taskId: string | null }
  );

function normalizeStatus(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function isManualCallCallbackStatus(value: string | null): boolean {
  const normalized = normalizeStatus(value);
  return normalized !== null && CALLBACK_STATUSES.has(normalized);
}

function requireCallbackStatus(value: string | null): string {
  const normalized = normalizeStatus(value);
  if (!normalized || !CALLBACK_STATUSES.has(normalized)) {
    throw new ManualCallCallbackError("invalid_call_status", 400);
  }
  return normalized;
}

function requireRequestKey(value: string): string {
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new ManualCallCallbackError("invalid_request_key", 400);
  }
  return normalized;
}

function requireCallSid(value: string | null, field: string): string {
  const normalized = value?.trim() ?? "";
  if (!CALL_SID_PATTERN.test(normalized)) {
    throw new ManualCallCallbackError(`invalid_${field}`, 400);
  }
  return normalized;
}

function safeDuration(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 24 * 60 * 60) {
    throw new ManualCallCallbackError("invalid_call_duration", 400);
  }
  return value;
}

function earlierDate(current: Date | null, candidate: Date): Date {
  if (!current) return candidate;
  return current.getTime() <= candidate.getTime() ? current : candidate;
}

function callbackHash(input: {
  kind: CallCallbackKind;
  leg: CallLeg;
  parentCallSid: string | null;
  customerCallSid: string | null;
  status: string | null;
  durationSec: number | null;
  bridged: boolean | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        leg: input.leg,
        parentCallSid: input.parentCallSid,
        customerCallSid: input.customerCallSid,
        status: normalizeStatus(input.status),
        durationSec: input.durationSec,
        bridged: input.bridged,
      }),
      "utf8",
    )
    .digest("hex");
}

function normalizedPhone(value: string | null): string | null {
  if (!value) return null;
  const parsed = parsePhoneNumberFromString(value, "US");
  return parsed?.isValid() === true ? parsed.number : null;
}

export function classifyManualCallDialAction(input: {
  dialCallStatus: string | null;
  dialCallDuration: number | null;
  dialBridged: boolean | null;
}): ManualCallDialOutcome {
  const status = normalizeStatus(input.dialCallStatus);
  const duration = input.dialCallDuration;
  if (
    status === "completed" &&
    input.dialBridged === true &&
    duration !== null &&
    duration > 0
  ) {
    return { kind: "connected", reason: "customer_bridge_completed" };
  }
  if (
    status &&
    NEGATIVE_TERMINAL_STATUSES.has(status) &&
    input.dialBridged === false &&
    (duration ?? 0) === 0
  ) {
    return {
      kind: "not_connected",
      reason: `customer_${status.replace("-", "_")}` as Extract<
        ManualCallDialOutcome,
        { kind: "not_connected" }
      >["reason"],
    };
  }
  return {
    kind: "reconciliation_required",
    reason: "dial_action_facts_incomplete_or_contradictory",
  };
}

function terminalOutcomeMatchesDialOutcome(
  terminalOutcome: CallOperationRow["terminalOutcome"],
  outcome: ManualCallDialOutcome,
): boolean {
  return (
    (outcome.kind === "connected" && terminalOutcome === "connected") ||
    (outcome.kind === "not_connected" && terminalOutcome === "not_connected")
  );
}

export function classifyManualCallCallbackApplication(input: {
  state: string;
  terminalOutcome: CallOperationRow["terminalOutcome"];
  dialOutcome?: ManualCallDialOutcome | null;
}): "applied" | "late" | "anomaly" {
  if (input.dialOutcome?.kind === "reconciliation_required") return "anomaly";
  if (input.state === "reconciliation_required") return "late";
  if (input.state === "succeeded" || input.state === "failed") {
    if (!input.dialOutcome) return "late";
    return terminalOutcomeMatchesDialOutcome(
      input.terminalOutcome,
      input.dialOutcome,
    )
      ? "late"
      : "anomaly";
  }
  return "applied";
}

async function lockOperationByRequestKey(
  tx: Parameters<DatabaseClient["transaction"]>[0] extends (
    tx: infer Transaction,
  ) => Promise<unknown>
    ? Transaction
    : never,
  requestKey: string,
): Promise<CallOperationRow> {
  const [candidate] = await tx
    .select({
      id: teamCallOperations.id,
      contactId: teamCallOperations.contactId,
    })
    .from(teamCallOperations)
    .where(eq(teamCallOperations.providerRequestKey, requestKey))
    .limit(1);
  if (!candidate) {
    throw new ManualCallCallbackError("call_operation_not_found", 404);
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.contactId}, 0))`,
  );
  const [operation] = await tx
    .select()
    .from(teamCallOperations)
    .where(eq(teamCallOperations.id, candidate.id))
    .for("update")
    .limit(1);
  if (!operation) {
    throw new ManualCallCallbackError("call_operation_not_found", 404);
  }
  return operation;
}

function validateOperationSids(
  operation: CallOperationRow,
  parentCallSid: string,
  customerCallSid: string | null,
): void {
  if (
    operation.providerOperationId &&
    operation.providerOperationId !== parentCallSid
  ) {
    throw new ManualCallCallbackError("parent_call_identity_conflict");
  }
  if (
    customerCallSid &&
    operation.providerCustomerOperationId &&
    operation.providerCustomerOperationId !== customerCallSid
  ) {
    throw new ManualCallCallbackError("customer_call_identity_conflict");
  }
}

async function insertCallbackEvent(
  tx: Parameters<DatabaseClient["transaction"]>[0] extends (
    tx: infer Transaction,
  ) => Promise<unknown>
    ? Transaction
    : never,
  input: {
    operationId: string;
    kind: CallCallbackKind;
    leg: CallLeg;
    parentCallSid: string | null;
    customerCallSid: string | null;
    status: string | null;
    durationSec: number | null;
    bridged: boolean | null;
    applyResult: "applied" | "late" | "anomaly";
    receivedAt: Date;
  },
): Promise<boolean> {
  const semanticHash = callbackHash(input);
  const [inserted] = await tx
    .insert(teamCallOperationCallbackEvents)
    .values({
      callOperationId: input.operationId,
      kind: input.kind,
      leg: input.leg,
      semanticHash,
      parentCallSid: input.parentCallSid,
      customerCallSid: input.customerCallSid,
      status: normalizeStatus(input.status),
      durationSec: input.durationSec,
      bridged: input.bridged,
      applyResult: input.applyResult,
      receivedAt: input.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: teamCallOperationCallbackEvents.id });
  return Boolean(inserted);
}

async function insertSystemAudit(
  tx: Parameters<DatabaseClient["transaction"]>[0] extends (
    tx: infer Transaction,
  ) => Promise<unknown>
    ? Transaction
    : never,
  operation: CallOperationRow,
  input: {
    action: string;
    outcome: "attempted" | "succeeded" | "failed";
    actorAttribution?: "initiator" | "service";
    providerOperationId: string | null;
    metadata: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<string> {
  const auditEventId = randomUUID();
  const attributeToInitiator = input.actorAttribution === "initiator";
  await tx.insert(auditLogs).values({
    id: auditEventId,
    actorType: attributeToInitiator ? "human" : "worker",
    actorId: attributeToInitiator ? operation.actorMemberId : null,
    actorLabel: attributeToInitiator ? operation.actorLabel : "twilio_webhook",
    actorRole: attributeToInitiator ? operation.actorRole : "provider_callback",
    sessionId: attributeToInitiator ? operation.sessionId : null,
    authMethod: attributeToInitiator ? operation.authMethod : "service",
    correlationId: operation.correlationId,
    requiredPermissions: attributeToInitiator ? ["calls.place"] : [],
    outcome: input.outcome,
    providerOperationId: input.providerOperationId,
    idempotencyKeyHash: operation.idempotencyKeyHash,
    action: input.action,
    entityType: "contact",
    entityId: operation.contactId,
    meta: sanitizeAuditMetadata({
      callOperationId: operation.id,
      initiatedByMemberId: operation.actorMemberId,
      initiatedBySessionId: operation.sessionId,
      agentMemberId: operation.agentMemberId,
      provider: operation.provider,
      signatureVerified: true,
      settledBy: "twilio_webhook",
      ...input.metadata,
    }),
    createdAt: input.occurredAt,
  });
  return auditEventId;
}

async function ensureProviderAcceptedAudit(
  tx: Parameters<DatabaseClient["transaction"]>[0] extends (
    tx: infer Transaction,
  ) => Promise<unknown>
    ? Transaction
    : never,
  operation: CallOperationRow,
  parentCallSid: string,
  now: Date,
): Promise<string> {
  if (operation.providerAcceptedAuditEventId) {
    return operation.providerAcceptedAuditEventId;
  }
  return insertSystemAudit(tx, operation, {
    action: "call.provider_accepted",
    outcome: "attempted",
    actorAttribution: "initiator",
    providerOperationId: parentCallSid,
    metadata: {
      state: "active",
      evidenceSource: "signed_callback",
      taskEffects: "pending",
      providerIdempotencySupported: false,
    },
    occurredAt: operation.providerAcceptedAt ?? now,
  });
}

async function quarantineOperation(
  tx: Parameters<DatabaseClient["transaction"]>[0] extends (
    tx: infer Transaction,
  ) => Promise<unknown>
    ? Transaction
    : never,
  operation: CallOperationRow,
  input: {
    parentCallSid: string | null;
    customerCallSid: string | null;
    code: string;
    detail: string;
    now: Date;
  },
): Promise<CallOperationRow> {
  if (operation.state === "reconciliation_required") return operation;
  if (operation.state === "succeeded" || operation.state === "failed") {
    return operation;
  }
  const providerAcceptedAuditEventId = input.parentCallSid
    ? await ensureProviderAcceptedAudit(
        tx,
        operation,
        input.parentCallSid,
        input.now,
      )
    : operation.providerAcceptedAuditEventId;
  const auditEventId = await insertSystemAudit(tx, operation, {
    action: "call.callback_reconciliation_required",
    outcome: "failed",
    providerOperationId: input.parentCallSid,
    metadata: {
      failureCode: input.code,
      failureDetail: input.detail,
      taskEffectsApplied: false,
      contactCallBlockCleared: false,
    },
    occurredAt: input.now,
  });
  const completedAt = new Date(
    Math.max(input.now.getTime(), (operation.dispatchedAt?.getTime() ?? 0) + 1),
  );
  const [updated] = await tx
    .update(teamCallOperations)
    .set({
      state: "reconciliation_required",
      version: operation.version + 1,
      providerOperationId: operation.providerOperationId ?? input.parentCallSid,
      providerCustomerOperationId:
        operation.providerCustomerOperationId ?? input.customerCallSid,
      providerAcceptedAuditEventId,
      providerAcceptedAt:
        operation.providerAcceptedAt ??
        (input.parentCallSid ? input.now : null),
      providerStatus:
        operation.providerStatus ?? (input.parentCallSid ? 201 : null),
      terminalAuditEventId: auditEventId,
      completedAt,
      reconciliationRequiredAt: completedAt,
      failureCode: input.code,
      failureDetail: input.detail,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(teamCallOperations.id, operation.id),
        eq(teamCallOperations.state, operation.state),
        eq(teamCallOperations.version, operation.version),
      ),
    )
    .returning();
  if (!updated) throw new ManualCallCallbackError("call_operation_conflict");
  return updated;
}

async function settleNotConnected(
  tx: Parameters<DatabaseClient["transaction"]>[0] extends (
    tx: infer Transaction,
  ) => Promise<unknown>
    ? Transaction
    : never,
  operation: CallOperationRow,
  input: {
    parentCallSid: string;
    customerCallSid: string | null;
    reason: string;
    now: Date;
  },
): Promise<CallOperationRow> {
  const providerAcceptedAuditEventId = await ensureProviderAcceptedAudit(
    tx,
    operation,
    input.parentCallSid,
    input.now,
  );
  await tx
    .update(teamCallOperationTaskIntents)
    .set({ effect: "not_connected", effectAt: input.now })
    .where(
      and(
        eq(teamCallOperationTaskIntents.callOperationId, operation.id),
        eq(teamCallOperationTaskIntents.effect, "pending"),
      ),
    );
  const auditEventId = await insertSystemAudit(tx, operation, {
    action: "call.not_connected",
    outcome: "failed",
    actorAttribution: "initiator",
    providerOperationId: input.parentCallSid,
    metadata: {
      terminalOutcome: "not_connected",
      outcomeReason: input.reason,
      taskEffectsApplied: false,
      customerCallSidPresent: Boolean(input.customerCallSid),
    },
    occurredAt: input.now,
  });
  const completedAt = new Date(
    Math.max(input.now.getTime(), (operation.dispatchedAt?.getTime() ?? 0) + 1),
  );
  const [updated] = await tx
    .update(teamCallOperations)
    .set({
      state: "failed",
      version: operation.version + 1,
      providerOperationId: operation.providerOperationId ?? input.parentCallSid,
      providerCustomerOperationId:
        operation.providerCustomerOperationId ?? input.customerCallSid,
      providerAcceptedAuditEventId,
      providerAcceptedAt: operation.providerAcceptedAt ?? input.now,
      providerStatus: operation.providerStatus ?? 201,
      terminalAuditEventId: auditEventId,
      terminalOutcome: "not_connected",
      outcomeReason: input.reason,
      guardReleasedAt: completedAt,
      completedAt,
      customerCompletedAt:
        operation.customerCompletedAt ??
        (input.customerCallSid ? completedAt : null),
      failureCode: input.reason,
      failureDetail:
        "The signed Twilio callback confirmed that the customer leg did not connect.",
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(teamCallOperations.id, operation.id),
        eq(teamCallOperations.state, operation.state),
        eq(teamCallOperations.version, operation.version),
      ),
    )
    .returning();
  if (!updated) throw new ManualCallCallbackError("call_operation_conflict");
  return updated;
}

export async function completeSnapshottedTasks(
  tx: Parameters<DatabaseClient["transaction"]>[0] extends (
    tx: infer Transaction,
  ) => Promise<unknown>
    ? Transaction
    : never,
  operation: CallOperationRow,
  now: Date,
): Promise<{
  completedExplicitTaskId: string | null;
  completedFollowupTaskId: string | null;
  completedSpeedToLeadCount: number;
}> {
  const intents = await tx
    .select()
    .from(teamCallOperationTaskIntents)
    .where(
      and(
        eq(teamCallOperationTaskIntents.callOperationId, operation.id),
        eq(teamCallOperationTaskIntents.effect, "pending"),
      ),
    )
    .orderBy(
      asc(teamCallOperationTaskIntents.taskId),
      asc(teamCallOperationTaskIntents.kind),
    )
    .for("update");

  const byTask = new Map<string, typeof intents>();
  for (const intent of intents) {
    const existing = byTask.get(intent.taskId) ?? [];
    existing.push(intent);
    byTask.set(intent.taskId, existing);
  }

  const completed = new Set<string>();
  for (const taskId of [...byTask.keys()].sort()) {
    const taskIntents = byTask.get(taskId) ?? [];
    const expected = taskIntents[0];
    if (!expected) continue;
    const [task] = await tx
      .select({
        id: crmTasks.id,
        contactId: crmTasks.contactId,
        assignedTo: crmTasks.assignedTo,
        status: crmTasks.status,
        updatedAt: crmTasks.updatedAt,
      })
      .from(crmTasks)
      .where(eq(crmTasks.id, taskId))
      .for("update")
      .limit(1);

    let effect: "completed" | "stale" | "already_terminal";
    if (!task || task.status !== "open") {
      effect = "already_terminal";
    } else if (
      task.contactId !== expected.expectedContactId ||
      task.assignedTo !== expected.expectedAssignedTo ||
      task.updatedAt.getTime() !== expected.expectedUpdatedAt.getTime()
    ) {
      effect = "stale";
    } else {
      const [updated] = await tx
        .update(crmTasks)
        .set({ status: "completed", updatedAt: now })
        .where(
          and(
            eq(crmTasks.id, task.id),
            eq(crmTasks.contactId, expected.expectedContactId),
            eq(crmTasks.assignedTo, expected.expectedAssignedTo),
            eq(crmTasks.status, "open"),
            eq(crmTasks.updatedAt, expected.expectedUpdatedAt),
          ),
        )
        .returning({ id: crmTasks.id });
      effect = updated ? "completed" : "stale";
      if (updated) completed.add(updated.id);
    }

    await tx
      .update(teamCallOperationTaskIntents)
      .set({ effect, effectAt: now })
      .where(
        and(
          eq(teamCallOperationTaskIntents.callOperationId, operation.id),
          eq(teamCallOperationTaskIntents.taskId, taskId),
          eq(teamCallOperationTaskIntents.effect, "pending"),
        ),
      );
  }

  let completedExplicitTaskId: string | null = null;
  let completedFollowupTaskId: string | null = null;
  const completedSpeedTaskIds = new Set<string>();
  for (const intent of intents) {
    if (!completed.has(intent.taskId)) continue;
    if (intent.kind === "explicit") completedExplicitTaskId ??= intent.taskId;
    if (intent.kind === "follow_up") completedFollowupTaskId ??= intent.taskId;
    if (intent.kind === "speed_to_lead") {
      completedSpeedTaskIds.add(intent.taskId);
    }
  }
  return {
    completedExplicitTaskId,
    completedFollowupTaskId,
    completedSpeedToLeadCount: completedSpeedTaskIds.size,
  };
}

async function settleConnected(
  tx: Parameters<DatabaseClient["transaction"]>[0] extends (
    tx: infer Transaction,
  ) => Promise<unknown>
    ? Transaction
    : never,
  operation: CallOperationRow,
  input: {
    parentCallSid: string;
    customerCallSid: string;
    durationSec: number;
    now: Date;
  },
): Promise<CallOperationRow> {
  const providerAcceptedAuditEventId = await ensureProviderAcceptedAudit(
    tx,
    operation,
    input.parentCallSid,
    input.now,
  );
  const taskEffects = await completeSnapshottedTasks(tx, operation, input.now);
  const auditEventId = await insertSystemAudit(tx, operation, {
    action: "call.started",
    outcome: "succeeded",
    actorAttribution: "initiator",
    providerOperationId: input.parentCallSid,
    metadata: {
      terminalOutcome: "connected",
      outcomeReason: "customer_bridge_completed",
      providerReportedBridge: true,
      providerReportedDurationSec: input.durationSec,
      taskEffectsApplied: true,
      ...taskEffects,
    },
    occurredAt: input.now,
  });
  const completedAt = new Date(
    Math.max(input.now.getTime(), (operation.dispatchedAt?.getTime() ?? 0) + 1),
  );
  const [updated] = await tx
    .update(teamCallOperations)
    .set({
      state: "succeeded",
      version: operation.version + 1,
      providerOperationId: operation.providerOperationId ?? input.parentCallSid,
      providerCustomerOperationId:
        operation.providerCustomerOperationId ?? input.customerCallSid,
      providerAcceptedAuditEventId,
      providerAcceptedAt: operation.providerAcceptedAt ?? input.now,
      providerStatus: operation.providerStatus ?? 201,
      customerAnsweredAt: operation.customerAnsweredAt ?? input.now,
      customerCompletedAt: completedAt,
      terminalAuditEventId: auditEventId,
      terminalOutcome: "connected",
      outcomeReason: "customer_bridge_completed",
      guardReleasedAt: completedAt,
      completedExplicitTaskId: taskEffects.completedExplicitTaskId,
      completedFollowupTaskId: taskEffects.completedFollowupTaskId,
      completedSpeedToLeadCount: taskEffects.completedSpeedToLeadCount,
      completedAt,
      failureCode: null,
      failureDetail: null,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(teamCallOperations.id, operation.id),
        eq(teamCallOperations.state, operation.state),
        eq(teamCallOperations.version, operation.version),
      ),
    )
    .returning();
  if (!updated) throw new ManualCallCallbackError("call_operation_conflict");
  return updated;
}

export async function handleManualCallConnectCallback(input: {
  db: DatabaseClient;
  requestKey: string;
  parentCallSid: string | null;
  now?: Date;
}): Promise<ManualCallConnectResult> {
  const requestKey = requireRequestKey(input.requestKey);
  const parentCallSid = requireCallSid(input.parentCallSid, "parent_call_sid");
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    let operation = await lockOperationByRequestKey(tx, requestKey);
    validateOperationSids(operation, parentCallSid, null);
    const terminal =
      operation.state === "succeeded" || operation.state === "failed";
    const inserted = await insertCallbackEvent(tx, {
      operationId: operation.id,
      kind: "connect",
      leg: "agent",
      parentCallSid,
      customerCallSid: null,
      status: "answered",
      durationSec: null,
      bridged: null,
      applyResult: classifyManualCallCallbackApplication({
        state: operation.state,
        terminalOutcome: operation.terminalOutcome,
      }),
      receivedAt: now,
    });

    if (
      !terminal &&
      inserted &&
      operation.state !== "reconciliation_required"
    ) {
      const providerAcceptedAuditEventId = await ensureProviderAcceptedAudit(
        tx,
        operation,
        parentCallSid,
        now,
      );
      const [active] = await tx
        .update(teamCallOperations)
        .set({
          state: "active",
          version: operation.version + 1,
          providerOperationId: parentCallSid,
          providerAcceptedAuditEventId,
          providerAcceptedAt: operation.providerAcceptedAt ?? now,
          providerStatus: operation.providerStatus ?? 201,
          agentAnsweredAt: operation.agentAnsweredAt ?? now,
          callbackDeadlineAt:
            operation.callbackDeadlineAt ??
            new Date(now.getTime() + CALLBACK_DEADLINE_MS),
          updatedAt: now,
        })
        .where(
          and(
            eq(teamCallOperations.id, operation.id),
            eq(teamCallOperations.state, operation.state),
            eq(teamCallOperations.version, operation.version),
          ),
        )
        .returning();
      if (!active) throw new ManualCallCallbackError("call_operation_conflict");
      operation = active;
    }

    const [contact] = await tx
      .select({
        phone: contacts.phone,
        phoneE164: contacts.phoneE164,
        doNotContact: contacts.doNotContact,
        deletedAt: contacts.deletedAt,
      })
      .from(contacts)
      .where(eq(contacts.id, operation.contactId))
      .for("update")
      .limit(1);
    const customerPhone = normalizedPhone(
      contact?.phoneE164 ?? contact?.phone ?? null,
    );
    const suppressed =
      terminal ||
      operation.state === "reconciliation_required" ||
      !contact ||
      Boolean(contact.deletedAt) ||
      contact.doNotContact ||
      !customerPhone;
    if (
      suppressed &&
      !terminal &&
      operation.state !== "reconciliation_required"
    ) {
      operation = await settleNotConnected(tx, operation, {
        parentCallSid,
        customerCallSid: null,
        reason: "customer_dial_suppressed",
        now,
      });
    }
    const customerDialAllowed = !suppressed && inserted;
    return {
      operationId: operation.id,
      operationVersion: operation.version,
      state:
        operation.state === "reconciliation_required"
          ? "reconciliation_required"
          : operation.state === "succeeded"
            ? "succeeded"
            : operation.state === "failed"
              ? "failed"
              : "active",
      duplicate: !inserted,
      customerDialAllowed,
      customerPhone: customerDialAllowed ? customerPhone : null,
      taskId: operation.taskId,
    } as ManualCallConnectResult;
  });
}

export async function handleManualCallStatusCallback(input: {
  db: DatabaseClient;
  requestKey: string;
  leg: CallLeg;
  callSid: string | null;
  parentCallSid: string | null;
  callStatus: string | null;
  callDuration: number | null;
  now?: Date;
}): Promise<ManualCallCallbackResult> {
  const requestKey = requireRequestKey(input.requestKey);
  const status = requireCallbackStatus(input.callStatus);
  const durationSec = safeDuration(input.callDuration);
  const now = input.now ?? new Date();
  const parentCallSid =
    input.leg === "agent"
      ? requireCallSid(input.callSid, "parent_call_sid")
      : requireCallSid(input.parentCallSid, "parent_call_sid");
  const customerCallSid =
    input.leg === "customer"
      ? requireCallSid(input.callSid, "customer_call_sid")
      : null;
  return input.db.transaction(async (tx) => {
    let operation = await lockOperationByRequestKey(tx, requestKey);
    validateOperationSids(operation, parentCallSid, customerCallSid);
    const terminal =
      operation.state === "succeeded" || operation.state === "failed";
    const inserted = await insertCallbackEvent(tx, {
      operationId: operation.id,
      kind: input.leg === "agent" ? "agent_status" : "customer_status",
      leg: input.leg,
      parentCallSid,
      customerCallSid,
      status,
      durationSec,
      bridged: null,
      applyResult: classifyManualCallCallbackApplication({
        state: operation.state,
        terminalOutcome: operation.terminalOutcome,
      }),
      receivedAt: now,
    });
    if (
      !inserted ||
      terminal ||
      operation.state === "reconciliation_required"
    ) {
      return {
        operationId: operation.id,
        operationVersion: operation.version,
        state:
          operation.state === "succeeded"
            ? "succeeded"
            : operation.state === "failed"
              ? "failed"
              : operation.state === "reconciliation_required"
                ? "reconciliation_required"
                : "active",
        duplicate: !inserted,
      };
    }
    if (
      input.leg === "agent" &&
      NEGATIVE_TERMINAL_STATUSES.has(status) &&
      !operation.agentAnsweredAt &&
      !operation.providerCustomerOperationId
    ) {
      operation = await settleNotConnected(tx, operation, {
        parentCallSid,
        customerCallSid: null,
        reason: `agent_${status.replace("-", "_")}`,
        now,
      });
    } else {
      const terminalStatus =
        NEGATIVE_TERMINAL_STATUSES.has(status) || status === "completed";
      const nextDeadline = terminalStatus
        ? earlierDate(
            operation.callbackDeadlineAt,
            new Date(now.getTime() + TERMINAL_CALLBACK_GRACE_MS),
          )
        : (operation.callbackDeadlineAt ??
          new Date(now.getTime() + CALLBACK_DEADLINE_MS));
      const providerAcceptedAuditEventId = await ensureProviderAcceptedAudit(
        tx,
        operation,
        parentCallSid,
        now,
      );
      const [active] = await tx
        .update(teamCallOperations)
        .set({
          state: "active",
          version: operation.version + 1,
          providerOperationId: operation.providerOperationId ?? parentCallSid,
          providerCustomerOperationId:
            operation.providerCustomerOperationId ?? customerCallSid,
          providerAcceptedAuditEventId,
          providerAcceptedAt: operation.providerAcceptedAt ?? now,
          providerStatus: operation.providerStatus ?? 201,
          agentAnsweredAt:
            input.leg === "agent" &&
            (status === "answered" || status === "in-progress")
              ? (operation.agentAnsweredAt ?? now)
              : operation.agentAnsweredAt,
          customerAnsweredAt:
            input.leg === "customer" &&
            (status === "answered" || status === "in-progress")
              ? (operation.customerAnsweredAt ?? now)
              : operation.customerAnsweredAt,
          agentCompletedAt:
            input.leg === "agent" && terminalStatus
              ? (operation.agentCompletedAt ?? now)
              : operation.agentCompletedAt,
          customerCompletedAt:
            input.leg === "customer" && terminalStatus
              ? (operation.customerCompletedAt ?? now)
              : operation.customerCompletedAt,
          callbackDeadlineAt: nextDeadline,
          updatedAt: now,
        })
        .where(
          and(
            eq(teamCallOperations.id, operation.id),
            eq(teamCallOperations.state, operation.state),
            eq(teamCallOperations.version, operation.version),
          ),
        )
        .returning();
      if (!active) throw new ManualCallCallbackError("call_operation_conflict");
      operation = active;
    }
    return {
      operationId: operation.id,
      operationVersion: operation.version,
      state:
        operation.state === "succeeded"
          ? "succeeded"
          : operation.state === "failed"
            ? "failed"
            : operation.state === "reconciliation_required"
              ? "reconciliation_required"
              : "active",
      duplicate: false,
    };
  });
}

export async function handleManualCallDialActionCallback(input: {
  db: DatabaseClient;
  requestKey: string;
  parentCallSid: string | null;
  customerCallSid: string | null;
  dialCallStatus: string | null;
  dialCallDuration: number | null;
  dialBridged: boolean | null;
  now?: Date;
}): Promise<ManualCallCallbackResult> {
  const requestKey = requireRequestKey(input.requestKey);
  const parentCallSid = requireCallSid(input.parentCallSid, "parent_call_sid");
  const customerCallSid = requireCallSid(
    input.customerCallSid,
    "customer_call_sid",
  );
  const durationSec = safeDuration(input.dialCallDuration);
  const dialCallStatus = requireCallbackStatus(input.dialCallStatus);
  const now = input.now ?? new Date();
  const outcome = classifyManualCallDialAction({
    dialCallStatus,
    dialCallDuration: durationSec,
    dialBridged: input.dialBridged,
  });

  return input.db.transaction(async (tx) => {
    let operation = await lockOperationByRequestKey(tx, requestKey);
    validateOperationSids(operation, parentCallSid, customerCallSid);
    const terminal =
      operation.state === "succeeded" || operation.state === "failed";
    const inserted = await insertCallbackEvent(tx, {
      operationId: operation.id,
      kind: "dial_action",
      leg: "customer",
      parentCallSid,
      customerCallSid,
      status: dialCallStatus,
      durationSec,
      bridged: input.dialBridged,
      applyResult: classifyManualCallCallbackApplication({
        state: operation.state,
        terminalOutcome: operation.terminalOutcome,
        dialOutcome: outcome,
      }),
      receivedAt: now,
    });
    if (
      !inserted ||
      terminal ||
      operation.state === "reconciliation_required"
    ) {
      return {
        operationId: operation.id,
        operationVersion: operation.version,
        state:
          operation.state === "succeeded"
            ? "succeeded"
            : operation.state === "failed"
              ? "failed"
              : operation.state === "reconciliation_required"
                ? "reconciliation_required"
                : "active",
        duplicate: !inserted,
      };
    }
    if (outcome.kind === "connected") {
      operation = await settleConnected(tx, operation, {
        parentCallSid,
        customerCallSid,
        durationSec: durationSec!,
        now,
      });
      await ensureManualCallRecordAndRecording(tx, {
        operation,
        parentCallSid,
        customerCallSid,
        status: dialCallStatus,
        durationSec,
        enqueueRecording: true,
        now,
      });
    } else if (outcome.kind === "not_connected") {
      operation = await settleNotConnected(tx, operation, {
        parentCallSid,
        customerCallSid,
        reason: outcome.reason,
        now,
      });
      await ensureManualCallRecordAndRecording(tx, {
        operation,
        parentCallSid,
        customerCallSid,
        status: dialCallStatus,
        durationSec,
        enqueueRecording: false,
        now,
      });
    } else {
      operation = await quarantineOperation(tx, operation, {
        parentCallSid,
        customerCallSid,
        code: outcome.reason,
        detail:
          "The signed dial-action callback did not contain a consistent terminal bridge outcome.",
        now,
      });
    }
    return {
      operationId: operation.id,
      operationVersion: operation.version,
      state:
        operation.state === "succeeded"
          ? "succeeded"
          : operation.state === "failed"
            ? "failed"
            : "reconciliation_required",
      duplicate: false,
    };
  });
}

export function manualCallNeedsReconciliation(
  state: string,
  callbackDeadlineAt: Date | null,
  now = new Date(),
): boolean {
  return (
    (state === "dispatched" || state === "active") &&
    callbackDeadlineAt !== null &&
    callbackDeadlineAt.getTime() <= now.getTime()
  );
}

/**
 * A bounded, explicit stale sweep. It only quarantines uncertain live calls;
 * it never releases a contact guard, completes a task, or dispatches Twilio.
 */
export async function quarantineStaleManualCalls(input: {
  db: DatabaseClient;
  now?: Date;
  limit?: number;
}): Promise<number> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const candidates = await input.db
    .select({
      id: teamCallOperations.id,
      contactId: teamCallOperations.contactId,
    })
    .from(teamCallOperations)
    .where(
      and(
        sql`${teamCallOperations.state} IN ('dispatched', 'active')`,
        isNull(teamCallOperations.guardReleasedAt),
        lte(teamCallOperations.callbackDeadlineAt, now),
      ),
    )
    .orderBy(
      asc(teamCallOperations.callbackDeadlineAt),
      asc(teamCallOperations.id),
    )
    .limit(limit);
  let quarantined = 0;
  for (const candidate of candidates) {
    const changed = await input.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.contactId}, 0))`,
      );
      const [operation] = await tx
        .select()
        .from(teamCallOperations)
        .where(eq(teamCallOperations.id, candidate.id))
        .for("update")
        .limit(1);
      if (
        !operation ||
        !manualCallNeedsReconciliation(
          operation.state,
          operation.callbackDeadlineAt,
          now,
        )
      ) {
        return false;
      }
      await quarantineOperation(tx, operation, {
        parentCallSid: operation.providerOperationId,
        customerCallSid: operation.providerCustomerOperationId,
        code: "signed_terminal_callback_missing",
        detail:
          "The callback deadline passed without a consistent signed terminal dial-action. No retry was attempted.",
        now,
      });
      return true;
    });
    if (changed) quarantined += 1;
  }
  return quarantined;
}
