import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { contacts, conversationMessages, conversationThreads, getDb, messageDeliveryEvents, outboxEvents } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { completeNextFollowupTaskOnTouch } from "@/lib/sales-followups";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  context: { params: Promise<{ messageId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const { messageId } = await context.params;
  if (!messageId) {
    return NextResponse.json({ error: "message_id_required" }, { status: 400 });
  }

  const db = getDb();
  const [message] = await db
    .select({
      id: conversationMessages.id,
      deliveryStatus: conversationMessages.deliveryStatus,
      direction: conversationMessages.direction,
      threadId: conversationMessages.threadId,
      metadata: conversationMessages.metadata,
      contactId: conversationThreads.contactId,
      salespersonMemberId: contacts.salespersonMemberId
    })
    .from(conversationMessages)
    .leftJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
    .where(eq(conversationMessages.id, messageId))
    .limit(1);

  if (!message) {
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }

  if (message.direction !== "outbound") {
    return NextResponse.json({ error: "message_not_outbound" }, { status: 400 });
  }

  if (message.deliveryStatus !== "failed" && message.deliveryStatus !== "queued") {
    return NextResponse.json({ error: "message_not_retryable" }, { status: 400 });
  }

  const now = new Date();

  const [pendingEvent] = await db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, "message.send"),
        isNull(outboxEvents.processedAt),
        sql`payload->>'messageId' = ${messageId}`
      )
    )
    .limit(1);

  await db.transaction(async (tx) => {
    if (pendingEvent?.id) {
      await tx
        .update(outboxEvents)
        .set({
          attempts: 0,
          nextAttemptAt: now,
          lastError: null
        })
        .where(eq(outboxEvents.id, pendingEvent.id));
    } else {
      await tx.insert(outboxEvents).values({
        type: "message.send",
        payload: { messageId },
        createdAt: now
      });
    }

    await tx
      .update(conversationMessages)
      .set({
        deliveryStatus: "queued",
        provider: null,
        providerMessageId: null,
        sentAt: null,
        metadata: clearDraftFlag(message.metadata)
      })
      .where(eq(conversationMessages.id, messageId));

    await tx.insert(messageDeliveryEvents).values({
      messageId,
      status: "queued",
      detail: "manual_retry",
      provider: null,
      occurredAt: now
    });

    if (message.contactId) {
      const actor = getAuditActorFromRequest(request);
      await completeNextFollowupTaskOnTouch({
        db: tx,
        contactId: message.contactId,
        memberId: message.salespersonMemberId ?? actor.id ?? null,
        now
      });
    }
  });

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "message.retry",
    entityType: "conversation_message",
    entityId: messageId,
    meta: { threadId: message.threadId }
  });

  return NextResponse.json({ ok: true });
}
