import { randomUUID } from "node:crypto";
import type { MutationResult } from "@myst-os/sdk";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import {
  and,
  asc,
  eq,
  ilike,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  auditLogs,
  contacts,
  crmTasks,
  teamCallOperationTaskIntents,
  teamCallOperations,
  teamMembers,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import type { TwilioOutboundCallResult } from "@/lib/twilio-calls";
import {
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  completeTeamMutationIdempotency,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";

type CallOperationRow = typeof teamCallOperations.$inferSelect;

export type ManualCallSuccessData = {
  callOperationId: string;
  state: "active" | "succeeded" | "failed";
  provider: "twilio";
  providerIdempotencySupported: false;
  agentMemberId: string;
  taskId: string | null;
  taskEffects: "pending" | "completed" | "not_connected";
  completedExplicitTaskId: string | null;
  completedFollowupTaskId: string | null;
  completedSpeedToLeadCount: number;
};

export type ManualCallAttemptMetadata = {
  operationId: string;
  operationVersion: number;
  state:
    | "active"
    | "succeeded"
    | "failed"
    | "confirmed_not_sent"
    | "reconciliation_required";
  newAttempt: "none" | "explicit" | "blocked";
};

export type ManualCallFailureResult = Extract<
  MutationResult<never>,
  { ok: false }
> & {
  callAttempt: ManualCallAttemptMetadata;
};

export type PreparedManualCallOperation = {
  id: string;
  contactId: string;
  agentMemberId: string;
  taskId: string | null;
  version: number;
  providerRequestKey: string;
  /** Provider-only value. It is never written to the operation/audit. */
  agentPhone: string;
};

export type PrepareManualCallResult =
  | { kind: "dispatch"; operation: PreparedManualCallOperation }
  | {
      kind: "settled";
      finalized: FinalizedManualCallOperation;
    };

type ManualCallProviderFailureBase = {
  providerOperationId: string | null;
  providerStatus: number | null;
  failureCode: string;
  failureDetail: string;
  resultCode: "rate_limited" | "provider_failed" | "conflict";
  responseStatus: number;
  retryable: boolean;
  message: string;
};

export type ManualCallProviderOutcome =
  | {
      state: "active";
      providerOperationId: string;
      providerStatus: number;
      failureCode: null;
      failureDetail: null;
      resultCode: null;
      responseStatus: 202;
      retryable: false;
      message: null;
    }
  | (ManualCallProviderFailureBase & { state: "failed" })
  | (ManualCallProviderFailureBase & {
      state: "reconciliation_required";
    });

export type FinalizedManualCallOperation = {
  result: MutationResult<ManualCallSuccessData>;
  status: number;
  callAttempt: ManualCallAttemptMetadata;
};

export type ManualCallOperationPlan =
  | { kind: "prepare" }
  | { kind: "reconcile_without_redispatch" }
  | { kind: "terminal" }
  | { kind: "corrupt" };

/** Pure replay decision: dispatched work is quarantined, never dispatched. */
export function planManualCallOperation(
  state: string,
): ManualCallOperationPlan {
  if (state === "requested") return { kind: "prepare" };
  if (state === "dispatched") {
    return { kind: "reconcile_without_redispatch" };
  }
  if (state === "active") return { kind: "terminal" };
  if (
    state === "succeeded" ||
    state === "failed" ||
    state === "reconciliation_required"
  ) {
    return { kind: "terminal" };
  }
  return { kind: "corrupt" };
}

/** Pure provider-certainty mapping used by the route and regression tests. */
export function classifyManualCallProviderResult(
  result: TwilioOutboundCallResult,
): ManualCallProviderOutcome {
  if (result.ok) {
    return {
      state: "active",
      providerOperationId: result.callSid,
      providerStatus: 201,
      failureCode: null,
      failureDetail: null,
      resultCode: null,
      responseStatus: 202,
      retryable: false,
      message: null,
    };
  }

  if (result.deliveryCertainty === "uncertain") {
    return {
      state: "reconciliation_required",
      providerOperationId: null,
      providerStatus: result.status,
      failureCode: result.detail,
      failureDetail:
        "Twilio may have accepted this call. Do not retry until provider activity is reconciled.",
      resultCode: "provider_failed",
      responseStatus: 502,
      retryable: false,
      message:
        "Twilio may have accepted this call, but confirmation was incomplete. Do not retry until provider activity is checked.",
    };
  }

  if (result.status === 429) {
    return {
      state: "failed",
      providerOperationId: null,
      providerStatus: 429,
      failureCode: result.detail,
      failureDetail:
        "Twilio rejected the call because its rate limit was reached.",
      resultCode: "rate_limited",
      responseStatus: 429,
      retryable: true,
      message:
        "Twilio did not accept the call because its rate limit was reached. Wait before starting a new call attempt.",
    };
  }

  const unavailable = result.detail === "twilio_call_not_configured";
  return {
    state: "failed",
    providerOperationId: null,
    providerStatus: result.status,
    failureCode: result.detail,
    failureDetail: unavailable
      ? "Twilio calling is not configured."
      : "Twilio rejected the call request.",
    resultCode: "provider_failed",
    responseStatus: unavailable ? 503 : 502,
    retryable: false,
    message: unavailable
      ? "Calling is unavailable because Twilio is not configured."
      : "Twilio rejected the call request. Review the CRM phone records before starting a new attempt.",
  };
}

function normalizedPhone(value: string | null): string | null {
  if (!value) return null;
  const parsed = parsePhoneNumberFromString(value, "US");
  return parsed?.isValid() === true ? parsed.number : null;
}

export function isCallCapableTaskNotes(value: string | null): boolean {
  return /(?:^|\s)kind=(?:speed_to_lead|follow_up|outbound|canvass|partner_checkin)(?:\s|$)/iu.test(
    value ?? "",
  );
}

function requireHumanActor(mutation: TeamMutationContext): {
  actorId: string;
  sessionId: string;
  authMethod: "team_session" | "break_glass";
} {
  if (
    mutation.principalType !== "human" ||
    !mutation.actor.id ||
    !mutation.actor.sessionId ||
    (mutation.actor.authMethod !== "team_session" &&
      mutation.actor.authMethod !== "break_glass")
  ) {
    throw new TeamMutationFailure(
      "internal",
      "The verified call principal is incomplete.",
    );
  }
  return {
    actorId: mutation.actor.id,
    sessionId: mutation.actor.sessionId,
    authMethod: mutation.actor.authMethod,
  };
}

function requireClaimEvidence(
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
): { idempotencyKeyHash: string; requestHash: string } {
  if (!mutation.idempotencyKeyHash) {
    throw new TeamMutationFailure(
      "invalid",
      "A valid Idempotency-Key is required to start a call.",
    );
  }
  return {
    idempotencyKeyHash: mutation.idempotencyKeyHash,
    requestHash: claim.requestHash,
  };
}

function nextTimestamp(previous: Date, candidate = new Date()): Date {
  return new Date(Math.max(candidate.getTime(), previous.getTime() + 1));
}

const CALLBACK_DEADLINE_MS = 4 * 60 * 60 * 1_000;

async function insertAttemptAudit(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  input: {
    operationId: string;
    contactId: string;
    agentMemberId: string;
    taskId: string | null;
    taskIntentCount: number;
    attemptedAt: Date;
  },
): Promise<string> {
  const actor = requireHumanActor(mutation);
  const auditEventId = randomUUID();
  await tx.insert(auditLogs).values({
    id: auditEventId,
    actorType: mutation.actor.type,
    actorId: actor.actorId,
    actorRole: mutation.actor.role ?? null,
    actorLabel: mutation.actor.label ?? null,
    sessionId: actor.sessionId,
    authMethod: actor.authMethod,
    correlationId: mutation.correlationId,
    requiredPermissions: mutation.policy.requiredPermissions,
    outcome: "attempted",
    idempotencyKeyHash: mutation.idempotencyKeyHash,
    action: mutation.policy.auditAction,
    entityType: "contact",
    entityId: input.contactId,
    meta: sanitizeAuditMetadata({
      callOperationId: input.operationId,
      agentMemberId: input.agentMemberId,
      taskId: input.taskId,
      taskIntentCount: input.taskIntentCount,
      provider: "twilio",
      providerCalled: false,
      providerIdempotencySupported: false,
      state: "dispatched",
    }),
    createdAt: input.attemptedAt,
  });
  return auditEventId;
}

async function insertProviderAcceptedAudit(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  operation: CallOperationRow,
  providerOperationId: string,
  acceptedAt: Date,
): Promise<string> {
  const actor = requireHumanActor(mutation);
  const auditEventId = randomUUID();
  await tx.insert(auditLogs).values({
    id: auditEventId,
    actorType: mutation.actor.type,
    actorId: actor.actorId,
    actorRole: mutation.actor.role ?? null,
    actorLabel: mutation.actor.label ?? null,
    sessionId: actor.sessionId,
    authMethod: actor.authMethod,
    correlationId: mutation.correlationId,
    requiredPermissions: mutation.policy.requiredPermissions,
    outcome: "attempted",
    providerOperationId,
    idempotencyKeyHash: mutation.idempotencyKeyHash,
    action: "call.provider_accepted",
    entityType: "contact",
    entityId: operation.contactId,
    meta: sanitizeAuditMetadata({
      callOperationId: operation.id,
      dispatchCorrelationId: operation.correlationId,
      agentMemberId: operation.agentMemberId,
      taskId: operation.taskId,
      state: "active",
      taskEffects: "pending",
      provider: operation.provider,
      providerStatus: 201,
      providerIdempotencySupported: false,
    }),
    createdAt: acceptedAt,
  });
  return auditEventId;
}

function terminalFailureResult(
  outcome: Extract<
    ManualCallProviderOutcome,
    { state: "failed" | "reconciliation_required" }
  >,
): Extract<MutationResult<never>, { ok: false }> {
  return {
    ok: false,
    code: outcome.resultCode,
    message: outcome.message,
    retryable: outcome.retryable,
  };
}

async function insertFailedTerminalAudit(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  operation: CallOperationRow,
  outcome: Extract<
    ManualCallProviderOutcome,
    { state: "failed" | "reconciliation_required" }
  >,
  committedAt: Date,
): Promise<string> {
  const auditEventId = randomUUID();
  const actor = requireHumanActor(mutation);
  await tx.insert(auditLogs).values({
    id: auditEventId,
    actorType: mutation.actor.type,
    actorId: actor.actorId,
    actorRole: mutation.actor.role ?? null,
    actorLabel: mutation.actor.label ?? null,
    sessionId: actor.sessionId,
    authMethod: actor.authMethod,
    correlationId: mutation.correlationId,
    requiredPermissions: mutation.policy.requiredPermissions,
    outcome: "failed",
    providerOperationId: outcome.providerOperationId,
    idempotencyKeyHash: mutation.idempotencyKeyHash,
    action: mutation.policy.auditAction,
    entityType: "contact",
    entityId: operation.contactId,
    meta: sanitizeAuditMetadata({
      callOperationId: operation.id,
      dispatchCorrelationId: operation.correlationId,
      agentMemberId: operation.agentMemberId,
      taskId: operation.taskId,
      state: outcome.state,
      provider: operation.provider,
      providerStatus: outcome.providerStatus,
      failureCode: outcome.failureCode,
      failureDetail: outcome.failureDetail,
      providerIdempotencySupported: false,
      redispatchPrevented: outcome.state === "reconciliation_required",
    }),
    createdAt: committedAt,
  });
  return auditEventId;
}

async function settleFailureInTransaction(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  operation: CallOperationRow,
  outcome: Extract<
    ManualCallProviderOutcome,
    { state: "failed" | "reconciliation_required" }
  >,
  now = new Date(),
): Promise<FinalizedManualCallOperation> {
  const completedAt = nextTimestamp(operation.dispatchedAt ?? now, now);
  const auditEventId = await insertFailedTerminalAudit(
    tx,
    mutation,
    operation,
    outcome,
    completedAt,
  );
  if (outcome.state === "failed") {
    await tx
      .update(teamCallOperationTaskIntents)
      .set({ effect: "not_dispatched", effectAt: completedAt })
      .where(
        and(
          eq(teamCallOperationTaskIntents.callOperationId, operation.id),
          eq(teamCallOperationTaskIntents.effect, "pending"),
        ),
      );
  }
  const [settled] = await tx
    .update(teamCallOperations)
    .set({
      state: outcome.state,
      version: operation.version + 1,
      providerOperationId: outcome.providerOperationId,
      terminalAuditEventId: auditEventId,
      terminalOutcome: outcome.state === "failed" ? "not_dispatched" : null,
      outcomeReason: outcome.failureCode,
      guardReleasedAt: outcome.state === "failed" ? completedAt : null,
      completedAt,
      reconciliationRequiredAt:
        outcome.state === "reconciliation_required" ? completedAt : null,
      providerStatus: outcome.providerStatus,
      failureCode: outcome.failureCode,
      failureDetail: outcome.failureDetail,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(teamCallOperations.id, operation.id),
        eq(teamCallOperations.state, operation.state),
        eq(teamCallOperations.version, operation.version),
      ),
    )
    .returning({
      id: teamCallOperations.id,
      version: teamCallOperations.version,
    });
  if (!settled) {
    throw new TeamMutationFailure(
      "conflict",
      "The call operation changed while its result was being saved. Do not retry; reconcile provider activity.",
    );
  }

  const result: ManualCallFailureResult = {
    ...terminalFailureResult(outcome),
    callAttempt: {
      operationId: operation.id,
      operationVersion: settled.version,
      state:
        outcome.state === "failed"
          ? "confirmed_not_sent"
          : "reconciliation_required",
      newAttempt: outcome.state === "failed" ? "explicit" : "blocked",
    },
  };
  await completeTeamMutationIdempotency(
    tx,
    mutation,
    claim,
    result,
    outcome.responseStatus,
    completedAt,
  );
  return {
    result,
    status: outcome.responseStatus,
    callAttempt: result.callAttempt,
  };
}

function interruptedDispatchOutcome(
  providerOperationId: string | null = null,
): Extract<ManualCallProviderOutcome, { state: "reconciliation_required" }> {
  return {
    state: "reconciliation_required",
    providerOperationId,
    providerStatus: providerOperationId ? 201 : null,
    failureCode: "call_dispatch_interrupted",
    failureDetail:
      "The provider boundary was crossed but the durable terminal receipt was not confirmed.",
    resultCode: "conflict",
    responseStatus: 409,
    retryable: false,
    message:
      "A previous call attempt may already be active. It was quarantined for reconciliation and was not sent again. Do not retry until provider activity is checked.",
  };
}

/**
 * Verify CRM identities and atomically move requested to dispatched while the
 * canonical contact lock is held. No provider work occurs in this function.
 */
export async function prepareManualCallOperation(input: {
  db: DatabaseClient;
  mutation: TeamMutationContext;
  claim: TeamMutationIdempotencyClaim;
  contactId: string;
  taskId: string | null;
  requestedAgentMemberId: string | null;
  now?: Date;
}): Promise<PrepareManualCallResult> {
  const actor = requireHumanActor(input.mutation);
  const evidence = requireClaimEvidence(input.mutation, input.claim);
  const now = input.now ?? new Date();

  return input.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.contactId}, 0))`,
    );

    const [existingForClaim] = await tx
      .select()
      .from(teamCallOperations)
      .where(eq(teamCallOperations.mutationClaimId, input.claim.id))
      .for("update")
      .limit(1);
    if (existingForClaim) {
      if (
        existingForClaim.providerOperationId &&
        (existingForClaim.state === "active" ||
          existingForClaim.state === "succeeded" ||
          (existingForClaim.state === "failed" &&
            existingForClaim.terminalOutcome === "not_connected"))
      ) {
        const finalized = await completeAcceptedMutation(tx, {
          mutation: input.mutation,
          claim: input.claim,
          operation: existingForClaim,
          providerOperationId: existingForClaim.providerOperationId,
          acceptedAt: existingForClaim.providerAcceptedAt ?? now,
        });
        return { kind: "settled" as const, finalized };
      }
      const plan = planManualCallOperation(existingForClaim.state);
      if (plan.kind === "reconcile_without_redispatch") {
        const settled = await settleFailureInTransaction(
          tx,
          input.mutation,
          input.claim,
          existingForClaim,
          interruptedDispatchOutcome(),
          now,
        );
        return {
          kind: "settled" as const,
          finalized: settled,
        };
      }
      throw new TeamMutationFailure(
        "conflict",
        plan.kind === "terminal"
          ? "This call attempt is already complete. Refresh to load its stored receipt."
          : "The saved call attempt is incomplete. Do not retry; contact support for reconciliation.",
      );
    }

    const [contact] = await tx
      .select({
        id: contacts.id,
        phone: contacts.phone,
        phoneE164: contacts.phoneE164,
        salespersonMemberId: contacts.salespersonMemberId,
        doNotContact: contacts.doNotContact,
        deletedAt: contacts.deletedAt,
      })
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .for("update")
      .limit(1);
    if (!contact?.id || contact.deletedAt) {
      throw new TeamMutationFailure(
        "conflict",
        "This contact is unavailable. No call was placed.",
      );
    }
    if (contact.doNotContact) {
      throw new TeamMutationFailure(
        "conflict",
        "This contact is marked Do Not Contact. No call was placed.",
      );
    }
    if (!normalizedPhone(contact.phoneE164 ?? contact.phone)) {
      throw new TeamMutationFailure(
        "invalid",
        "The contact does not have a valid calling phone.",
        { fieldErrors: { contactId: "Correct the contact phone first." } },
      );
    }

    const existingActive = await tx
      .select({
        id: teamCallOperations.id,
        state: teamCallOperations.state,
      })
      .from(teamCallOperations)
      .where(
        and(
          eq(teamCallOperations.contactId, contact.id),
          isNull(teamCallOperations.guardReleasedAt),
        ),
      )
      .limit(1);
    if (existingActive[0]) {
      throw new TeamMutationFailure(
        "conflict",
        existingActive[0].state === "requested"
          ? "Another call attempt is already being prepared for this contact."
          : "Another call attempt may already be active for this contact. Reconcile it before starting a new call.",
        { retryable: false },
      );
    }

    const config = await getSalesScorecardConfig(tx);
    const agentMemberId =
      input.requestedAgentMemberId ??
      contact.salespersonMemberId ??
      config.defaultAssigneeMemberId;
    if (!agentMemberId) {
      throw new TeamMutationFailure(
        "invalid",
        "No active salesperson is configured for calling.",
        { fieldErrors: { agentMemberId: "Choose an active salesperson." } },
      );
    }
    const [agent] = await tx
      .select({
        id: teamMembers.id,
        phoneE164: teamMembers.phoneE164,
        active: teamMembers.active,
      })
      .from(teamMembers)
      .where(eq(teamMembers.id, agentMemberId))
      .for("update")
      .limit(1);
    if (!agent?.id || !agent.active) {
      throw new TeamMutationFailure(
        "invalid",
        "The selected salesperson is inactive or unavailable.",
        { fieldErrors: { agentMemberId: "Choose an active salesperson." } },
      );
    }
    const agentPhone = normalizedPhone(agent.phoneE164);
    if (!agentPhone) {
      throw new TeamMutationFailure(
        "invalid",
        "The selected salesperson has no valid calling phone. Correct it in Access before calling.",
        { fieldErrors: { agentMemberId: "Set a valid calling phone." } },
      );
    }

    const taskIntents: Array<{
      taskId: string;
      kind: "explicit" | "speed_to_lead" | "follow_up";
      expectedUpdatedAt: Date;
    }> = [];
    if (input.taskId) {
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
        task.contactId !== contact.id ||
        task.status !== "open" ||
        task.assignedTo !== agent.id ||
        !isCallCapableTaskNotes(task.notes)
      ) {
        throw new TeamMutationFailure(
          "invalid",
          "The selected task is not an open call task assigned to this salesperson.",
          { fieldErrors: { taskId: "Refresh the Sales queue." } },
        );
      }
      taskIntents.push({
        taskId: task.id,
        kind: "explicit",
        expectedUpdatedAt: task.updatedAt,
      });
    }

    const speedTasks = await tx
      .select({ id: crmTasks.id, updatedAt: crmTasks.updatedAt })
      .from(crmTasks)
      .where(
        and(
          eq(crmTasks.contactId, contact.id),
          eq(crmTasks.assignedTo, agent.id),
          eq(crmTasks.status, "open"),
          isNotNull(crmTasks.notes),
          ilike(crmTasks.notes, "%kind=speed_to_lead%"),
        ),
      )
      .for("update");
    for (const task of speedTasks) {
      taskIntents.push({
        taskId: task.id,
        kind: "speed_to_lead",
        expectedUpdatedAt: task.updatedAt,
      });
    }

    const [followupTask] = await tx
      .select({ id: crmTasks.id, updatedAt: crmTasks.updatedAt })
      .from(crmTasks)
      .where(
        and(
          eq(crmTasks.contactId, contact.id),
          eq(crmTasks.assignedTo, agent.id),
          eq(crmTasks.status, "open"),
          isNotNull(crmTasks.dueAt),
          lte(crmTasks.dueAt, now),
          isNotNull(crmTasks.notes),
          or(
            ilike(crmTasks.notes, "%[auto] leadId=%"),
            ilike(crmTasks.notes, "%[auto] contactId=%"),
          ),
          ilike(crmTasks.notes, "%kind=follow_up%"),
        ),
      )
      .orderBy(asc(crmTasks.dueAt), asc(crmTasks.createdAt), asc(crmTasks.id))
      .for("update")
      .limit(1);
    if (followupTask) {
      taskIntents.push({
        taskId: followupTask.id,
        kind: "follow_up",
        expectedUpdatedAt: followupTask.updatedAt,
      });
    }

    const providerRequestKey = randomUUID();
    const [requested] = await tx
      .insert(teamCallOperations)
      .values({
        mutationClaimId: input.claim.id,
        contactId: contact.id,
        agentMemberId: agent.id,
        taskId: input.taskId,
        actorMemberId: actor.actorId,
        actorLabel: input.mutation.actor.label ?? null,
        actorRole: input.mutation.actor.role ?? null,
        sessionId: actor.sessionId,
        authMethod: actor.authMethod,
        correlationId: input.mutation.correlationId,
        idempotencyKeyHash: evidence.idempotencyKeyHash,
        requestHash: evidence.requestHash,
        state: "requested",
        version: 1,
        provider: "twilio",
        providerRequestKey,
        providerIdempotencySupported: false,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!requested) {
      throw new TeamMutationFailure(
        "internal",
        "The call attempt could not be prepared. No call was placed.",
        { retryable: true },
      );
    }

    if (taskIntents.length > 0) {
      await tx.insert(teamCallOperationTaskIntents).values(
        taskIntents.map((intent) => ({
          callOperationId: requested.id,
          taskId: intent.taskId,
          kind: intent.kind,
          expectedContactId: contact.id,
          expectedAssignedTo: agent.id,
          expectedUpdatedAt: intent.expectedUpdatedAt,
          effect: "pending" as const,
          createdAt: now,
        })),
      );
    }

    // Re-read authoritative DNC/lifecycle state immediately before crossing
    // the durable dispatched boundary, under the same contact lock.
    const [dispatchContact] = await tx
      .select({
        id: contacts.id,
        doNotContact: contacts.doNotContact,
        deletedAt: contacts.deletedAt,
      })
      .from(contacts)
      .where(eq(contacts.id, contact.id))
      .for("update")
      .limit(1);
    if (!dispatchContact?.id || dispatchContact.deletedAt) {
      throw new TeamMutationFailure(
        "conflict",
        "This contact became unavailable before dispatch. No call was placed.",
      );
    }
    if (dispatchContact.doNotContact) {
      throw new TeamMutationFailure(
        "conflict",
        "This contact was marked Do Not Contact before dispatch. No call was placed.",
      );
    }

    const dispatchedAt = nextTimestamp(requested.requestedAt, now);
    const attemptAuditEventId = await insertAttemptAudit(tx, input.mutation, {
      operationId: requested.id,
      contactId: contact.id,
      agentMemberId: agent.id,
      taskId: input.taskId,
      taskIntentCount: taskIntents.length,
      attemptedAt: dispatchedAt,
    });
    const [dispatched] = await tx
      .update(teamCallOperations)
      .set({
        state: "dispatched",
        version: requested.version + 1,
        attemptAuditEventId,
        dispatchedAt,
        callbackDeadlineAt: new Date(
          dispatchedAt.getTime() + CALLBACK_DEADLINE_MS,
        ),
        updatedAt: dispatchedAt,
      })
      .where(
        and(
          eq(teamCallOperations.id, requested.id),
          eq(teamCallOperations.state, "requested"),
          eq(teamCallOperations.version, requested.version),
        ),
      )
      .returning({
        id: teamCallOperations.id,
        version: teamCallOperations.version,
      });
    if (!dispatched) {
      throw new TeamMutationFailure(
        "conflict",
        "The call attempt changed before dispatch. No call was placed.",
      );
    }

    return {
      kind: "dispatch" as const,
      operation: {
        id: dispatched.id,
        contactId: contact.id,
        agentMemberId: agent.id,
        taskId: input.taskId,
        version: dispatched.version,
        providerRequestKey,
        agentPhone,
      },
    };
  });
}

function callSuccessData(
  operation: CallOperationRow,
  state: "active" | "succeeded" | "failed",
): ManualCallSuccessData {
  return {
    callOperationId: operation.id,
    state,
    provider: "twilio",
    providerIdempotencySupported: false,
    agentMemberId: operation.agentMemberId,
    taskId: operation.taskId,
    taskEffects:
      state === "succeeded"
        ? "completed"
        : state === "failed"
          ? "not_connected"
          : "pending",
    completedExplicitTaskId:
      state === "succeeded" ? operation.completedExplicitTaskId : null,
    completedFollowupTaskId:
      state === "succeeded" ? operation.completedFollowupTaskId : null,
    completedSpeedToLeadCount:
      state === "succeeded" ? operation.completedSpeedToLeadCount : 0,
  };
}

async function completeAcceptedMutation(
  tx: TeamMutationTransaction,
  input: {
    mutation: TeamMutationContext;
    claim: TeamMutationIdempotencyClaim;
    operation: CallOperationRow;
    providerOperationId: string;
    acceptedAt: Date;
  },
): Promise<FinalizedManualCallOperation> {
  let operation = input.operation;
  if (
    operation.providerOperationId &&
    operation.providerOperationId !== input.providerOperationId
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Twilio returned a different call identity than the signed callback. Do not retry; reconcile provider activity.",
    );
  }

  if (operation.state === "reconciliation_required") {
    throw new TeamMutationFailure(
      "conflict",
      "This call is quarantined for reconciliation. Do not retry.",
    );
  }
  if (
    operation.state === "failed" &&
    operation.terminalOutcome === "not_dispatched"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Provider acceptance conflicts with a stored rejection. Do not retry; reconcile provider activity.",
    );
  }

  if (operation.state === "succeeded") {
    if (
      !operation.providerAcceptedAuditEventId ||
      !operation.terminalAuditEventId ||
      !operation.completedAt ||
      !operation.providerOperationId
    ) {
      throw new TeamMutationFailure(
        "internal",
        "The connected-call receipt is incomplete. Do not retry.",
      );
    }
    const result = teamMutationSuccessResult(
      input.mutation,
      callSuccessData(operation, "succeeded"),
      {
        committedAt: operation.completedAt.toISOString(),
        auditEventId: operation.terminalAuditEventId,
        entityType: "contact",
        entityId: operation.contactId,
        version: operation.version,
        providerOperationId: operation.providerOperationId,
      },
    );
    await completeTeamMutationIdempotency(
      tx,
      input.mutation,
      input.claim,
      result,
      200,
      input.acceptedAt,
    );
    return {
      result,
      status: 200,
      callAttempt: {
        operationId: operation.id,
        operationVersion: operation.version,
        state: "succeeded",
        newAttempt: "none",
      },
    };
  }

  if (
    operation.state === "failed" &&
    operation.terminalOutcome === "not_connected"
  ) {
    if (
      !operation.providerAcceptedAuditEventId ||
      !operation.terminalAuditEventId ||
      !operation.completedAt ||
      !operation.providerOperationId
    ) {
      throw new TeamMutationFailure(
        "internal",
        "The not-connected call receipt is incomplete. Do not retry.",
      );
    }
    const result = teamMutationSuccessResult(
      input.mutation,
      callSuccessData(operation, "failed"),
      {
        committedAt: operation.completedAt.toISOString(),
        auditEventId: operation.terminalAuditEventId,
        entityType: "contact",
        entityId: operation.contactId,
        version: operation.version,
        providerOperationId: operation.providerOperationId,
      },
    );
    await completeTeamMutationIdempotency(
      tx,
      input.mutation,
      input.claim,
      result,
      200,
      input.acceptedAt,
    );
    return {
      result,
      status: 200,
      callAttempt: {
        operationId: operation.id,
        operationVersion: operation.version,
        state: "failed",
        newAttempt: "explicit",
      },
    };
  }

  let acceptanceAuditEventId = operation.providerAcceptedAuditEventId;
  if (!acceptanceAuditEventId) {
    acceptanceAuditEventId = await insertProviderAcceptedAudit(
      tx,
      input.mutation,
      operation,
      input.providerOperationId,
      input.acceptedAt,
    );
  }

  if (
    operation.state === "dispatched" ||
    (operation.state === "active" &&
      (!operation.providerAcceptedAuditEventId ||
        !operation.providerAcceptedAt ||
        operation.providerStatus !== 201))
  ) {
    const nextVersion = operation.version + 1;
    const [accepted] = await tx
      .update(teamCallOperations)
      .set({
        state: "active",
        version: nextVersion,
        providerOperationId: input.providerOperationId,
        providerAcceptedAuditEventId: acceptanceAuditEventId,
        providerAcceptedAt: operation.providerAcceptedAt ?? input.acceptedAt,
        providerStatus: 201,
        callbackDeadlineAt:
          operation.callbackDeadlineAt ??
          new Date(input.acceptedAt.getTime() + CALLBACK_DEADLINE_MS),
        updatedAt: input.acceptedAt,
      })
      .where(
        and(
          eq(teamCallOperations.id, operation.id),
          eq(teamCallOperations.state, operation.state),
          eq(teamCallOperations.version, operation.version),
        ),
      )
      .returning();
    if (!accepted) {
      throw new TeamMutationFailure(
        "conflict",
        "The call changed while provider acceptance was being saved. Do not retry.",
      );
    }
    operation = accepted;
  }

  const result = teamMutationSuccessResult(
    input.mutation,
    callSuccessData(operation, "active"),
    {
      committedAt: (
        operation.providerAcceptedAt ?? input.acceptedAt
      ).toISOString(),
      auditEventId: acceptanceAuditEventId,
      entityType: "contact",
      entityId: operation.contactId,
      version: operation.version,
      providerOperationId: input.providerOperationId,
    },
  );
  await completeTeamMutationIdempotency(
    tx,
    input.mutation,
    input.claim,
    result,
    202,
    input.acceptedAt,
  );
  return {
    result,
    status: 202,
    callAttempt: {
      operationId: operation.id,
      operationVersion: operation.version,
      state: "active",
      newAttempt: "none",
    },
  };
}

export async function finalizeManualCallOperation(input: {
  db: DatabaseClient;
  mutation: TeamMutationContext;
  claim: TeamMutationIdempotencyClaim;
  operationId: string;
  providerResult: TwilioOutboundCallResult;
  now?: Date;
}): Promise<FinalizedManualCallOperation> {
  const outcome = classifyManualCallProviderResult(input.providerResult);
  const now = input.now ?? new Date();

  return input.db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(teamCallOperations)
      .where(eq(teamCallOperations.id, input.operationId))
      .for("update")
      .limit(1);
    if (!operation || operation.mutationClaimId !== input.claim.id) {
      throw new TeamMutationFailure(
        "internal",
        "The durable call attempt could not be verified. Do not retry; reconcile provider activity.",
      );
    }
    if (outcome.state !== "active") {
      // A signed callback can prove provider acceptance before the create-call
      // response reaches this process. That evidence wins over an ambiguous
      // transport result, but never over a contradictory definitive rejection.
      if (
        operation.providerOperationId &&
        (operation.state === "active" ||
          operation.state === "succeeded" ||
          (operation.state === "failed" &&
            operation.terminalOutcome === "not_connected"))
      ) {
        if (outcome.state === "reconciliation_required") {
          return completeAcceptedMutation(tx, {
            mutation: input.mutation,
            claim: input.claim,
            operation,
            providerOperationId: operation.providerOperationId,
            acceptedAt: operation.providerAcceptedAt ?? now,
          });
        }
        return settleFailureInTransaction(
          tx,
          input.mutation,
          input.claim,
          operation,
          interruptedDispatchOutcome(operation.providerOperationId),
          now,
        );
      }
      if (operation.state !== "dispatched") {
        throw new TeamMutationFailure(
          "conflict",
          "The call attempt changed before its provider result was saved. Do not retry.",
        );
      }
      return settleFailureInTransaction(
        tx,
        input.mutation,
        input.claim,
        operation,
        outcome,
        now,
      );
    }
    return completeAcceptedMutation(tx, {
      mutation: input.mutation,
      claim: input.claim,
      operation,
      providerOperationId: outcome.providerOperationId,
      acceptedAt: now,
    });
  });
}

/**
 * A provider acceptance followed by any transaction/receipt failure is
 * quarantined in a second transaction. If even that evidence write fails,
 * dispatched remains durable and callers receive explicit do-not-retry text.
 */
export async function reconcileManualCallAfterTerminalStorageFailure(input: {
  db: DatabaseClient;
  mutation: TeamMutationContext;
  claim: TeamMutationIdempotencyClaim;
  operationId: string;
  providerOperationId: string | null;
  now?: Date;
}): Promise<FinalizedManualCallOperation> {
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(teamCallOperations)
      .where(eq(teamCallOperations.id, input.operationId))
      .for("update")
      .limit(1);
    if (!operation || operation.mutationClaimId !== input.claim.id) {
      throw new TeamMutationFailure(
        "internal",
        "The accepted call could not be matched to its durable evidence. Do not retry; reconcile Twilio manually.",
      );
    }
    if (
      input.providerOperationId &&
      operation.providerOperationId === input.providerOperationId &&
      (operation.state === "active" || operation.state === "succeeded")
    ) {
      return completeAcceptedMutation(tx, {
        mutation: input.mutation,
        claim: input.claim,
        operation,
        providerOperationId: input.providerOperationId,
        acceptedAt: operation.providerAcceptedAt ?? now,
      });
    }
    if (operation.state !== "dispatched") {
      throw new TeamMutationFailure(
        "conflict",
        "The call attempt is already terminal. Refresh its stored result and do not retry.",
      );
    }

    return settleFailureInTransaction(
      tx,
      input.mutation,
      input.claim,
      operation,
      interruptedDispatchOutcome(input.providerOperationId),
      now,
    );
  });
}
