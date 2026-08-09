import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb,
} from "@/db";
import { buildInboxSnapshotSignature } from "@/lib/inbox-snapshot";
import { toInboxIso } from "@/lib/inbox-timestamp";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.read");
  if (permissionError) return permissionError;

  const { searchParams } = request.nextUrl;
  const contactId = (searchParams.get("contactId") ?? "").trim();
  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const limitRaw = searchParams.get("limit");
  const limit = limitRaw
    ? Math.min(Math.max(Number(limitRaw) || 200, 1), 500)
    : 200;
  const snapshotOnly = searchParams.get("snapshot") === "1";

  const db = getDb();
  const [contactRow] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contactRow?.id) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const messageActivityAt = sql<Date | string>`coalesce(
    ${conversationMessages.receivedAt},
    ${conversationMessages.sentAt},
    ${conversationMessages.createdAt}
  )`;
  const snapshotAggregatePromise = db
    .select({
      messageCount: sql<number>`count(*)::int`,
      queuedCount: sql<number>`(count(*) filter (where ${conversationMessages.deliveryStatus} = 'queued'))::int`,
      sentCount: sql<number>`(count(*) filter (where ${conversationMessages.deliveryStatus} = 'sent'))::int`,
      deliveredCount: sql<number>`(count(*) filter (where ${conversationMessages.deliveryStatus} = 'delivered'))::int`,
      failedCount: sql<number>`(count(*) filter (where ${conversationMessages.deliveryStatus} = 'failed'))::int`,
    })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      and(
        eq(conversationMessages.threadId, conversationThreads.id),
        eq(conversationThreads.contactId, contactId),
      ),
    );
  const latestMessagePromise = db
    .select({
      id: conversationMessages.id,
      activityAt: messageActivityAt,
    })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      and(
        eq(conversationMessages.threadId, conversationThreads.id),
        eq(conversationThreads.contactId, contactId),
      ),
    )
    .orderBy(desc(messageActivityAt), desc(conversationMessages.id))
    .limit(1);

  const createSnapshot = (
    aggregate:
      | {
          messageCount: number;
          queuedCount: number;
          sentCount: number;
          deliveredCount: number;
          failedCount: number;
        }
      | undefined,
    latestMessage: { id: string; activityAt: Date | string } | null,
  ) => {
    const snapshotRevision = {
      contactId,
      messageCount: Number(aggregate?.messageCount ?? 0),
      deliveryCounts: {
        queued: Number(aggregate?.queuedCount ?? 0),
        sent: Number(aggregate?.sentCount ?? 0),
        delivered: Number(aggregate?.deliveredCount ?? 0),
        failed: Number(aggregate?.failedCount ?? 0),
      },
      lastMessageId: latestMessage?.id ?? null,
      lastMessageAt: toInboxIso(latestMessage?.activityAt),
    };
    return {
      ...snapshotRevision,
      signature: buildInboxSnapshotSignature(snapshotRevision),
    };
  };

  if (snapshotOnly) {
    const [snapshotAggregateRows, latestMessageRows] = await Promise.all([
      snapshotAggregatePromise,
      latestMessagePromise,
    ]);
    return NextResponse.json({
      ok: true,
      snapshot: createSnapshot(
        snapshotAggregateRows[0],
        latestMessageRows[0] ?? null,
      ),
    });
  }

  const threadsPromise = db
    .select({
      id: conversationThreads.id,
      status: conversationThreads.status,
      state: conversationThreads.state,
      channel: conversationThreads.channel,
      subject: conversationThreads.subject,
      lastMessageAt: conversationThreads.lastMessageAt,
      stateUpdatedAt: conversationThreads.stateUpdatedAt,
      lastInboundAt: sql<Date | string | null>`(
        select max(coalesce(cm.received_at, cm.created_at))
        from conversation_messages cm
        where cm.thread_id = ${conversationThreads.id} and cm.direction = 'inbound'
      )`,
    })
    .from(conversationThreads)
    .where(eq(conversationThreads.contactId, contactId))
    .orderBy(
      desc(conversationThreads.lastMessageAt),
      desc(conversationThreads.updatedAt),
    );

  const messageRowsPromise = db
    .select({
      id: conversationMessages.id,
      threadId: conversationMessages.threadId,
      direction: conversationMessages.direction,
      channel: conversationMessages.channel,
      subject: conversationMessages.subject,
      body: conversationMessages.body,
      mediaUrls: conversationMessages.mediaUrls,
      deliveryStatus: conversationMessages.deliveryStatus,
      participantName: conversationParticipants.displayName,
      createdAt: conversationMessages.createdAt,
      sentAt: conversationMessages.sentAt,
      receivedAt: conversationMessages.receivedAt,
      metadata: conversationMessages.metadata,
    })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      and(
        eq(conversationMessages.threadId, conversationThreads.id),
        eq(conversationThreads.contactId, contactId),
      ),
    )
    .leftJoin(
      conversationParticipants,
      eq(conversationMessages.participantId, conversationParticipants.id),
    )
    .orderBy(desc(messageActivityAt))
    .limit(limit);

  const [snapshotAggregateRows, latestMessageRows, threads, messageRows] =
    await Promise.all([
      snapshotAggregatePromise,
      latestMessagePromise,
      threadsPromise,
      messageRowsPromise,
    ]);
  const snapshot = createSnapshot(
    snapshotAggregateRows[0],
    latestMessageRows[0] ?? null,
  );

  const orderedMessages = [...messageRows].reverse().map((row) => ({
    id: row.id,
    threadId: row.threadId,
    direction: row.direction,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    mediaUrls: row.mediaUrls ?? [],
    deliveryStatus: row.deliveryStatus,
    participantName: row.participantName ?? null,
    createdAt: toInboxIso(row.createdAt),
    sentAt: toInboxIso(row.sentAt),
    receivedAt: toInboxIso(row.receivedAt),
    metadata: row.metadata ?? null,
  }));

  const displayName =
    [contactRow.firstName, contactRow.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || "Unknown contact";

  return NextResponse.json({
    ok: true,
    snapshot,
    contact: {
      id: contactRow.id,
      name: displayName,
      email: contactRow.email,
      phone: contactRow.phone ?? contactRow.phoneE164,
    },
    threads: threads.map((thread) => ({
      id: thread.id,
      status: thread.status,
      state: thread.state,
      channel: thread.channel,
      subject: thread.subject,
      lastMessageAt: toInboxIso(thread.lastMessageAt),
      lastInboundAt: toInboxIso(thread.lastInboundAt),
      stateUpdatedAt: toInboxIso(thread.stateUpdatedAt),
    })),
    messages: orderedMessages,
  });
}
