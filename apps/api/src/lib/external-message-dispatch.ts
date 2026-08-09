import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  auditLogs,
  contacts,
  conversationMessages,
  externalMessageDispatches,
  getDb,
  messageDeliveryEvents,
  outboxEvents,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import type { SendResult } from "@/lib/messaging";

export type ExternalMessageChannel = "sms" | "email" | "dm";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ContactDispatchEligibility =
  | { kind: "eligible"; dncOverrideUsed: boolean }
  | {
      kind: "blocked";
      reason:
        | "contact_unavailable_before_message_dispatch"
        | "contact_dnc_before_message_dispatch";
    };

export function planContactDispatchEligibility(
  contact: { deletedAt: Date | null; doNotContact: boolean } | null,
  allowDncOverride: boolean,
): ContactDispatchEligibility {
  if (!contact || contact.deletedAt) {
    return {
      kind: "blocked",
      reason: "contact_unavailable_before_message_dispatch",
    };
  }
  if (contact.doNotContact && !allowDncOverride) {
    return {
      kind: "blocked",
      reason: "contact_dnc_before_message_dispatch",
    };
  }
  return {
    kind: "eligible",
    dncOverrideUsed: contact.doNotContact && allowDncOverride,
  };
}

export const MESSAGE_DISPATCH_UNCERTAINTY_WINDOW_MS = 15 * 60 * 1_000;
export const MESSAGE_DISPATCH_RECONCILIATION_REASON =
  "message_provider_effect_uncertain";

type DispatchRow = typeof externalMessageDispatches.$inferSelect;

export type PersistedDispatchPlan =
  | { kind: "claim" }
  | { kind: "in_flight"; retryAt: Date }
  | {
      kind: "settled";
      state: "succeeded" | "failed" | "reconciliation_required";
      retryable: boolean;
      error: string | null;
      outboxFinalized: boolean;
    };

export function planPersistedMessageDispatch(
  dispatch: Pick<
    DispatchRow,
    "state" | "uncertaintyAt" | "retryable" | "failureDetail"
  >,
  now = new Date(),
): PersistedDispatchPlan {
  if (dispatch.state === "requested") return { kind: "claim" };
  if (dispatch.state === "dispatched") {
    const retryAt = dispatch.uncertaintyAt;
    if (retryAt && retryAt.getTime() > now.getTime()) {
      return { kind: "in_flight", retryAt };
    }
    return {
      kind: "settled",
      state: "reconciliation_required",
      retryable: false,
      error: MESSAGE_DISPATCH_RECONCILIATION_REASON,
      outboxFinalized: false,
    };
  }
  return {
    kind: "settled",
    state: dispatch.state,
    retryable: dispatch.state === "failed" && dispatch.retryable === true,
    error: dispatch.failureDetail ?? null,
    outboxFinalized: dispatch.state === "reconciliation_required",
  };
}

function requestKeyHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeOperationIds(result: SendResult): string[] {
  const candidates = [
    ...(Array.isArray(result.providerOperationIds)
      ? result.providerOperationIds
      : []),
    result.providerMessageId,
  ];
  return Array.from(
    new Set(
      candidates
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

async function insertWorkerAudit(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: {
    action: string;
    outcome: "attempted" | "succeeded" | "failed";
    messageId: string;
    dispatchId: string;
    channel: ExternalMessageChannel;
    providerRequestKey: string;
    provider?: string | null;
    providerOperationId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    actorType: "worker",
    actorId: null,
    actorRole: "outbox-dispatcher",
    actorLabel: "outbox-dispatcher",
    authMethod: "service",
    outcome: input.outcome,
    providerOperationId: input.providerOperationId ?? null,
    idempotencyKeyHash: requestKeyHash(input.providerRequestKey),
    action: input.action,
    entityType: "conversation_message",
    entityId: input.messageId,
    meta: sanitizeAuditMetadata({
      dispatchId: input.dispatchId,
      channel: input.channel,
      provider: input.provider ?? null,
      ...input.metadata,
    }),
    createdAt: input.createdAt,
  });
}

export type EnsureDispatchResult =
  | { kind: "ready"; dispatch: DispatchRow }
  | { kind: "unavailable" }
  | {
      kind: "contact_unavailable";
      reason:
        | "contact_unavailable_before_message_dispatch"
        | "contact_dnc_before_message_dispatch";
      outboxFinalized: true;
    };

/**
 * Commit requested independently from dispatched. This is intentionally a
 * separate transaction from claimMessageDispatch: a process death between
 * the two leaves safe requested work, not an ambiguous provider effect.
 */
export async function ensureMessageDispatchRequested(input: {
  outboxEventId: string;
  messageId: string;
  contactId: string;
  channel: ExternalMessageChannel;
  attemptNumber: number;
  allowDncOverride?: boolean;
  now?: Date;
}): Promise<EnsureDispatchResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // Contact is always the first lock in the send/delete protocol. Keeping
    // this order aligned with contact DELETE prevents an outbox-row/contact
    // lock inversion under concurrency.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.contactId}, 0))`,
    );
    const [contact] = await tx
      .select({
        id: contacts.id,
        deletedAt: contacts.deletedAt,
        doNotContact: contacts.doNotContact,
      })
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .for("update")
      .limit(1);

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.outboxEventId}, 1))`,
    );
    const [event] = await tx
      .select({
        id: outboxEvents.id,
        processedAt: outboxEvents.processedAt,
        quarantinedAt: outboxEvents.quarantinedAt,
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, input.outboxEventId))
      .for("update")
      .limit(1);
    if (!event || event.processedAt || event.quarantinedAt) {
      return { kind: "unavailable" as const };
    }

    const [existing] = await tx
      .select()
      .from(externalMessageDispatches)
      .where(
        and(
          eq(externalMessageDispatches.outboxEventId, input.outboxEventId),
          eq(externalMessageDispatches.attemptNumber, input.attemptNumber),
        ),
      )
      .limit(1);

    const eligibility = planContactDispatchEligibility(
      contact ?? null,
      input.allowDncOverride === true,
    );
    if (
      eligibility.kind === "blocked" &&
      (!existing || existing.state === "requested")
    ) {
      const reason = eligibility.reason;
      await tx
        .update(outboxEvents)
        .set({
          quarantinedAt: now,
          quarantinedBy: null,
          quarantineReason: reason,
          quarantinedContactId: input.contactId,
          nextAttemptAt: null,
          lastError: reason,
        })
        .where(
          and(
            eq(outboxEvents.id, input.outboxEventId),
            isNull(outboxEvents.processedAt),
            isNull(outboxEvents.quarantinedAt),
          ),
        );
      await tx
        .update(conversationMessages)
        .set({ deliveryStatus: "failed" })
        .where(eq(conversationMessages.id, input.messageId));
      await tx.insert(messageDeliveryEvents).values({
        messageId: input.messageId,
        status: "failed",
        detail: reason,
        provider: null,
        occurredAt: now,
      });
      await tx.insert(auditLogs).values({
        actorType: "worker",
        actorId: null,
        actorRole: "outbox-dispatcher",
        actorLabel: "outbox-dispatcher",
        authMethod: "service",
        outcome: "failed",
        action: "message.dispatch.blocked",
        entityType: "conversation_message",
        entityId: input.messageId,
        meta: sanitizeAuditMetadata({
          outboxEventId: input.outboxEventId,
          contactId: input.contactId,
          channel: input.channel,
          attemptNumber: input.attemptNumber,
          reason,
          dncOverrideAllowed: input.allowDncOverride === true,
          providerCalled: false,
        }),
        createdAt: now,
      });
      return {
        kind: "contact_unavailable" as const,
        reason,
        outboxFinalized: true,
      };
    }
    if (existing) return { kind: "ready" as const, dispatch: existing };

    const providerRequestKey = randomUUID();
    const [created] = await tx
      .insert(externalMessageDispatches)
      .values({
        outboxEventId: input.outboxEventId,
        messageId: input.messageId,
        contactId: input.contactId,
        channel: input.channel,
        attemptNumber: input.attemptNumber,
        state: "requested",
        version: 1,
        providerRequestKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("message_dispatch_request_not_persisted");

    await insertWorkerAudit(tx, {
      action: "message.dispatch.requested",
      outcome: "attempted",
      messageId: input.messageId,
      dispatchId: created.id,
      channel: input.channel,
      providerRequestKey,
      metadata: {
        attemptNumber: input.attemptNumber,
        dncOverrideUsed:
          eligibility.kind === "eligible" && eligibility.dncOverrideUsed,
      },
      createdAt: now,
    });
    return { kind: "ready" as const, dispatch: created };
  });
}

export type ClaimDispatchResult =
  | {
      kind: "dispatch";
      dispatchId: string;
      providerRequestKey: string;
    }
  | { kind: "in_flight"; retryAt: Date }
  | {
      kind: "settled";
      state: "succeeded" | "failed" | "reconciliation_required";
      retryable: boolean;
      error: string | null;
      outboxFinalized: boolean;
    }
  | { kind: "unavailable"; outboxFinalized: boolean };

export async function claimMessageDispatch(input: {
  dispatchId: string;
  now?: Date;
}): Promise<ClaimDispatchResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [scope] = await tx
      .select({ contactId: externalMessageDispatches.contactId })
      .from(externalMessageDispatches)
      .where(eq(externalMessageDispatches.id, input.dispatchId))
      .limit(1);
    if (!scope) return { kind: "unavailable" as const, outboxFinalized: false };

    // Match the contact-delete lock order before taking the dispatch row lock.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope.contactId}, 0))`,
    );
    const [dispatch] = await tx
      .select()
      .from(externalMessageDispatches)
      .where(eq(externalMessageDispatches.id, input.dispatchId))
      .for("update")
      .limit(1);
    if (!dispatch)
      return { kind: "unavailable" as const, outboxFinalized: false };

    const plan = planPersistedMessageDispatch(dispatch, now);
    if (plan.kind === "in_flight") return plan;
    if (plan.kind === "settled") {
      if (dispatch.state === "dispatched") {
        const [reconciled] = await tx
          .update(externalMessageDispatches)
          .set({
            state: "reconciliation_required",
            version: dispatch.version + 1,
            completedAt: now,
            reconciliationRequiredAt: now,
            failureDetail: MESSAGE_DISPATCH_RECONCILIATION_REASON,
            retryable: false,
            updatedAt: now,
          })
          .where(
            and(
              eq(externalMessageDispatches.id, dispatch.id),
              eq(externalMessageDispatches.state, "dispatched"),
              eq(externalMessageDispatches.version, dispatch.version),
            ),
          )
          .returning({ id: externalMessageDispatches.id });
        if (!reconciled) {
          throw new Error("message_dispatch_reconciliation_conflict");
        }
        await tx
          .update(conversationMessages)
          .set({ deliveryStatus: "failed" })
          .where(eq(conversationMessages.id, dispatch.messageId));
        await tx.insert(messageDeliveryEvents).values({
          messageId: dispatch.messageId,
          status: "failed",
          detail: MESSAGE_DISPATCH_RECONCILIATION_REASON,
          provider: dispatch.provider,
          occurredAt: now,
        });
        await tx
          .update(outboxEvents)
          .set({
            quarantinedAt: now,
            quarantinedBy: null,
            quarantineReason: MESSAGE_DISPATCH_RECONCILIATION_REASON,
            quarantinedContactId: dispatch.contactId,
            nextAttemptAt: null,
            lastError: MESSAGE_DISPATCH_RECONCILIATION_REASON,
          })
          .where(
            and(
              eq(outboxEvents.id, dispatch.outboxEventId),
              isNull(outboxEvents.processedAt),
              isNull(outboxEvents.quarantinedAt),
            ),
          );
        await insertWorkerAudit(tx, {
          action: "message.reconciliation_required",
          outcome: "failed",
          messageId: dispatch.messageId,
          dispatchId: dispatch.id,
          channel: dispatch.channel as ExternalMessageChannel,
          providerRequestKey: dispatch.providerRequestKey,
          provider: dispatch.provider,
          providerOperationId: dispatch.providerOperationId,
          metadata: {
            reason: MESSAGE_DISPATCH_RECONCILIATION_REASON,
            attemptNumber: dispatch.attemptNumber,
            redispatchPrevented: true,
            providerExactlyOnceClaimed: false,
          },
          createdAt: now,
        });
        return { ...plan, outboxFinalized: true };
      }
      return plan;
    }

    const [contact] = await tx
      .select({
        id: contacts.id,
        deletedAt: contacts.deletedAt,
        doNotContact: contacts.doNotContact,
      })
      .from(contacts)
      .where(eq(contacts.id, dispatch.contactId))
      .limit(1);
    const [messageScope] = await tx
      .select({ metadata: conversationMessages.metadata })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, dispatch.messageId))
      .limit(1);
    const allowDncOverride =
      isRecord(messageScope?.metadata) &&
      messageScope.metadata["allowDncOverride"] === true;
    const eligibility = planContactDispatchEligibility(
      contact ?? null,
      allowDncOverride,
    );
    if (eligibility.kind === "blocked") {
      const detail =
        eligibility.reason === "contact_dnc_before_message_dispatch"
          ? "contact_dnc_before_provider_dispatch"
          : "contact_unavailable_before_provider_dispatch";
      await tx
        .update(externalMessageDispatches)
        .set({
          state: "failed",
          version: dispatch.version + 1,
          completedAt: now,
          failureDetail: detail,
          retryable: false,
          updatedAt: now,
        })
        .where(
          and(
            eq(externalMessageDispatches.id, dispatch.id),
            eq(externalMessageDispatches.state, "requested"),
            eq(externalMessageDispatches.version, dispatch.version),
          ),
        );
      await tx
        .update(outboxEvents)
        .set({
          quarantinedAt: now,
          quarantinedBy: null,
          quarantineReason: detail,
          quarantinedContactId: dispatch.contactId,
          nextAttemptAt: null,
          lastError: detail,
        })
        .where(
          and(
            eq(outboxEvents.id, dispatch.outboxEventId),
            isNull(outboxEvents.processedAt),
            isNull(outboxEvents.quarantinedAt),
          ),
        );
      await tx
        .update(conversationMessages)
        .set({ deliveryStatus: "failed" })
        .where(eq(conversationMessages.id, dispatch.messageId));
      await tx.insert(messageDeliveryEvents).values({
        messageId: dispatch.messageId,
        status: "failed",
        detail,
        provider: null,
        occurredAt: now,
      });
      await insertWorkerAudit(tx, {
        action: "message.failed",
        outcome: "failed",
        messageId: dispatch.messageId,
        dispatchId: dispatch.id,
        channel: dispatch.channel as ExternalMessageChannel,
        providerRequestKey: dispatch.providerRequestKey,
        metadata: {
          reason: detail,
          providerCalled: false,
          dncOverrideAllowed: allowDncOverride,
        },
        createdAt: now,
      });
      return {
        kind: "settled" as const,
        state: "failed" as const,
        retryable: false,
        error: detail,
        outboxFinalized: true,
      };
    }

    const uncertaintyAt = new Date(
      now.getTime() + MESSAGE_DISPATCH_UNCERTAINTY_WINDOW_MS,
    );
    const [claimed] = await tx
      .update(externalMessageDispatches)
      .set({
        state: "dispatched",
        version: dispatch.version + 1,
        dispatchedAt: now,
        uncertaintyAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(externalMessageDispatches.id, dispatch.id),
          eq(externalMessageDispatches.state, "requested"),
          eq(externalMessageDispatches.version, dispatch.version),
        ),
      )
      .returning({ id: externalMessageDispatches.id });
    if (!claimed) throw new Error("message_dispatch_claim_conflict");

    await tx
      .update(outboxEvents)
      .set({ nextAttemptAt: uncertaintyAt, lastError: null })
      .where(
        and(
          eq(outboxEvents.id, dispatch.outboxEventId),
          isNull(outboxEvents.processedAt),
          isNull(outboxEvents.quarantinedAt),
        ),
      );
    await insertWorkerAudit(tx, {
      action: "message.dispatch.dispatched",
      outcome: "attempted",
      messageId: dispatch.messageId,
      dispatchId: dispatch.id,
      channel: dispatch.channel as ExternalMessageChannel,
      providerRequestKey: dispatch.providerRequestKey,
      metadata: {
        attemptNumber: dispatch.attemptNumber,
        uncertaintyAt: uncertaintyAt.toISOString(),
        providerExactlyOnceClaimed: false,
      },
      createdAt: now,
    });
    return {
      kind: "dispatch" as const,
      dispatchId: dispatch.id,
      providerRequestKey: dispatch.providerRequestKey,
    };
  });
}

export type FinalizeDispatchResult = {
  state: "succeeded" | "failed" | "reconciliation_required";
  retryable: boolean;
  error: string | null;
  outboxFinalized: boolean;
};

/**
 * Persist the provider result and the user-visible message state together.
 * If this transaction cannot commit after the call, dispatched remains
 * durable and the next worker quarantines it for reconciliation.
 */
export async function finalizeMessageDispatch(input: {
  dispatchId: string;
  result: SendResult;
  retryable: boolean;
  now?: Date;
}): Promise<FinalizeDispatchResult> {
  const db = getDb();
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [dispatch] = await tx
      .select()
      .from(externalMessageDispatches)
      .where(eq(externalMessageDispatches.id, input.dispatchId))
      .for("update")
      .limit(1);
    if (!dispatch) throw new Error("message_dispatch_not_found");

    const existing = planPersistedMessageDispatch(dispatch, now);
    if (existing.kind === "settled" && dispatch.state !== "dispatched") {
      return {
        state: existing.state,
        retryable: existing.retryable,
        error: existing.error,
        outboxFinalized: existing.outboxFinalized,
      };
    }
    if (dispatch.state !== "dispatched") {
      throw new Error("message_dispatch_not_dispatched");
    }

    const providerOperationIds = safeOperationIds(input.result);
    const providerOperationId =
      input.result.providerMessageId ?? providerOperationIds[0] ?? null;
    const uncertain =
      !input.result.ok && input.result.deliveryCertainty === "uncertain";
    const succeeded = input.result.ok;
    const state = uncertain
      ? "reconciliation_required"
      : succeeded
        ? "succeeded"
        : "failed";
    const detail = succeeded
      ? null
      : (input.result.detail ??
        (uncertain ? MESSAGE_DISPATCH_RECONCILIATION_REASON : "send_failed"));
    const retryable = state === "failed" && input.retryable;

    const [settled] = await tx
      .update(externalMessageDispatches)
      .set({
        state,
        version: dispatch.version + 1,
        provider: input.result.provider ?? null,
        providerOperationId,
        providerOperationIds,
        providerIdempotencySupported:
          input.result.providerIdempotencySupported === true,
        completedAt: now,
        reconciliationRequiredAt: uncertain ? now : null,
        failureDetail: detail,
        retryable: succeeded ? null : retryable,
        updatedAt: now,
      })
      .where(
        and(
          eq(externalMessageDispatches.id, dispatch.id),
          eq(externalMessageDispatches.state, "dispatched"),
          eq(externalMessageDispatches.version, dispatch.version),
        ),
      )
      .returning({ id: externalMessageDispatches.id });
    if (!settled) throw new Error("message_dispatch_finalize_conflict");

    await tx
      .update(conversationMessages)
      .set({
        deliveryStatus: succeeded ? "sent" : retryable ? "queued" : "failed",
        provider: input.result.provider ?? null,
        providerMessageId: providerOperationId,
        sentAt: succeeded ? now : null,
      })
      .where(eq(conversationMessages.id, dispatch.messageId));
    await tx.insert(messageDeliveryEvents).values({
      messageId: dispatch.messageId,
      status: succeeded ? "sent" : "failed",
      detail,
      provider: input.result.provider ?? null,
      occurredAt: now,
    });

    let outboxFinalized = false;
    if (uncertain) {
      await tx
        .update(outboxEvents)
        .set({
          quarantinedAt: now,
          quarantinedBy: null,
          quarantineReason: MESSAGE_DISPATCH_RECONCILIATION_REASON,
          quarantinedContactId: dispatch.contactId,
          nextAttemptAt: null,
          lastError: detail,
        })
        .where(
          and(
            eq(outboxEvents.id, dispatch.outboxEventId),
            isNull(outboxEvents.processedAt),
            isNull(outboxEvents.quarantinedAt),
          ),
        );
      outboxFinalized = true;
    }

    await insertWorkerAudit(tx, {
      action: uncertain
        ? "message.reconciliation_required"
        : succeeded
          ? "message.sent"
          : "message.failed",
      outcome: succeeded ? "succeeded" : "failed",
      messageId: dispatch.messageId,
      dispatchId: dispatch.id,
      channel: dispatch.channel as ExternalMessageChannel,
      providerRequestKey: dispatch.providerRequestKey,
      provider: input.result.provider ?? null,
      providerOperationId,
      metadata: {
        attemptNumber: dispatch.attemptNumber,
        retryable,
        detail,
        providerOperationIds,
        providerIdempotencySupported:
          input.result.providerIdempotencySupported === true,
        providerExactlyOnceClaimed: false,
        redispatchPrevented: uncertain,
      },
      createdAt: now,
    });

    return { state, retryable, error: detail, outboxFinalized };
  });
}
