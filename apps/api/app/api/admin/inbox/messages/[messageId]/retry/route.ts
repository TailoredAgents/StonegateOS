import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { conversationMessages, getDb, messageDeliveryEvents, outboxEvents } from "@/db";
import { isAdminRequest } from "../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ messageId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
      threadId: conversationMessages.threadId
    })
    .from(conversationMessages)
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
        sentAt: null
      })
      .where(eq(conversationMessages.id, messageId));

    await tx.insert(messageDeliveryEvents).values({
      messageId,
      status: "queued",
      detail: "manual_retry",
      provider: null,
      occurredAt: now
    });
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
