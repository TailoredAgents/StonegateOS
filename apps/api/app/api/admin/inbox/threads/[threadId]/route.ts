import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  conversationThreads,
  conversationMessages,
  conversationParticipants,
  contacts,
  properties,
  teamMembers,
  messageDeliveryEvents
} from "@/db";
import { isAdminRequest } from "../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const THREAD_STATUS = ["open", "pending", "closed"] as const;

type ThreadStatus = (typeof THREAD_STATUS)[number];

function isStatus(value: string | null): value is ThreadStatus {
  return value ? (THREAD_STATUS as readonly string[]).includes(value) : false;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { threadId } = await context.params;
  if (!threadId) {
    return NextResponse.json({ error: "thread_id_required" }, { status: 400 });
  }

  const db = getDb();
  const [threadRow] = await db
    .select({
      id: conversationThreads.id,
      status: conversationThreads.status,
      channel: conversationThreads.channel,
      subject: conversationThreads.subject,
      lastMessagePreview: conversationThreads.lastMessagePreview,
      lastMessageAt: conversationThreads.lastMessageAt,
      updatedAt: conversationThreads.updatedAt,
      createdAt: conversationThreads.createdAt,
      contactId: conversationThreads.contactId,
      leadId: conversationThreads.leadId,
      propertyId: conversationThreads.propertyId,
      assignedTo: conversationThreads.assignedTo,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
      assignedName: teamMembers.name
    })
    .from(conversationThreads)
    .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
    .leftJoin(properties, eq(conversationThreads.propertyId, properties.id))
    .leftJoin(teamMembers, eq(conversationThreads.assignedTo, teamMembers.id))
    .where(eq(conversationThreads.id, threadId))
    .limit(1);

  if (!threadRow) {
    return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  }

  const participantRows = await db
    .select({
      id: conversationParticipants.id,
      participantType: conversationParticipants.participantType,
      contactId: conversationParticipants.contactId,
      teamMemberId: conversationParticipants.teamMemberId,
      displayName: conversationParticipants.displayName,
      externalAddress: conversationParticipants.externalAddress,
      createdAt: conversationParticipants.createdAt,
      teamMemberName: teamMembers.name,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164
    })
    .from(conversationParticipants)
    .leftJoin(teamMembers, eq(conversationParticipants.teamMemberId, teamMembers.id))
    .leftJoin(contacts, eq(conversationParticipants.contactId, contacts.id))
    .where(eq(conversationParticipants.threadId, threadId));

  const participants = participantRows.map((row) => ({
    id: row.id,
    type: row.participantType,
    displayName: row.displayName ?? row.teamMemberName ?? null,
    externalAddress: row.externalAddress ?? null,
    contact: row.contactId
      ? {
          id: row.contactId,
          name: [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ").trim() || "Contact",
          email: row.contactEmail ?? null,
          phone: row.contactPhoneE164 ?? row.contactPhone ?? null
        }
      : null,
    teamMember: row.teamMemberId
      ? {
          id: row.teamMemberId,
          name: row.teamMemberName ?? "Team"
        }
      : null,
    createdAt: row.createdAt.toISOString()
  }));

  const messageRows = await db
    .select({
      id: conversationMessages.id,
      threadId: conversationMessages.threadId,
      participantId: conversationMessages.participantId,
      direction: conversationMessages.direction,
      channel: conversationMessages.channel,
      subject: conversationMessages.subject,
      body: conversationMessages.body,
      mediaUrls: conversationMessages.mediaUrls,
      toAddress: conversationMessages.toAddress,
      fromAddress: conversationMessages.fromAddress,
      deliveryStatus: conversationMessages.deliveryStatus,
      provider: conversationMessages.provider,
      providerMessageId: conversationMessages.providerMessageId,
      sentAt: conversationMessages.sentAt,
      receivedAt: conversationMessages.receivedAt,
      createdAt: conversationMessages.createdAt,
      participantType: conversationParticipants.participantType,
      participantName: conversationParticipants.displayName,
      participantTeamName: teamMembers.name,
      participantContactFirstName: contacts.firstName,
      participantContactLastName: contacts.lastName
    })
    .from(conversationMessages)
    .leftJoin(conversationParticipants, eq(conversationMessages.participantId, conversationParticipants.id))
    .leftJoin(teamMembers, eq(conversationParticipants.teamMemberId, teamMembers.id))
    .leftJoin(contacts, eq(conversationParticipants.contactId, contacts.id))
    .where(eq(conversationMessages.threadId, threadId))
    .orderBy(asc(conversationMessages.createdAt));

  const messageIds = messageRows.map((row) => row.id);
  const deliveryRows =
    messageIds.length > 0
      ? await db
          .select({
            id: messageDeliveryEvents.id,
            messageId: messageDeliveryEvents.messageId,
            status: messageDeliveryEvents.status,
            detail: messageDeliveryEvents.detail,
            provider: messageDeliveryEvents.provider,
            occurredAt: messageDeliveryEvents.occurredAt
          })
          .from(messageDeliveryEvents)
          .where(inArray(messageDeliveryEvents.messageId, messageIds))
          .orderBy(asc(messageDeliveryEvents.occurredAt))
      : [];

  const deliveryMap = new Map<string, typeof deliveryRows>();
  for (const event of deliveryRows) {
    if (!deliveryMap.has(event.messageId)) {
      deliveryMap.set(event.messageId, []);
    }
    deliveryMap.get(event.messageId)!.push(event);
  }

  const messages = messageRows.map((row) => {
    const participantName =
      row.participantName ??
      row.participantTeamName ??
      [row.participantContactFirstName, row.participantContactLastName].filter(Boolean).join(" ").trim();
    return {
      id: row.id,
      threadId: row.threadId,
      participantId: row.participantId ?? null,
      participantType: row.participantType ?? null,
      participantName: participantName || null,
      direction: row.direction,
      channel: row.channel,
      subject: row.subject ?? null,
      body: row.body,
      mediaUrls: row.mediaUrls ?? [],
      toAddress: row.toAddress ?? null,
      fromAddress: row.fromAddress ?? null,
      deliveryStatus: row.deliveryStatus,
      provider: row.provider ?? null,
      providerMessageId: row.providerMessageId ?? null,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      receivedAt: row.receivedAt ? row.receivedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      deliveryEvents:
        deliveryMap.get(row.id)?.map((event) => ({
          id: event.id,
          status: event.status,
          detail: event.detail ?? null,
          provider: event.provider ?? null,
          occurredAt: event.occurredAt.toISOString()
        })) ?? []
    };
  });

  const contactName = [threadRow.contactFirstName, threadRow.contactLastName].filter(Boolean).join(" ").trim();

  return NextResponse.json({
    thread: {
      id: threadRow.id,
      status: threadRow.status,
      channel: threadRow.channel,
      subject: threadRow.subject ?? null,
      lastMessagePreview: threadRow.lastMessagePreview ?? null,
      lastMessageAt: threadRow.lastMessageAt ? threadRow.lastMessageAt.toISOString() : null,
      updatedAt: threadRow.updatedAt ? threadRow.updatedAt.toISOString() : null,
      createdAt: threadRow.createdAt.toISOString(),
      contact: threadRow.contactId
        ? {
            id: threadRow.contactId,
            name: contactName || "Contact",
            email: threadRow.contactEmail ?? null,
            phone: threadRow.contactPhoneE164 ?? threadRow.contactPhone ?? null
          }
        : null,
      property: threadRow.propertyId
        ? {
            id: threadRow.propertyId,
            addressLine1: threadRow.propertyAddressLine1 ?? "",
            city: threadRow.propertyCity ?? "",
            state: threadRow.propertyState ?? "",
            postalCode: threadRow.propertyPostalCode ?? ""
          }
        : null,
      leadId: threadRow.leadId ?? null,
      assignedTo: threadRow.assignedTo
        ? { id: threadRow.assignedTo, name: threadRow.assignedName ?? "Assigned" }
        : null
    },
    participants,
    messages
  });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { threadId } = await context.params;
  if (!threadId) {
    return NextResponse.json({ error: "thread_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as {
    status?: string;
    assignedTo?: string | null;
    subject?: string | null;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (typeof payload.status === "string" && isStatus(payload.status)) {
    updates["status"] = payload.status;
  }
  if (typeof payload.assignedTo === "string") {
    updates["assignedTo"] = payload.assignedTo.trim().length > 0 ? payload.assignedTo.trim() : null;
  } else if (payload.assignedTo === null) {
    updates["assignedTo"] = null;
  }
  if (typeof payload.subject === "string") {
    updates["subject"] = payload.subject.trim().length > 0 ? payload.subject.trim() : null;
  } else if (payload.subject === null) {
    updates["subject"] = null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no_updates" }, { status: 400 });
  }

  updates["updatedAt"] = new Date();

  const db = getDb();
  const [thread] = await db
    .update(conversationThreads)
    .set(updates)
    .where(eq(conversationThreads.id, threadId))
    .returning();

  if (!thread) {
    return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "thread.updated",
    entityType: "conversation_thread",
    entityId: threadId,
    meta: { updates }
  });

  return NextResponse.json({ ok: true });
}
