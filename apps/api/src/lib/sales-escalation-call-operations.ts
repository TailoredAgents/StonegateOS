import { createHash, randomUUID } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { isTwilioCallSid } from "@myst-os/sdk";
import type { DatabaseClient } from "@/db";
import {
  auditLogs,
  callRecords,
  contacts,
  crmTasks,
  outboxEvents,
  salesEscalationCallCallbackEvents,
  salesEscalationCallOperations,
  teamMembers,
  type SalesEscalationCallDeliveryCertainty,
  type SalesEscalationCallOperationState,
  type SalesEscalationCallTerminalOutcome,
} from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import type { TwilioOutboundCallResult } from "@/lib/twilio-calls";

const CALLBACK_DEADLINE_MS = 4 * 60 * 60 * 1_000;
export const MAX_SALES_ESCALATION_CALL_ATTEMPTS = 3;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const CALLBACK_STATUSES = new Set([
  "queued",
  "initiated",
  "ringing",
  "answered",
  "in-progress",
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
]);

type OperationRow = typeof salesEscalationCallOperations.$inferSelect;

export class SalesEscalationCallbackError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 500 = 409,
  ) {
    super(message);
    this.name = "SalesEscalationCallbackError";
  }
}

export type SalesEscalationProviderOutcome = {
  state: "succeeded" | "failed" | "reconciliation_required";
  certainty: "accepted" | "not_sent" | "uncertain";
  providerOperationId: string | null;
  providerStatus: number | null;
  failureCode: string | null;
  failureDetail: string | null;
  retryable: boolean;
};

export function classifySalesEscalationProviderResult(
  result: TwilioOutboundCallResult,
): SalesEscalationProviderOutcome {
  if (result.ok) {
    return {
      state: "succeeded",
      certainty: "accepted",
      providerOperationId: result.callSid,
      providerStatus: 201,
      failureCode: null,
      failureDetail: null,
      retryable: false,
    };
  }
  if (result.deliveryCertainty === "uncertain") {
    return {
      state: "reconciliation_required",
      certainty: "uncertain",
      providerOperationId: null,
      providerStatus: result.status,
      failureCode: result.detail,
      failureDetail:
        "Twilio may have accepted the escalation call. Automatic redial is blocked until provider activity is reconciled.",
      retryable: false,
    };
  }
  return {
    state: "failed",
    certainty: "not_sent",
    providerOperationId: null,
    providerStatus: result.status,
    failureCode: result.detail,
    failureDetail: "Twilio definitively did not accept the escalation call.",
    retryable: result.retryable,
  };
}

export type PreparedSalesEscalationCall = {
  id: string;
  outboxEventId: string;
  attemptNumber: number;
  providerRequestKey: string;
  agentPhoneE164: string;
};

export type PrepareSalesEscalationCallResult =
  | { kind: "dispatch"; operation: PreparedSalesEscalationCall }
  | {
      kind: "settled";
      state: SalesEscalationCallOperationState;
      retryable: boolean;
      error: string | null;
      retryAt?: Date;
    };

function nextTimestamp(previous: Date | null, candidate = new Date()): Date {
  return new Date(
    Math.max(candidate.getTime(), (previous?.getTime() ?? 0) + 1),
  );
}

function auditMetadata(
  operationId: string,
  attemptNumber: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operationId,
    attemptNumber,
    provider: "twilio",
    providerIdempotencySupported: false,
    ...extra,
  };
}

async function insertWorkerAudit(
  tx: TeamMutationTransaction,
  input: {
    id?: string;
    action: string;
    outcome: "attempted" | "succeeded" | "failed";
    taskId: string;
    contactId: string;
    operationId: string;
    attemptNumber: number;
    providerOperationId?: string | null;
    meta?: Record<string, unknown>;
    at: Date;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  await tx.insert(auditLogs).values({
    id,
    actorType: "worker",
    actorId: null,
    actorRole: null,
    actorLabel: "outbox",
    authMethod: "service",
    correlationId: input.operationId,
    requiredPermissions: [],
    outcome: input.outcome,
    providerOperationId: input.providerOperationId ?? null,
    action: input.action,
    entityType: "crm_task",
    entityId: input.taskId,
    meta: auditMetadata(input.operationId, input.attemptNumber, {
      contactId: input.contactId,
      ...(input.meta ?? {}),
    }),
    createdAt: input.at,
  });
  return id;
}

async function markInterruptedDispatch(
  tx: TeamMutationTransaction,
  operation: OperationRow,
  now: Date,
): Promise<void> {
  const completedAt = nextTimestamp(operation.dispatchedAt, now);
  const auditEventId = await insertWorkerAudit(tx, {
    action: "sales.escalation.call.reconciliation_required",
    outcome: "failed",
    taskId: operation.taskId,
    contactId: operation.contactId,
    operationId: operation.id,
    attemptNumber: operation.attemptNumber,
    meta: {
      state: "reconciliation_required",
      failureCode: "dispatch_receipt_missing",
      redispatchPrevented: true,
    },
    at: completedAt,
  });
  const [updated] = await tx
    .update(salesEscalationCallOperations)
    .set({
      state: "reconciliation_required",
      version: operation.version + 1,
      deliveryCertainty: "uncertain",
      retryable: false,
      providerResultAuditEventId: auditEventId,
      reconciliationRequiredAt: completedAt,
      failureCode: "dispatch_receipt_missing",
      failureDetail:
        "The provider boundary was crossed without a durable result receipt. Automatic redial is blocked.",
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(salesEscalationCallOperations.id, operation.id),
        eq(salesEscalationCallOperations.state, "dispatched"),
        eq(salesEscalationCallOperations.version, operation.version),
      ),
    )
    .returning({ id: salesEscalationCallOperations.id });
  if (!updated) throw new Error("sales_escalation_dispatch_changed");
}

async function markMissingTerminalCallback(
  tx: TeamMutationTransaction,
  operation: OperationRow,
  now: Date,
): Promise<void> {
  const reconciledAt = nextTimestamp(operation.providerAcceptedAt, now);
  const auditEventId = await insertWorkerAudit(tx, {
    action: "sales.escalation.call.reconciliation_required",
    outcome: "failed",
    taskId: operation.taskId,
    contactId: operation.contactId,
    operationId: operation.id,
    attemptNumber: operation.attemptNumber,
    providerOperationId: operation.providerOperationId,
    meta: {
      state: "reconciliation_required",
      failureCode: "terminal_callback_missing",
      redispatchPrevented: true,
    },
    at: reconciledAt,
  });
  const [updated] = await tx
    .update(salesEscalationCallOperations)
    .set({
      state: "reconciliation_required",
      version: operation.version + 1,
      reconciliationRequiredAt: reconciledAt,
      failureCode: "terminal_callback_missing",
      failureDetail:
        "Twilio accepted the escalation call but no terminal signed callback arrived before the deadline. Automatic redial remains blocked pending reconciliation.",
      retryable: false,
      providerResultAuditEventId:
        operation.providerResultAuditEventId ?? auditEventId,
      updatedAt: reconciledAt,
    })
    .where(
      and(
        eq(salesEscalationCallOperations.id, operation.id),
        eq(salesEscalationCallOperations.state, "succeeded"),
        eq(salesEscalationCallOperations.version, operation.version),
        isNull(salesEscalationCallOperations.terminalAt),
      ),
    )
    .returning({ id: salesEscalationCallOperations.id });
  if (!updated) throw new Error("sales_escalation_callback_deadline_changed");
}

export function classifySalesEscalationCallbackDeadline(input: {
  callbackDeadlineAt: Date | null;
  terminalAt: Date | null;
  now: Date;
}): "terminal" | "pending" | "expired" {
  if (input.terminalAt) return "terminal";
  return input.callbackDeadlineAt &&
    input.callbackDeadlineAt.getTime() > input.now.getTime()
    ? "pending"
    : "expired";
}

async function settleExistingSalesEscalationCall(
  tx: TeamMutationTransaction,
  latest: OperationRow | null,
  now: Date,
): Promise<PrepareSalesEscalationCallResult | null> {
  if (!latest) return null;
  if (latest.state === "dispatched") {
    const deadline = classifySalesEscalationCallbackDeadline({
      callbackDeadlineAt: latest.callbackDeadlineAt,
      terminalAt: latest.terminalAt,
      now,
    });
    if (deadline === "pending" && latest.callbackDeadlineAt) {
      return {
        kind: "settled",
        state: "dispatched",
        retryable: true,
        error: "sales_escalation_dispatch_in_flight",
        retryAt: latest.callbackDeadlineAt,
      };
    }
    await markInterruptedDispatch(tx, latest, now);
    return {
      kind: "settled",
      state: "reconciliation_required",
      retryable: false,
      error: "sales_escalation_reconciliation_required",
    };
  }
  if (latest.state === "succeeded") {
    const deadline = classifySalesEscalationCallbackDeadline({
      callbackDeadlineAt: latest.callbackDeadlineAt,
      terminalAt: latest.terminalAt,
      now,
    });
    if (deadline === "terminal") {
      return {
        kind: "settled",
        state: "succeeded",
        retryable: false,
        error: null,
      };
    }
    if (deadline === "pending" && latest.callbackDeadlineAt) {
      return {
        kind: "settled",
        state: "succeeded",
        retryable: true,
        error: "sales_escalation_callback_pending",
        retryAt: latest.callbackDeadlineAt,
      };
    }
    await markMissingTerminalCallback(tx, latest, now);
    return {
      kind: "settled",
      state: "reconciliation_required",
      retryable: false,
      error: "sales_escalation_reconciliation_required",
    };
  }
  if (latest.state === "reconciliation_required") {
    return {
      kind: "settled",
      state: "reconciliation_required",
      retryable: false,
      error: "sales_escalation_reconciliation_required",
    };
  }
  if (
    latest.state === "failed" &&
    (!latest.retryable ||
      latest.attemptNumber >= MAX_SALES_ESCALATION_CALL_ATTEMPTS)
  ) {
    return {
      kind: "settled",
      state: "failed",
      retryable: false,
      error: latest.failureCode,
    };
  }
  return null;
}

export async function resumeSalesEscalationCallAttempt(input: {
  db: DatabaseClient;
  outboxEventId: string;
  taskId: string;
  now?: Date;
}): Promise<PrepareSalesEscalationCallResult | null> {
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sales_escalation_task:${input.taskId}`}, 0))`,
    );
    const [latest] = await tx
      .select()
      .from(salesEscalationCallOperations)
      .where(
        and(
          eq(salesEscalationCallOperations.outboxEventId, input.outboxEventId),
          eq(salesEscalationCallOperations.taskId, input.taskId),
        ),
      )
      .orderBy(desc(salesEscalationCallOperations.attemptNumber))
      .for("update")
      .limit(1);
    return settleExistingSalesEscalationCall(tx, latest ?? null, now);
  });
}

export async function prepareSalesEscalationCallAttempt(input: {
  db: DatabaseClient;
  outboxEventId: string;
  taskId: string;
  taskUpdatedAt: Date;
  contactId: string;
  agentMemberId: string;
  agentPhoneE164: string;
  customerPhoneE164: string;
  mode: "instant" | "scheduled";
  now?: Date;
}): Promise<PrepareSalesEscalationCallResult> {
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sales_escalation_task:${input.taskId}`}, 0))`,
    );
    const [latest] = await tx
      .select()
      .from(salesEscalationCallOperations)
      .where(eq(salesEscalationCallOperations.taskId, input.taskId))
      .orderBy(desc(salesEscalationCallOperations.attemptNumber))
      .for("update")
      .limit(1);

    const existing = await settleExistingSalesEscalationCall(
      tx,
      latest ?? null,
      now,
    );
    if (existing) return existing;

    // Re-read and lock every mutable dispatch target immediately before the
    // durable provider-boundary marker. The earlier outbox query is useful for
    // scheduling, but it must not authorize a call after a concurrent DNC,
    // task reassignment/completion, phone change, deletion, or deactivation.
    const [task] = await tx
      .select({
        id: crmTasks.id,
        contactId: crmTasks.contactId,
        assignedTo: crmTasks.assignedTo,
        status: crmTasks.status,
        notes: crmTasks.notes,
        updatedAt: crmTasks.updatedAt,
      })
      .from(crmTasks)
      .where(eq(crmTasks.id, input.taskId))
      .for("update")
      .limit(1);
    if (
      !task ||
      task.status !== "open" ||
      task.contactId !== input.contactId ||
      task.assignedTo !== input.agentMemberId ||
      !task.notes?.toLowerCase().includes("kind=speed_to_lead") ||
      task.updatedAt.getTime() !== input.taskUpdatedAt.getTime()
    ) {
      return {
        kind: "settled" as const,
        state: "failed" as const,
        retryable: false,
        error: "sales_escalation_target_changed",
      };
    }
    const [contact] = await tx
      .select({
        phone: contacts.phone,
        phoneE164: contacts.phoneE164,
        doNotContact: contacts.doNotContact,
        deletedAt: contacts.deletedAt,
      })
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .for("update")
      .limit(1);
    const customerPhoneE164 = normalizeLegacyPhone(
      contact?.phoneE164 ?? contact?.phone ?? null,
    );
    if (
      !contact ||
      contact.deletedAt ||
      contact.doNotContact ||
      customerPhoneE164 !== input.customerPhoneE164
    ) {
      return {
        kind: "settled" as const,
        state: "failed" as const,
        retryable: false,
        error: "sales_escalation_contact_unavailable",
      };
    }
    const [agent] = await tx
      .select({
        phoneE164: teamMembers.phoneE164,
        active: teamMembers.active,
      })
      .from(teamMembers)
      .where(eq(teamMembers.id, input.agentMemberId))
      .for("update")
      .limit(1);
    if (
      !agent?.active ||
      normalizeLegacyPhone(agent.phoneE164) !== input.agentPhoneE164
    ) {
      return {
        kind: "settled" as const,
        state: "failed" as const,
        retryable: false,
        error: "sales_escalation_agent_unavailable",
      };
    }

    let operation =
      latest?.state === "requested" &&
      latest.outboxEventId === input.outboxEventId
        ? latest
        : null;
    if (!operation) {
      const operationId = randomUUID();
      const requestedAuditEventId = randomUUID();
      const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
      await insertWorkerAudit(tx, {
        id: requestedAuditEventId,
        action: "sales.escalation.call.requested",
        outcome: "attempted",
        taskId: input.taskId,
        contactId: input.contactId,
        operationId,
        attemptNumber,
        meta: { state: "requested", mode: input.mode },
        at: now,
      });
      const [created] = await tx
        .insert(salesEscalationCallOperations)
        .values({
          id: operationId,
          outboxEventId: input.outboxEventId,
          attemptNumber,
          taskId: input.taskId,
          taskUpdatedAt: input.taskUpdatedAt,
          contactId: input.contactId,
          agentMemberId: input.agentMemberId,
          agentPhoneE164: input.agentPhoneE164,
          customerPhoneE164: input.customerPhoneE164,
          mode: input.mode,
          state: "requested",
          version: 1,
          provider: "twilio",
          providerRequestKey: randomUUID(),
          providerIdempotencySupported: false,
          requestedAuditEventId,
          requestedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!created) throw new Error("sales_escalation_request_not_created");
      operation = created;
    }

    const dispatchedAt = nextTimestamp(operation.requestedAt, now);
    const dispatchAuditEventId = await insertWorkerAudit(tx, {
      action: "sales.escalation.call.dispatched",
      outcome: "attempted",
      taskId: operation.taskId,
      contactId: operation.contactId,
      operationId: operation.id,
      attemptNumber: operation.attemptNumber,
      meta: { state: "dispatched", providerCalled: false },
      at: dispatchedAt,
    });
    const [dispatched] = await tx
      .update(salesEscalationCallOperations)
      .set({
        state: "dispatched",
        version: operation.version + 1,
        dispatchAuditEventId,
        dispatchedAt,
        callbackDeadlineAt: new Date(
          dispatchedAt.getTime() + CALLBACK_DEADLINE_MS,
        ),
        updatedAt: dispatchedAt,
      })
      .where(
        and(
          eq(salesEscalationCallOperations.id, operation.id),
          eq(salesEscalationCallOperations.state, "requested"),
          eq(salesEscalationCallOperations.version, operation.version),
        ),
      )
      .returning();
    if (!dispatched) throw new Error("sales_escalation_dispatch_not_claimed");
    return {
      kind: "dispatch" as const,
      operation: {
        id: dispatched.id,
        outboxEventId: dispatched.outboxEventId,
        attemptNumber: dispatched.attemptNumber,
        providerRequestKey: dispatched.providerRequestKey,
        agentPhoneE164: dispatched.agentPhoneE164,
      },
    };
  });
}

export async function finalizeSalesEscalationCallAttempt(input: {
  db: DatabaseClient;
  operationId: string;
  providerResult: TwilioOutboundCallResult;
  now?: Date;
}): Promise<{
  state: "succeeded" | "failed" | "reconciliation_required";
  retryable: boolean;
  error: string | null;
  retryAt?: Date;
}> {
  const outcome = classifySalesEscalationProviderResult(input.providerResult);
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(salesEscalationCallOperations)
      .where(eq(salesEscalationCallOperations.id, input.operationId))
      .for("update")
      .limit(1);
    if (!operation) throw new Error("sales_escalation_operation_missing");
    if (operation.state !== "dispatched") {
      const callbackPending =
        operation.state === "succeeded" && operation.terminalAt === null;
      return {
        state:
          operation.state === "requested"
            ? "reconciliation_required"
            : operation.state,
        retryable: operation.state === "failed" && operation.retryable === true,
        error: operation.failureCode,
        retryAt: callbackPending
          ? (operation.callbackDeadlineAt ?? now)
          : undefined,
      };
    }

    const settledAt = nextTimestamp(operation.dispatchedAt, now);
    const auditEventId = await insertWorkerAudit(tx, {
      action:
        outcome.state === "succeeded"
          ? "sales.escalation.call.provider_accepted"
          : outcome.state === "failed"
            ? "sales.escalation.call.not_dispatched"
            : "sales.escalation.call.reconciliation_required",
      outcome: outcome.state === "succeeded" ? "succeeded" : "failed",
      taskId: operation.taskId,
      contactId: operation.contactId,
      operationId: operation.id,
      attemptNumber: operation.attemptNumber,
      providerOperationId: outcome.providerOperationId,
      meta: {
        state: outcome.state,
        providerStatus: outcome.providerStatus,
        failureCode: outcome.failureCode,
        retryable: outcome.retryable,
        redispatchPrevented: outcome.state === "reconciliation_required",
      },
      at: settledAt,
    });
    const [settled] = await tx
      .update(salesEscalationCallOperations)
      .set({
        state: outcome.state,
        version: operation.version + 1,
        providerOperationId: outcome.providerOperationId,
        deliveryCertainty: outcome.certainty,
        providerStatus: outcome.providerStatus,
        failureCode: outcome.failureCode,
        failureDetail: outcome.failureDetail,
        retryable: outcome.retryable,
        providerResultAuditEventId: auditEventId,
        providerAcceptedAuditEventId:
          outcome.state === "succeeded" ? auditEventId : null,
        providerAcceptedAt: outcome.state === "succeeded" ? settledAt : null,
        reconciliationRequiredAt:
          outcome.state === "reconciliation_required" ? settledAt : null,
        terminalOutcome: outcome.state === "failed" ? "not_dispatched" : null,
        outcomeReason: outcome.state === "failed" ? outcome.failureCode : null,
        taskEffect: outcome.state === "failed" ? "not_dispatched" : "pending",
        taskEffectAt: outcome.state === "failed" ? settledAt : null,
        terminalAt: outcome.state === "failed" ? settledAt : null,
        guardReleasedAt: outcome.state === "failed" ? settledAt : null,
        updatedAt: settledAt,
      })
      .where(
        and(
          eq(salesEscalationCallOperations.id, operation.id),
          eq(salesEscalationCallOperations.state, "dispatched"),
          eq(salesEscalationCallOperations.version, operation.version),
        ),
      )
      .returning({
        state: salesEscalationCallOperations.state,
        callbackDeadlineAt: salesEscalationCallOperations.callbackDeadlineAt,
        terminalAt: salesEscalationCallOperations.terminalAt,
      });
    if (!settled) throw new Error("sales_escalation_result_not_committed");
    return {
      state: outcome.state,
      retryable: outcome.retryable,
      error: outcome.failureCode,
      retryAt:
        outcome.state === "succeeded" && settled.terminalAt === null
          ? (settled.callbackDeadlineAt ?? now)
          : undefined,
    };
  });
}

export async function reconcileSalesEscalationAfterStorageFailure(input: {
  db: DatabaseClient;
  operationId: string;
  providerOperationId: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await input.db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(salesEscalationCallOperations)
      .where(eq(salesEscalationCallOperations.id, input.operationId))
      .for("update")
      .limit(1);
    if (!operation || operation.state !== "dispatched") return;
    const at = nextTimestamp(operation.dispatchedAt, now);
    const providerAccepted = Boolean(input.providerOperationId);
    const auditEventId = await insertWorkerAudit(tx, {
      action: "sales.escalation.call.reconciliation_required",
      outcome: "failed",
      taskId: operation.taskId,
      contactId: operation.contactId,
      operationId: operation.id,
      attemptNumber: operation.attemptNumber,
      providerOperationId: input.providerOperationId,
      meta: {
        state: "reconciliation_required",
        failureCode: "provider_result_storage_failed",
        providerAcceptanceKnown: providerAccepted,
        redispatchPrevented: true,
      },
      at,
    });
    const [updated] = await tx
      .update(salesEscalationCallOperations)
      .set({
        state: "reconciliation_required",
        version: operation.version + 1,
        providerOperationId: input.providerOperationId,
        deliveryCertainty: providerAccepted ? "accepted" : "uncertain",
        providerStatus: providerAccepted ? 201 : null,
        providerResultAuditEventId: auditEventId,
        providerAcceptedAuditEventId: providerAccepted ? auditEventId : null,
        providerAcceptedAt: providerAccepted ? at : null,
        reconciliationRequiredAt: at,
        retryable: false,
        failureCode: "provider_result_storage_failed",
        failureDetail:
          "The provider boundary was crossed but its normal receipt could not be stored. Automatic redial is blocked.",
        updatedAt: at,
      })
      .where(
        and(
          eq(salesEscalationCallOperations.id, operation.id),
          eq(salesEscalationCallOperations.state, "dispatched"),
          eq(salesEscalationCallOperations.version, operation.version),
        ),
      )
      .returning({ id: salesEscalationCallOperations.id });
    if (!updated)
      throw new Error("sales_escalation_reconciliation_not_committed");
  });
}

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new SalesEscalationCallbackError(`${label}_invalid`, 400);
  }
  return value;
}

function requireCallSid(value: string | null, label: string): string {
  if (!isTwilioCallSid(value)) {
    throw new SalesEscalationCallbackError(`${label}_invalid`, 400);
  }
  return value.trim();
}

function requireStatus(value: string | null): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!CALLBACK_STATUSES.has(normalized)) {
    throw new SalesEscalationCallbackError("callback_status_invalid", 400);
  }
  return normalized;
}

function safeDuration(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 86_400) {
    throw new SalesEscalationCallbackError("callback_duration_invalid", 400);
  }
  return value;
}

async function insertCallbackEvidence(
  tx: TeamMutationTransaction,
  input: {
    operationId: string;
    kind:
      | "agent_connect"
      | "customer_dial_requested"
      | "agent_status"
      | "customer_status"
      | "dial_action";
    leg: "agent" | "customer";
    parentCallSid: string;
    customerCallSid: string | null;
    status: string | null;
    durationSec: number | null;
    bridged: boolean | null;
    applyResult: "applied" | "late" | "anomaly";
    now: Date;
  },
): Promise<boolean> {
  const semanticHash = createHash("sha256")
    .update(
      JSON.stringify([
        input.kind,
        input.leg,
        input.parentCallSid,
        input.customerCallSid,
        input.status,
        input.durationSec,
        input.bridged,
      ]),
      "utf8",
    )
    .digest("hex");
  const [inserted] = await tx
    .insert(salesEscalationCallCallbackEvents)
    .values({
      operationId: input.operationId,
      kind: input.kind,
      leg: input.leg,
      semanticHash,
      parentCallSid: input.parentCallSid,
      customerCallSid: input.customerCallSid,
      status: input.status,
      durationSec: input.durationSec,
      bridged: input.bridged,
      applyResult: input.applyResult,
      receivedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: salesEscalationCallCallbackEvents.id });
  return Boolean(inserted?.id);
}

async function lockCallbackOperation(
  tx: TeamMutationTransaction,
  eventKey: string,
  operationKey: string,
  parentCallSid: string,
  now: Date,
  options: { resolveDialAnomaly?: boolean } = {},
): Promise<OperationRow> {
  const [operation] = await tx
    .select()
    .from(salesEscalationCallOperations)
    .where(
      and(
        eq(salesEscalationCallOperations.outboxEventId, eventKey),
        eq(salesEscalationCallOperations.providerRequestKey, operationKey),
      ),
    )
    .for("update")
    .limit(1);
  if (!operation) {
    throw new SalesEscalationCallbackError(
      "escalation_operation_not_found",
      404,
    );
  }
  if (
    operation.providerOperationId &&
    operation.providerOperationId !== parentCallSid
  ) {
    throw new SalesEscalationCallbackError(
      "escalation_parent_call_identity_mismatch",
      409,
    );
  }
  if (operation.state === "failed") {
    throw new SalesEscalationCallbackError(
      "escalation_callback_conflicts_with_rejection",
      409,
    );
  }
  // A decisive human reconciliation keeps the original operation in the
  // quarantine state. Signature-verified callbacks may still append late
  // evidence, but must never overwrite the reviewed terminal decision.
  if (
    operation.terminalAt !== null ||
    operation.reconciliationResolutionId !== null
  ) {
    return operation;
  }
  if (
    operation.state !== "dispatched" &&
    operation.state !== "succeeded" &&
    operation.state !== "reconciliation_required"
  ) {
    throw new SalesEscalationCallbackError(
      "escalation_operation_not_callback_ready",
      409,
    );
  }
  if (operation.state === "succeeded") return operation;
  if (
    operation.state === "reconciliation_required" &&
    operation.failureCode === "dial_outcome_inconsistent" &&
    !options.resolveDialAnomaly
  ) {
    return operation;
  }

  const acceptedAuditEventId =
    operation.providerAcceptedAuditEventId ??
    (await insertWorkerAudit(tx, {
      action: "sales.escalation.call.provider_accepted",
      outcome: "succeeded",
      taskId: operation.taskId,
      contactId: operation.contactId,
      operationId: operation.id,
      attemptNumber: operation.attemptNumber,
      providerOperationId: parentCallSid,
      meta: {
        state: "succeeded",
        acceptedFromSignedCallback: true,
      },
      at: now,
    }));
  const providerResultAuditEventId =
    operation.providerResultAuditEventId ?? acceptedAuditEventId;
  const [accepted] = await tx
    .update(salesEscalationCallOperations)
    .set({
      state: "succeeded",
      version: operation.version + 1,
      providerOperationId: parentCallSid,
      deliveryCertainty: "accepted",
      providerStatus: 201,
      retryable: false,
      providerResultAuditEventId,
      providerAcceptedAuditEventId: acceptedAuditEventId,
      providerAcceptedAt: operation.providerAcceptedAt ?? now,
      reconciliationRequiredAt: null,
      failureCode: null,
      failureDetail: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(salesEscalationCallOperations.id, operation.id),
        eq(salesEscalationCallOperations.state, operation.state),
        eq(salesEscalationCallOperations.version, operation.version),
      ),
    )
    .returning();
  if (!accepted) {
    throw new SalesEscalationCallbackError(
      "escalation_operation_conflict",
      409,
    );
  }
  return accepted;
}

async function callbackContext(
  tx: TeamMutationTransaction,
  operation: OperationRow,
): Promise<{
  operation: OperationRow;
  leadName: string | null;
  customerDialAllowed: boolean;
  customerDialBlockReason:
    | "customer_unavailable"
    | "customer_dnc"
    | "customer_phone_changed"
    | "task_unavailable"
    | "task_changed"
    | "operation_not_dialable"
    | null;
}> {
  const [contact] = await tx
    .select({
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      doNotContact: contacts.doNotContact,
      deletedAt: contacts.deletedAt,
    })
    .from(contacts)
    .where(eq(contacts.id, operation.contactId))
    .for("update")
    .limit(1);
  const [task] = await tx
    .select({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      assignedTo: crmTasks.assignedTo,
      status: crmTasks.status,
      updatedAt: crmTasks.updatedAt,
    })
    .from(crmTasks)
    .where(eq(crmTasks.id, operation.taskId))
    .for("update")
    .limit(1);
  const leadName = contact
    ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`
        .trim()
        .replace(/\s+/gu, " ")
        .slice(0, 80) || null
    : null;
  const customerPhoneMatchesSnapshot =
    salesEscalationCustomerPhoneMatchesSnapshot({
      phoneE164: contact?.phoneE164 ?? null,
      phone: contact?.phone ?? null,
      snapshottedPhoneE164: operation.customerPhoneE164,
    });
  const customerDialBlockReason = !contact || contact.deletedAt
    ? "customer_unavailable"
    : contact.doNotContact
      ? "customer_dnc"
      : !customerPhoneMatchesSnapshot
        ? "customer_phone_changed"
        : !task || task.status !== "open"
          ? "task_unavailable"
          : task.contactId !== operation.contactId ||
              task.assignedTo !== operation.agentMemberId ||
              task.updatedAt.getTime() !== operation.taskUpdatedAt.getTime()
            ? "task_changed"
            : operation.state !== "succeeded" || operation.terminalAt !== null
              ? "operation_not_dialable"
              : null;
  return {
    operation,
    leadName,
    customerDialAllowed: customerDialBlockReason === null,
    customerDialBlockReason,
  };
}

export async function handleSalesEscalationConnectCallback(input: {
  db: DatabaseClient;
  eventKey: string;
  operationKey: string;
  parentCallSid: string | null;
  customerDialRequested: boolean;
  now?: Date;
}): Promise<{
  operationId: string;
  operationKey: string;
  duplicate: boolean;
  customerDialAllowed: boolean;
  customerPhoneE164: string | null;
  leadName: string | null;
}> {
  const eventKey = requireUuid(input.eventKey, "event_key");
  const operationKey = requireUuid(input.operationKey, "operation_key");
  const parentCallSid = requireCallSid(input.parentCallSid, "parent_call_sid");
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    let operation = await lockCallbackOperation(
      tx,
      eventKey,
      operationKey,
      parentCallSid,
      now,
    );
    const context = await callbackContext(tx, operation);
    const kind = input.customerDialRequested
      ? "customer_dial_requested"
      : "agent_connect";
    const inserted = await insertCallbackEvidence(tx, {
      operationId: operation.id,
      kind,
      leg: "agent",
      parentCallSid,
      customerCallSid: null,
      status: "answered",
      durationSec: null,
      bridged: null,
      applyResult:
        operation.terminalAt ||
        (input.customerDialRequested && !context.customerDialAllowed)
          ? "late"
          : "applied",
      now,
    });
    if (inserted && !operation.terminalAt) {
      const customerDialRequestedAt = input.customerDialRequested
        ? (operation.customerDialRequestedAt ?? now)
        : operation.customerDialRequestedAt;
      const terminalAuditEventId =
        input.customerDialRequested &&
        !context.customerDialAllowed &&
        operation.state === "succeeded"
          ? await insertWorkerAudit(tx, {
              action: "sales.escalation.call.not_connected",
              outcome: "failed",
              taskId: operation.taskId,
              contactId: operation.contactId,
              operationId: operation.id,
              attemptNumber: operation.attemptNumber,
              providerOperationId: parentCallSid,
              meta: {
                terminalOutcome: "not_connected",
                taskEffect: "not_connected",
                outcomeReason:
                  context.customerDialBlockReason ?? "customer_dial_blocked",
                customerDialPrevented: true,
                redispatchPrevented: true,
              },
              at: now,
            })
          : operation.terminalAuditEventId;
      const customerDialPrevented = Boolean(
        input.customerDialRequested &&
          !context.customerDialAllowed &&
          operation.state === "succeeded",
      );
      const [updated] = await tx
        .update(salesEscalationCallOperations)
        .set({
          state: operation.state,
          version: operation.version + 1,
          agentAnsweredAt: operation.agentAnsweredAt ?? now,
          customerDialRequestedAt,
          terminalAuditEventId,
          terminalOutcome: customerDialPrevented
            ? "not_connected"
            : operation.terminalOutcome,
          outcomeReason: customerDialPrevented
            ? (context.customerDialBlockReason ?? "customer_dial_blocked")
            : operation.outcomeReason,
          taskEffect: customerDialPrevented
            ? "not_connected"
            : operation.taskEffect,
          taskEffectAt: customerDialPrevented ? now : operation.taskEffectAt,
          terminalAt: customerDialPrevented ? now : operation.terminalAt,
          guardReleasedAt: customerDialPrevented
            ? now
            : operation.guardReleasedAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(salesEscalationCallOperations.id, operation.id),
            eq(salesEscalationCallOperations.state, operation.state),
            eq(salesEscalationCallOperations.version, operation.version),
          ),
        )
        .returning();
      if (!updated) {
        throw new SalesEscalationCallbackError(
          "escalation_operation_conflict",
          409,
        );
      }
      operation = updated;
      if (input.customerDialRequested && context.customerDialAllowed) {
        await insertWorkerAudit(tx, {
          action: "sales.escalation.customer_dial.requested",
          outcome: "attempted",
          taskId: operation.taskId,
          contactId: operation.contactId,
          operationId: operation.id,
          attemptNumber: operation.attemptNumber,
          providerOperationId: parentCallSid,
          meta: { taskEffects: "pending" },
          at: now,
        });
      }
    }
    return {
      operationId: operation.id,
      operationKey: operation.providerRequestKey,
      duplicate: !inserted,
      customerDialAllowed:
        inserted && input.customerDialRequested && context.customerDialAllowed,
      customerPhoneE164:
        inserted && input.customerDialRequested && context.customerDialAllowed
          ? operation.customerPhoneE164
          : null,
      leadName: context.leadName,
    };
  });
}

export type SalesEscalationDialOutcome =
  | { kind: "connected" }
  | { kind: "not_connected"; reason: string }
  | { kind: "inconsistent"; reason: string };

export function classifySalesEscalationAgentStatusOutcome(input: {
  status: string;
  customerDialRequested: boolean;
}): { kind: "pending" } | { kind: "not_connected"; reason: string } {
  if (
    !input.customerDialRequested &&
    ["completed", "busy", "no-answer", "failed", "canceled"].includes(
      input.status,
    )
  ) {
    return {
      kind: "not_connected",
      reason: `agent_${input.status.replace("-", "_")}`,
    };
  }
  return { kind: "pending" };
}

export function classifySalesEscalationDialOutcome(input: {
  status: string;
  durationSec: number | null;
  bridged: boolean | null;
}): SalesEscalationDialOutcome {
  const connected =
    input.status === "completed" &&
    input.bridged === true &&
    (input.durationSec ?? 0) > 0;
  if (connected) return { kind: "connected" };
  if (
    ["busy", "no-answer", "failed", "canceled"].includes(input.status) ||
    (input.status === "completed" &&
      (input.bridged === false || input.durationSec === 0))
  ) {
    return {
      kind: "not_connected",
      reason: `customer_${input.status.replace("-", "_")}`,
    };
  }
  return { kind: "inconsistent", reason: "dial_outcome_inconsistent" };
}

async function ensureEscalationCallRecord(
  tx: TeamMutationTransaction,
  input: {
    operation: OperationRow;
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
    throw new SalesEscalationCallbackError(
      "escalation_call_record_identity_mismatch",
      409,
    );
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
      mode: "sales_escalation",
      from: input.operation.agentPhoneE164,
      to: input.operation.customerPhoneE164,
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

export async function handleSalesEscalationStatusCallback(input: {
  db: DatabaseClient;
  eventKey: string;
  operationKey: string;
  leg: "agent" | "customer";
  callSid: string | null;
  parentCallSid: string | null;
  status: string | null;
  durationSec: number | null;
  now?: Date;
}): Promise<{ duplicate: boolean; state: SalesEscalationCallOperationState }> {
  const eventKey = requireUuid(input.eventKey, "event_key");
  const operationKey = requireUuid(input.operationKey, "operation_key");
  const status = requireStatus(input.status);
  const durationSec = safeDuration(input.durationSec);
  const parentCallSid =
    input.leg === "agent"
      ? requireCallSid(input.callSid, "parent_call_sid")
      : requireCallSid(input.parentCallSid, "parent_call_sid");
  const customerCallSid =
    input.leg === "customer"
      ? requireCallSid(input.callSid, "customer_call_sid")
      : null;
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    let operation = await lockCallbackOperation(
      tx,
      eventKey,
      operationKey,
      parentCallSid,
      now,
    );
    if (
      customerCallSid &&
      operation.providerCustomerOperationId &&
      operation.providerCustomerOperationId !== customerCallSid
    ) {
      throw new SalesEscalationCallbackError(
        "escalation_customer_call_identity_mismatch",
        409,
      );
    }
    const inserted = await insertCallbackEvidence(tx, {
      operationId: operation.id,
      kind: input.leg === "agent" ? "agent_status" : "customer_status",
      leg: input.leg,
      parentCallSid,
      customerCallSid,
      status,
      durationSec,
      bridged: null,
      applyResult: operation.terminalAt ? "late" : "applied",
      now,
    });
    if (!inserted || operation.terminalAt) {
      return { duplicate: !inserted, state: operation.state };
    }
    const terminalStatus = [
      "completed",
      "busy",
      "no-answer",
      "failed",
      "canceled",
    ].includes(status);
    const agentOutcome = classifySalesEscalationAgentStatusOutcome({
      status,
      customerDialRequested: operation.customerDialRequestedAt !== null,
    });
    if (
      input.leg === "agent" &&
      operation.state === "succeeded" &&
      agentOutcome.kind === "not_connected"
    ) {
      const outcomeReason = agentOutcome.reason;
      const terminalAuditEventId = await insertWorkerAudit(tx, {
        action: "sales.escalation.call.not_connected",
        outcome: "failed",
        taskId: operation.taskId,
        contactId: operation.contactId,
        operationId: operation.id,
        attemptNumber: operation.attemptNumber,
        providerOperationId: parentCallSid,
        meta: {
          terminalOutcome: "not_connected",
          taskEffect: "not_connected",
          outcomeReason,
          durationSec,
          customerDialRequested: false,
        },
        at: now,
      });
      const [settled] = await tx
        .update(salesEscalationCallOperations)
        .set({
          state: operation.state,
          version: operation.version + 1,
          agentAnsweredAt:
            status === "completed" && (durationSec ?? 0) > 0
              ? (operation.agentAnsweredAt ?? now)
              : operation.agentAnsweredAt,
          terminalAuditEventId,
          terminalOutcome: "not_connected",
          outcomeReason,
          taskEffect: "not_connected",
          taskEffectAt: now,
          terminalAt: now,
          guardReleasedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(salesEscalationCallOperations.id, operation.id),
            eq(salesEscalationCallOperations.state, operation.state),
            eq(salesEscalationCallOperations.version, operation.version),
            isNull(salesEscalationCallOperations.customerDialRequestedAt),
            isNull(salesEscalationCallOperations.terminalAt),
          ),
        )
        .returning();
      if (!settled) {
        throw new SalesEscalationCallbackError(
          "escalation_terminal_conflict",
          409,
        );
      }
      return { duplicate: false, state: settled.state };
    }
    const [updated] = await tx
      .update(salesEscalationCallOperations)
      .set({
        state: operation.state,
        version: operation.version + 1,
        providerCustomerOperationId:
          operation.providerCustomerOperationId ?? customerCallSid,
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
        customerCompletedAt:
          input.leg === "customer" && terminalStatus
            ? (operation.customerCompletedAt ?? now)
            : operation.customerCompletedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(salesEscalationCallOperations.id, operation.id),
          eq(salesEscalationCallOperations.state, operation.state),
          eq(salesEscalationCallOperations.version, operation.version),
        ),
      )
      .returning();
    if (!updated) {
      throw new SalesEscalationCallbackError(
        "escalation_operation_conflict",
        409,
      );
    }
    operation = updated;
    return { duplicate: false, state: operation.state };
  });
}

export async function handleSalesEscalationDialActionCallback(input: {
  db: DatabaseClient;
  eventKey: string;
  operationKey: string;
  parentCallSid: string | null;
  customerCallSid: string | null;
  status: string | null;
  durationSec: number | null;
  bridged: boolean | null;
  now?: Date;
}): Promise<{
  duplicate: boolean;
  outcome: "connected" | "not_connected" | "reconciliation_required";
}> {
  const eventKey = requireUuid(input.eventKey, "event_key");
  const operationKey = requireUuid(input.operationKey, "operation_key");
  const parentCallSid = requireCallSid(input.parentCallSid, "parent_call_sid");
  const customerCallSid = requireCallSid(
    input.customerCallSid,
    "customer_call_sid",
  );
  const status = requireStatus(input.status);
  const durationSec = safeDuration(input.durationSec);
  const now = input.now ?? new Date();
  const outcome = classifySalesEscalationDialOutcome({
    status,
    durationSec,
    bridged: input.bridged,
  });
  return input.db.transaction(async (tx) => {
    let operation = await lockCallbackOperation(
      tx,
      eventKey,
      operationKey,
      parentCallSid,
      now,
      { resolveDialAnomaly: outcome.kind !== "inconsistent" },
    );
    if (
      operation.providerCustomerOperationId &&
      operation.providerCustomerOperationId !== customerCallSid
    ) {
      throw new SalesEscalationCallbackError(
        "escalation_customer_call_identity_mismatch",
        409,
      );
    }
    const inserted = await insertCallbackEvidence(tx, {
      operationId: operation.id,
      kind: "dial_action",
      leg: "customer",
      parentCallSid,
      customerCallSid,
      status,
      durationSec,
      bridged: input.bridged,
      applyResult:
        operation.terminalAt !== null
          ? "late"
          : outcome.kind === "inconsistent"
            ? "anomaly"
            : "applied",
      now,
    });
    if (!inserted || operation.terminalAt) {
      return {
        duplicate: !inserted,
        outcome:
          operation.terminalOutcome === "connected"
            ? "connected"
            : operation.terminalOutcome === "not_connected"
              ? "not_connected"
              : "reconciliation_required",
      };
    }
    if (outcome.kind === "inconsistent") {
      await insertWorkerAudit(tx, {
        action: "sales.escalation.call.callback_anomaly",
        outcome: "failed",
        taskId: operation.taskId,
        contactId: operation.contactId,
        operationId: operation.id,
        attemptNumber: operation.attemptNumber,
        providerOperationId: parentCallSid,
        meta: {
          outcomeReason: outcome.reason,
          redispatchPrevented: true,
        },
        at: now,
      });
      const [reconciliation] = await tx
        .update(salesEscalationCallOperations)
        .set({
          state: "reconciliation_required",
          version: operation.version + 1,
          deliveryCertainty: "accepted",
          retryable: false,
          reconciliationRequiredAt: operation.reconciliationRequiredAt ?? now,
          failureCode: outcome.reason,
          failureDetail:
            "Twilio returned contradictory customer-leg evidence. Automatic redial and task completion are blocked until a consistent signed dial result arrives or staff reconcile the operation.",
          updatedAt: now,
        })
        .where(
          and(
            eq(salesEscalationCallOperations.id, operation.id),
            eq(salesEscalationCallOperations.state, operation.state),
            eq(salesEscalationCallOperations.version, operation.version),
            isNull(salesEscalationCallOperations.terminalAt),
          ),
        )
        .returning({ id: salesEscalationCallOperations.id });
      if (!reconciliation) {
        throw new SalesEscalationCallbackError(
          "escalation_reconciliation_conflict",
          409,
        );
      }
      return { duplicate: false, outcome: "reconciliation_required" };
    }

    const [task] = await tx
      .select({
        id: crmTasks.id,
        contactId: crmTasks.contactId,
        assignedTo: crmTasks.assignedTo,
        status: crmTasks.status,
        updatedAt: crmTasks.updatedAt,
      })
      .from(crmTasks)
      .where(eq(crmTasks.id, operation.taskId))
      .for("update")
      .limit(1);
    let taskEffect:
      | "completed"
      | "stale"
      | "already_terminal"
      | "not_connected";
    if (outcome.kind === "not_connected") {
      taskEffect = "not_connected";
    } else if (!task || task.status !== "open") {
      taskEffect = "already_terminal";
    } else if (
      task.contactId !== operation.contactId ||
      task.assignedTo !== operation.agentMemberId ||
      task.updatedAt.getTime() !== operation.taskUpdatedAt.getTime()
    ) {
      taskEffect = "stale";
    } else {
      const [completed] = await tx
        .update(crmTasks)
        .set({ status: "completed", updatedAt: now })
        .where(
          and(
            eq(crmTasks.id, operation.taskId),
            eq(crmTasks.contactId, operation.contactId),
            eq(crmTasks.assignedTo, operation.agentMemberId),
            eq(crmTasks.status, "open"),
            eq(crmTasks.updatedAt, operation.taskUpdatedAt),
          ),
        )
        .returning({ id: crmTasks.id });
      taskEffect = completed ? "completed" : "stale";
    }

    await ensureEscalationCallRecord(tx, {
      operation,
      parentCallSid,
      customerCallSid,
      status,
      durationSec,
      enqueueRecording: outcome.kind === "connected",
      now,
    });
    const terminalOutcome: SalesEscalationCallTerminalOutcome =
      outcome.kind === "connected" ? "connected" : "not_connected";
    const terminalAuditEventId = await insertWorkerAudit(tx, {
      action:
        outcome.kind === "connected"
          ? "sales.escalation.call.connected"
          : "sales.escalation.call.not_connected",
      outcome: outcome.kind === "connected" ? "succeeded" : "failed",
      taskId: operation.taskId,
      contactId: operation.contactId,
      operationId: operation.id,
      attemptNumber: operation.attemptNumber,
      providerOperationId: parentCallSid,
      meta: {
        terminalOutcome,
        taskEffect,
        durationSec,
      },
      at: now,
    });
    const [settled] = await tx
      .update(salesEscalationCallOperations)
      .set({
        state: operation.state,
        version: operation.version + 1,
        providerCustomerOperationId: customerCallSid,
        customerAnsweredAt:
          outcome.kind === "connected"
            ? (operation.customerAnsweredAt ?? now)
            : operation.customerAnsweredAt,
        customerCompletedAt: operation.customerCompletedAt ?? now,
        terminalAuditEventId,
        terminalOutcome,
        outcomeReason:
          outcome.kind === "connected"
            ? "customer_bridge_completed"
            : outcome.reason,
        taskEffect,
        taskEffectAt: now,
        terminalAt: now,
        guardReleasedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(salesEscalationCallOperations.id, operation.id),
          eq(salesEscalationCallOperations.state, operation.state),
          eq(salesEscalationCallOperations.version, operation.version),
          isNull(salesEscalationCallOperations.terminalAt),
        ),
      )
      .returning();
    if (!settled) {
      throw new SalesEscalationCallbackError(
        "escalation_terminal_conflict",
        409,
      );
    }
    operation = settled;
    return {
      duplicate: false,
      outcome:
        operation.terminalOutcome === "connected"
          ? "connected"
          : "not_connected",
    };
  });
}

/**
 * Compatibility lookup for calls dispatched before the durable operation
 * ledger existed. The signed callback must carry the exact Twilio parent Call
 * SID stored in the provider receipt audit. The dedicated column is preferred;
 * the historical exact `meta.callSid` field is accepted for pre-0071 rows.
 * URL task IDs and partial/derived SID matches are intentionally ignored.
 */
export async function resolveLegacySalesEscalationCallback(input: {
  db: DatabaseClient;
  providerCallSids: readonly (string | null)[];
}): Promise<{
  taskId: string;
  providerCallSid: string;
  contactId: string | null;
  agentMemberId: string | null;
} | null> {
  const providerCallSids = [...new Set(input.providerCallSids)]
    .filter(isTwilioCallSid)
    .map((value) => value.trim());
  if (providerCallSids.length === 0) return null;
  const providerFilter = or(
    ...providerCallSids.map((providerCallSid) =>
      or(
        eq(auditLogs.providerOperationId, providerCallSid),
        and(
          isNull(auditLogs.providerOperationId),
          sql`${auditLogs.meta} ->> 'callSid' = ${providerCallSid}`,
        ),
      ),
    ),
  );
  if (!providerFilter) return null;
  const audits = await input.db
    .select({
      taskId: auditLogs.entityId,
      providerCallSid: auditLogs.providerOperationId,
      meta: auditLogs.meta,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, "sales.escalation.call.started"),
        eq(auditLogs.outcome, "succeeded"),
        eq(auditLogs.entityType, "crm_task"),
        providerFilter,
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(2);
  const audit = audits[0];
  if (
    audits.length > 1 &&
    audits.some((candidate) => candidate.taskId !== audit?.taskId)
  ) {
    return null;
  }
  if (
    !audit?.taskId ||
    !UUID_PATTERN.test(audit.taskId) ||
    !isTwilioCallSid(
      audit.providerCallSid ??
        (typeof audit.meta?.["callSid"] === "string"
          ? audit.meta["callSid"]
          : null),
    )
  ) {
    return null;
  }
  const providerCallSid =
    audit.providerCallSid ??
    (typeof audit.meta?.["callSid"] === "string"
      ? audit.meta["callSid"].trim()
      : "");
  if (!providerCallSids.includes(providerCallSid)) return null;
  const contactId =
    typeof audit.meta?.["contactId"] === "string" &&
    UUID_PATTERN.test(audit.meta["contactId"])
      ? audit.meta["contactId"]
      : null;
  const agentMemberId =
    typeof audit.meta?.["assignedTo"] === "string" &&
    UUID_PATTERN.test(audit.meta["assignedTo"])
      ? audit.meta["assignedTo"]
      : null;
  return {
    taskId: audit.taskId,
    providerCallSid,
    contactId,
    agentMemberId,
  };
}

function normalizeLegacyPhone(value: string | null): string | null {
  if (!value) return null;
  const parsed = parsePhoneNumberFromString(value, "US");
  const e164 = parsed?.number ?? null;
  return e164 && /^\+[1-9]\d{9,14}$/u.test(e164) ? e164 : null;
}

export function salesEscalationCustomerPhoneMatchesSnapshot(input: {
  phoneE164: string | null;
  phone: string | null;
  snapshottedPhoneE164: string;
}): boolean {
  return (
    normalizeLegacyPhone(input.phoneE164 ?? input.phone) ===
    input.snapshottedPhoneE164
  );
}

/**
 * Convert an already accepted pre-ledger call into the durable state machine.
 * The immutable historical provider receipt is the only lookup key; legacy
 * URL task/contact/phone parameters are never read.
 */
export async function adoptLegacySalesEscalationCallback(input: {
  db: DatabaseClient;
  parentCallSid: string | null;
  now?: Date;
}): Promise<{ eventKey: string; operationKey: string }> {
  const parentCallSid = requireCallSid(input.parentCallSid, "parent_call_sid");
  const binding = await resolveLegacySalesEscalationCallback({
    db: input.db,
    providerCallSids: [parentCallSid],
  });
  if (!binding) {
    throw new SalesEscalationCallbackError(
      "legacy_escalation_receipt_not_found",
      404,
    );
  }
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sales_escalation_legacy:${parentCallSid}`}, 0))`,
    );
    const [existing] = await tx
      .select({
        outboxEventId: salesEscalationCallOperations.outboxEventId,
        operationKey: salesEscalationCallOperations.providerRequestKey,
      })
      .from(salesEscalationCallOperations)
      .where(
        eq(salesEscalationCallOperations.providerOperationId, parentCallSid),
      )
      .for("update")
      .limit(1);
    if (existing) {
      return {
        eventKey: existing.outboxEventId,
        operationKey: existing.operationKey,
      };
    }

    const [task] = await tx
      .select({
        id: crmTasks.id,
        contactId: crmTasks.contactId,
        assignedTo: crmTasks.assignedTo,
        status: crmTasks.status,
        notes: crmTasks.notes,
        updatedAt: crmTasks.updatedAt,
      })
      .from(crmTasks)
      .where(eq(crmTasks.id, binding.taskId))
      .for("update")
      .limit(1);
    if (
      !task?.contactId ||
      !task.assignedTo ||
      task.status !== "open" ||
      !task.notes?.toLowerCase().includes("kind=speed_to_lead") ||
      (binding.contactId !== null && binding.contactId !== task.contactId) ||
      (binding.agentMemberId !== null &&
        binding.agentMemberId !== task.assignedTo)
    ) {
      throw new SalesEscalationCallbackError(
        "legacy_escalation_task_changed",
        409,
      );
    }

    const [contact] = await tx
      .select({
        phone: contacts.phone,
        phoneE164: contacts.phoneE164,
        doNotContact: contacts.doNotContact,
        deletedAt: contacts.deletedAt,
      })
      .from(contacts)
      .where(eq(contacts.id, task.contactId))
      .for("update")
      .limit(1);
    const [agent] = await tx
      .select({
        phoneE164: teamMembers.phoneE164,
        active: teamMembers.active,
      })
      .from(teamMembers)
      .where(eq(teamMembers.id, task.assignedTo))
      .for("update")
      .limit(1);
    const customerPhoneE164 = normalizeLegacyPhone(
      contact?.phoneE164 ?? contact?.phone ?? null,
    );
    const agentPhoneE164 = normalizeLegacyPhone(agent?.phoneE164 ?? null);
    if (
      !contact ||
      contact.deletedAt ||
      contact.doNotContact ||
      !agent?.active ||
      !customerPhoneE164 ||
      !agentPhoneE164
    ) {
      throw new SalesEscalationCallbackError(
        "legacy_escalation_contact_unavailable",
        409,
      );
    }

    const [adoptionEvent] = await tx
      .insert(outboxEvents)
      .values({
        type: "sales.escalation.call",
        payload: {
          taskId: task.id,
          contactId: task.contactId,
          legacyAdopted: true,
        },
        processedAt: now,
        createdAt: now,
      })
      .returning({ id: outboxEvents.id });
    if (!adoptionEvent) {
      throw new SalesEscalationCallbackError(
        "legacy_escalation_adoption_failed",
        500,
      );
    }

    const operationId = randomUUID();
    const requestedAuditEventId = await insertWorkerAudit(tx, {
      action: "sales.escalation.call.requested",
      outcome: "attempted",
      taskId: task.id,
      contactId: task.contactId,
      operationId,
      attemptNumber: 1,
      providerOperationId: parentCallSid,
      meta: { state: "requested", legacyAdopted: true },
      at: now,
    });
    const [requested] = await tx
      .insert(salesEscalationCallOperations)
      .values({
        id: operationId,
        outboxEventId: adoptionEvent.id,
        attemptNumber: 1,
        taskId: task.id,
        taskUpdatedAt: task.updatedAt,
        contactId: task.contactId,
        agentMemberId: task.assignedTo,
        agentPhoneE164,
        customerPhoneE164,
        mode: "scheduled",
        state: "requested",
        version: 1,
        provider: "twilio",
        providerRequestKey: randomUUID(),
        providerIdempotencySupported: false,
        requestedAuditEventId,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!requested) {
      throw new SalesEscalationCallbackError(
        "legacy_escalation_adoption_failed",
        500,
      );
    }

    const dispatchedAt = nextTimestamp(requested.requestedAt, now);
    const dispatchAuditEventId = await insertWorkerAudit(tx, {
      action: "sales.escalation.call.dispatched",
      outcome: "attempted",
      taskId: task.id,
      contactId: task.contactId,
      operationId,
      attemptNumber: 1,
      providerOperationId: parentCallSid,
      meta: { state: "dispatched", legacyAdopted: true },
      at: dispatchedAt,
    });
    const [dispatched] = await tx
      .update(salesEscalationCallOperations)
      .set({
        state: "dispatched",
        version: requested.version + 1,
        dispatchAuditEventId,
        dispatchedAt,
        callbackDeadlineAt: new Date(
          dispatchedAt.getTime() + CALLBACK_DEADLINE_MS,
        ),
        updatedAt: dispatchedAt,
      })
      .where(
        and(
          eq(salesEscalationCallOperations.id, operationId),
          eq(salesEscalationCallOperations.state, "requested"),
          eq(salesEscalationCallOperations.version, requested.version),
        ),
      )
      .returning();
    if (!dispatched) {
      throw new SalesEscalationCallbackError(
        "legacy_escalation_adoption_failed",
        500,
      );
    }

    const acceptedAt = nextTimestamp(dispatched.dispatchedAt, now);
    const acceptedAuditEventId = await insertWorkerAudit(tx, {
      action: "sales.escalation.call.provider_accepted",
      outcome: "succeeded",
      taskId: task.id,
      contactId: task.contactId,
      operationId,
      attemptNumber: 1,
      providerOperationId: parentCallSid,
      meta: {
        state: "succeeded",
        legacyAdopted: true,
        acceptedFromHistoricalReceipt: true,
      },
      at: acceptedAt,
    });
    const [accepted] = await tx
      .update(salesEscalationCallOperations)
      .set({
        state: "succeeded",
        version: dispatched.version + 1,
        providerOperationId: parentCallSid,
        deliveryCertainty: "accepted",
        providerStatus: 201,
        retryable: false,
        providerResultAuditEventId: acceptedAuditEventId,
        providerAcceptedAuditEventId: acceptedAuditEventId,
        providerAcceptedAt: acceptedAt,
        updatedAt: acceptedAt,
      })
      .where(
        and(
          eq(salesEscalationCallOperations.id, operationId),
          eq(salesEscalationCallOperations.state, "dispatched"),
          eq(salesEscalationCallOperations.version, dispatched.version),
        ),
      )
      .returning({
        outboxEventId: salesEscalationCallOperations.outboxEventId,
        operationKey: salesEscalationCallOperations.providerRequestKey,
      });
    if (!accepted) {
      throw new SalesEscalationCallbackError(
        "legacy_escalation_adoption_failed",
        500,
      );
    }
    return {
      eventKey: accepted.outboxEventId,
      operationKey: accepted.operationKey,
    };
  });
}

export type {
  SalesEscalationCallDeliveryCertainty,
  SalesEscalationCallOperationState,
};
