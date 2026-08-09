import type { ActionPolicy } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  contacts,
  conversationMessages,
  conversationThreads,
  externalMessageDispatches,
  getDb,
  messageDeliveryEvents,
  outboxEvents,
} from "@/db";
import { requireActiveContactForDirectOutbound } from "@/lib/contact-outbound-safety";
import { completeNextFollowupTaskOnTouch } from "@/lib/sales-followups";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type MessageRetryData = {
  messageId: string;
  threadId: string;
  outboxEventId: string;
  state: "requested";
  changed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDraft(metadata: unknown): boolean {
  return isRecord(metadata) && metadata["draft"] === true;
}

function clearDraftFlag(metadata: unknown): Record<string, unknown> | null {
  if (!isRecord(metadata)) return null;
  if (metadata["draft"] !== true) return metadata;
  const copy = { ...metadata };
  delete copy["draft"];
  return copy;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ messageId: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human", "service"],
    requiredPermissions: ["messages.send"],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "message.retry",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { messageId: rawMessageId } = await context.params;
  const messageId = rawMessageId?.trim() ?? "";
  if (!messageId) {
    return teamMutationExceptionResponse(
      new TeamMutationFailure("invalid", "A message is required.", {
        fieldErrors: { messageId: "Refresh the thread and try again." },
      }),
      mutation,
    );
  }

  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/inbox/messages/:messageId/retry",
      entityType: "conversation_message",
      entityId: messageId,
      payload: { intent: "queue_manual_send" },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      // Lock the message before inspecting its send state. This serializes
      // different request keys for the same message, not only exact replays.
      const [message] = await tx
        .select({
          id: conversationMessages.id,
          deliveryStatus: conversationMessages.deliveryStatus,
          direction: conversationMessages.direction,
          threadId: conversationMessages.threadId,
          metadata: conversationMessages.metadata,
          contactId: conversationThreads.contactId,
          salespersonMemberId: contacts.salespersonMemberId,
        })
        .from(conversationMessages)
        .leftJoin(
          conversationThreads,
          eq(conversationMessages.threadId, conversationThreads.id),
        )
        .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
        .where(eq(conversationMessages.id, messageId))
        .for("update", { of: conversationMessages })
        .limit(1);

      if (!message) {
        throw new TeamMutationFailure(
          "invalid",
          "The message no longer exists.",
          {
            status: 404,
            fieldErrors: {
              messageId: "Refresh the thread and choose another message.",
            },
          },
        );
      }
      if (message.direction !== "outbound") {
        throw new TeamMutationFailure(
          "invalid",
          "Only outbound messages can be queued for sending.",
          {
            fieldErrors: {
              messageId: "Choose an outbound draft or failed send.",
            },
          },
        );
      }
      if (
        message.deliveryStatus !== "failed" &&
        message.deliveryStatus !== "queued"
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "This message is no longer waiting or failed. Refresh the thread before taking another action.",
        );
      }
      if (message.contactId) {
        await requireActiveContactForDirectOutbound(tx, message.contactId);
      }

      // Lock a pending outbox row before reading provider attempts. If a
      // worker is already claiming it, this query waits and then sees the
      // committed state instead of creating a second event from stale data.
      const [pendingEvent] = await tx
        .select({
          id: outboxEvents.id,
          quarantinedAt: outboxEvents.quarantinedAt,
        })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.type, "message.send"),
            isNull(outboxEvents.processedAt),
            sql`payload->>'messageId' = ${messageId}`,
          ),
        )
        .orderBy(desc(outboxEvents.createdAt), desc(outboxEvents.id))
        .for("update")
        .limit(1);

      const [latestDispatch] = await tx
        .select({
          id: externalMessageDispatches.id,
          state: externalMessageDispatches.state,
        })
        .from(externalMessageDispatches)
        .where(eq(externalMessageDispatches.messageId, messageId))
        .orderBy(
          desc(externalMessageDispatches.createdAt),
          desc(externalMessageDispatches.id),
        )
        .for("update")
        .limit(1);

      if (
        latestDispatch?.state === "requested" ||
        latestDispatch?.state === "dispatched" ||
        latestDispatch?.state === "reconciliation_required"
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "This provider operation is already pending or may already have happened. Reconcile it before attempting another send.",
        );
      }
      if (latestDispatch?.state === "succeeded") {
        throw new TeamMutationFailure(
          "conflict",
          "This message already has a successful provider dispatch and cannot be retried.",
        );
      }
      if (pendingEvent?.quarantinedAt) {
        throw new TeamMutationFailure(
          "conflict",
          "This message is quarantined for review and cannot be retried. Compose a new message after the contact is restored and reviewed.",
        );
      }

      const now = new Date();
      let outboxEventId: string;
      let changed =
        isDraft(message.metadata) || message.deliveryStatus !== "queued";
      if (latestDispatch?.state === "failed") {
        // A terminal attempt is immutable. Close any stale shell and create a
        // fresh outbox event rather than mutating the provider history.
        if (pendingEvent?.id) {
          const [superseded] = await tx
            .update(outboxEvents)
            .set({
              processedAt: now,
              nextAttemptAt: null,
              lastError: "superseded_by_manual_retry",
            })
            .where(
              and(
                eq(outboxEvents.id, pendingEvent.id),
                isNull(outboxEvents.processedAt),
                isNull(outboxEvents.quarantinedAt),
              ),
            )
            .returning({ id: outboxEvents.id });
          if (!superseded) {
            throw new TeamMutationFailure(
              "conflict",
              "The message retry state changed. Refresh the thread before retrying.",
              { retryable: true },
            );
          }
        }
        const [created] = await tx
          .insert(outboxEvents)
          .values({
            type: "message.send",
            payload: { messageId },
            createdAt: now,
          })
          .returning({ id: outboxEvents.id });
        if (!created) {
          throw new TeamMutationFailure(
            "internal",
            "The send request could not be queued.",
            { retryable: true },
          );
        }
        outboxEventId = created.id;
        changed = true;
      } else if (pendingEvent?.id) {
        const [reactivated] = await tx
          .update(outboxEvents)
          .set({ nextAttemptAt: now, lastError: null })
          .where(
            and(
              eq(outboxEvents.id, pendingEvent.id),
              isNull(outboxEvents.processedAt),
              isNull(outboxEvents.quarantinedAt),
            ),
          )
          .returning({ id: outboxEvents.id });
        if (!reactivated) {
          throw new TeamMutationFailure(
            "conflict",
            "The message retry state changed. Refresh the thread before retrying.",
            { retryable: true },
          );
        }
        outboxEventId = reactivated.id;
        changed = true;
      } else {
        const [created] = await tx
          .insert(outboxEvents)
          .values({
            type: "message.send",
            payload: { messageId },
            createdAt: now,
          })
          .returning({ id: outboxEvents.id });
        if (!created) {
          throw new TeamMutationFailure(
            "internal",
            "The send request could not be queued.",
            { retryable: true },
          );
        }
        outboxEventId = created.id;
        changed = true;
      }

      if (changed) {
        const [updated] = await tx
          .update(conversationMessages)
          .set({
            deliveryStatus: "queued",
            provider: null,
            providerMessageId: null,
            sentAt: null,
            metadata: clearDraftFlag(message.metadata),
          })
          .where(
            and(
              eq(conversationMessages.id, messageId),
              eq(conversationMessages.deliveryStatus, message.deliveryStatus),
            ),
          )
          .returning({ id: conversationMessages.id });
        if (!updated) {
          throw new TeamMutationFailure(
            "conflict",
            "The message changed while it was being queued. Refresh the thread before retrying.",
            { retryable: true },
          );
        }
        await tx.insert(messageDeliveryEvents).values({
          messageId,
          status: "queued",
          detail: isDraft(message.metadata)
            ? "manual_draft_send"
            : "manual_retry",
          provider: null,
          occurredAt: now,
        });

        if (message.contactId) {
          await completeNextFollowupTaskOnTouch({
            db: tx,
            contactId: message.contactId,
            memberId: message.salespersonMemberId ?? mutation.actor.id,
            now,
          });
        }
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "conversation_message",
        entityId: messageId,
        before: {
          deliveryStatus: message.deliveryStatus,
          draft: isDraft(message.metadata),
        },
        after: {
          deliveryStatus: "queued",
          draft: false,
          outboxState: "requested",
        },
        metadata: {
          threadId: message.threadId,
          outboxEventId,
          priorDispatchId: latestDispatch?.id ?? null,
          changed,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult<MessageRetryData>(
        mutation,
        {
          messageId,
          threadId: message.threadId,
          outboxEventId,
          state: "requested",
          changed,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "conversation_message",
          entityId: messageId,
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
    if (claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[message-retry] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
