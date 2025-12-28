import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  conversationMessages,
  conversationThreads,
  contacts,
  getDb,
  messageDeliveryEvents
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.read");
  if (permissionError) return permissionError;

  const { searchParams } = request.nextUrl;
  const limit = parseLimit(searchParams.get("limit"));
  const offset = parseOffset(searchParams.get("offset"));

  const db = getDb();
  const [totalRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.deliveryStatus, "failed"),
        eq(conversationMessages.direction, "outbound")
      )
    );

  const total = Number(totalRow?.count ?? 0);

  const rows = await db
    .select({
      id: conversationMessages.id,
      threadId: conversationMessages.threadId,
      channel: conversationMessages.channel,
      body: conversationMessages.body,
      provider: conversationMessages.provider,
      toAddress: conversationMessages.toAddress,
      createdAt: conversationMessages.createdAt,
      sentAt: conversationMessages.sentAt,
      contactId: conversationThreads.contactId,
      threadSubject: conversationThreads.subject,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName
    })
    .from(conversationMessages)
    .leftJoin(conversationThreads, eq(conversationMessages.threadId, conversationThreads.id))
    .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
    .where(
      and(
        eq(conversationMessages.deliveryStatus, "failed"),
        eq(conversationMessages.direction, "outbound")
      )
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(limit)
    .offset(offset);

  const messageIds = rows.map((row) => row.id);
  const failureEvents =
    messageIds.length > 0
      ? await db
          .select({
            messageId: messageDeliveryEvents.messageId,
            detail: messageDeliveryEvents.detail,
            occurredAt: messageDeliveryEvents.occurredAt
          })
          .from(messageDeliveryEvents)
          .where(
            and(
              inArray(messageDeliveryEvents.messageId, messageIds),
              eq(messageDeliveryEvents.status, "failed")
            )
          )
          .orderBy(desc(messageDeliveryEvents.occurredAt))
      : [];

  const failureMap = new Map<string, { detail: string | null; occurredAt: Date }>();
  for (const event of failureEvents) {
    if (!failureMap.has(event.messageId)) {
      failureMap.set(event.messageId, { detail: event.detail ?? null, occurredAt: event.occurredAt });
    }
  }

  const messages = rows.map((row) => {
    const contactName = [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ").trim();
    const failure = failureMap.get(row.id);
    return {
      id: row.id,
      threadId: row.threadId,
      channel: row.channel,
      body: row.body,
      provider: row.provider ?? null,
      toAddress: row.toAddress ?? null,
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      failedAt: failure?.occurredAt ? failure.occurredAt.toISOString() : null,
      failureDetail: failure?.detail ?? null,
      threadSubject: row.threadSubject ?? null,
      contact: row.contactId
        ? {
            id: row.contactId,
            name: contactName || "Contact"
          }
        : null
    };
  });

  const nextOffset = offset + messages.length;

  return NextResponse.json({
    messages,
    pagination: {
      limit,
      offset,
      total,
      nextOffset: nextOffset < total ? nextOffset : null
    }
  });
}
