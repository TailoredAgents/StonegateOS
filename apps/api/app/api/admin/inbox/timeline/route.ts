import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { contacts, conversationMessages, conversationParticipants, conversationThreads, getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

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
  const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 200, 1), 500) : 200;

  const db = getDb();
  const [contactRow] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contactRow?.id) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const threads = await db
    .select({
      id: conversationThreads.id,
      status: conversationThreads.status,
      state: conversationThreads.state,
      channel: conversationThreads.channel,
      subject: conversationThreads.subject,
      lastMessageAt: conversationThreads.lastMessageAt,
      stateUpdatedAt: conversationThreads.stateUpdatedAt,
      lastInboundAt: sql<Date | null>`(
        select max(coalesce(cm.received_at, cm.created_at))
        from conversation_messages cm
        where cm.thread_id = ${conversationThreads.id} and cm.direction = 'inbound'
      )`
    })
    .from(conversationThreads)
    .where(eq(conversationThreads.contactId, contactId))
    .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt));

  const messageRows = await db
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
      metadata: conversationMessages.metadata
    })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      and(eq(conversationMessages.threadId, conversationThreads.id), eq(conversationThreads.contactId, contactId))
    )
    .leftJoin(conversationParticipants, eq(conversationMessages.participantId, conversationParticipants.id))
    .orderBy(
      desc(sql`coalesce(${conversationMessages.receivedAt}, ${conversationMessages.sentAt}, ${conversationMessages.createdAt})`)
    )
    .limit(limit);

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
    createdAt: row.createdAt.toISOString(),
    sentAt: toIso(row.sentAt),
    receivedAt: toIso(row.receivedAt),
    metadata: row.metadata ?? null
  }));

  const displayName = [contactRow.firstName, contactRow.lastName].filter(Boolean).join(" ").trim() || "Unknown contact";

  return NextResponse.json({
    ok: true,
    contact: {
      id: contactRow.id,
      name: displayName,
      email: contactRow.email,
      phone: contactRow.phone ?? contactRow.phoneE164
    },
    threads: threads.map((thread) => ({
      id: thread.id,
      status: thread.status,
      state: thread.state,
      channel: thread.channel,
      subject: thread.subject,
      lastMessageAt: toIso(thread.lastMessageAt),
      lastInboundAt: toIso(thread.lastInboundAt),
      stateUpdatedAt: toIso(thread.stateUpdatedAt)
    })),
    messages: orderedMessages
  });
}

