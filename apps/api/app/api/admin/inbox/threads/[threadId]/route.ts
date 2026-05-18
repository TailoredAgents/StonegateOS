import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  conversationThreads,
  conversationMessages,
  conversationParticipants,
  contacts,
  crmPipeline,
  leadAutomationStates,
  properties,
  teamMembers,
  messageDeliveryEvents
} from "@/db";
import {
  canTransitionConversationState,
  isConversationState,
  type ConversationState
} from "@/lib/conversation-state";
import { getServiceAreaPolicy, isPostalCodeAllowed, normalizePostalCode } from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const THREAD_STATUS = ["open", "pending", "closed"] as const;
const CLOSE_REASONS = ["lost", "do_not_contact", "closed"] as const;

type ThreadStatus = (typeof THREAD_STATUS)[number];
type ThreadState = ConversationState;
type CloseReason = (typeof CLOSE_REASONS)[number];

function isStatus(value: string | null): value is ThreadStatus {
  return value ? (THREAD_STATUS as readonly string[]).includes(value) : false;
}

function isCloseReason(value: string | null): value is CloseReason {
  return value ? (CLOSE_REASONS as readonly string[]).includes(value) : false;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> }
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.read");
  if (permissionError) return permissionError;

  const { threadId } = await context.params;
  if (!threadId) {
    return NextResponse.json({ error: "thread_id_required" }, { status: 400 });
  }

  const db = getDb();
  const [threadRow] = await db
    .select({
      id: conversationThreads.id,
      status: conversationThreads.status,
      state: conversationThreads.state,
      channel: conversationThreads.channel,
      subject: conversationThreads.subject,
      lastMessagePreview: conversationThreads.lastMessagePreview,
      lastMessageAt: conversationThreads.lastMessageAt,
      updatedAt: conversationThreads.updatedAt,
      createdAt: conversationThreads.createdAt,
      stateUpdatedAt: conversationThreads.stateUpdatedAt,
      attentionHandledAt: conversationThreads.attentionHandledAt,
      closedReason: conversationThreads.closedReason,
      closedAt: conversationThreads.closedAt,
      contactId: conversationThreads.contactId,
      leadId: conversationThreads.leadId,
      propertyId: conversationThreads.propertyId,
      assignedTo: conversationThreads.assignedTo,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      doNotContact: contacts.doNotContact,
      doNotContactReason: contacts.doNotContactReason,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
      assignedName: teamMembers.name,
      lastInboundAt: sql<Date | null>`(
        select max(coalesce(cm.received_at, cm.created_at))
        from conversation_messages cm
        where cm.thread_id = ${conversationThreads.id} and cm.direction = 'inbound'
      )`
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

  const serviceArea = await getServiceAreaPolicy(db);
  const normalizedPostalCode = normalizePostalCode(threadRow.propertyPostalCode ?? null);
  const outOfArea =
    normalizedPostalCode !== null ? !isPostalCodeAllowed(normalizedPostalCode, serviceArea) : null;

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
      metadata: conversationMessages.metadata,
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
      metadata: row.metadata ?? null,
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
  const rawLastInbound = threadRow.lastInboundAt as unknown;
  const lastInboundIso =
    rawLastInbound instanceof Date
      ? rawLastInbound.toISOString()
      : typeof rawLastInbound === "string"
        ? rawLastInbound
        : null;

  return NextResponse.json({
    thread: {
      id: threadRow.id,
      status: threadRow.status,
      state: threadRow.state,
      channel: threadRow.channel,
      subject: threadRow.subject ?? null,
      lastMessagePreview: threadRow.lastMessagePreview ?? null,
      lastMessageAt: threadRow.lastMessageAt ? threadRow.lastMessageAt.toISOString() : null,
      updatedAt: threadRow.updatedAt ? threadRow.updatedAt.toISOString() : null,
      createdAt: threadRow.createdAt.toISOString(),
      lastInboundAt: lastInboundIso,
      stateUpdatedAt: threadRow.stateUpdatedAt ? threadRow.stateUpdatedAt.toISOString() : null,
      attentionHandledAt: threadRow.attentionHandledAt ? threadRow.attentionHandledAt.toISOString() : null,
      closedReason: threadRow.closedReason ?? null,
      closedAt: threadRow.closedAt ? threadRow.closedAt.toISOString() : null,
      doNotContact: threadRow.doNotContact === true,
      doNotContactReason: threadRow.doNotContactReason ?? null,
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
            postalCode: threadRow.propertyPostalCode ?? "",
            outOfArea
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
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const { threadId } = await context.params;
  if (!threadId) {
    return NextResponse.json({ error: "thread_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as {
    action?: string;
    status?: string;
    assignedTo?: string | null;
    subject?: string | null;
    state?: string;
    allowBackward?: boolean;
    closeReason?: string;
    doNotContact?: boolean;
    doNotContactReason?: string | null;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);
  const now = new Date();
  const [existingThread] = await db
    .select({
      state: conversationThreads.state,
      contactId: conversationThreads.contactId,
      leadId: conversationThreads.leadId
    })
    .from(conversationThreads)
    .where(eq(conversationThreads.id, threadId))
    .limit(1);

  if (!existingThread) {
    return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};
  if (payload.action === "mark_handled") {
    updates["attentionHandledAt"] = now;
    updates["attentionHandledBy"] = actor.id ?? null;
  }
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

  let currentState: ThreadState | null = null;
  if (typeof payload.state === "string") {
    if (!isConversationState(payload.state)) {
      return NextResponse.json({ error: "invalid_state" }, { status: 400 });
    }

    currentState = existingThread.state;
    const nextState = payload.state;
    const allowBackward = payload.allowBackward === true;

    if (!canTransitionConversationState(currentState, nextState, { allowBackward })) {
      return NextResponse.json({ error: "invalid_state_transition" }, { status: 400 });
    }

    if (nextState !== currentState) {
      updates["state"] = nextState;
      updates["stateUpdatedAt"] = now;
    }
  }

  const requestedCloseReason = isCloseReason(payload.closeReason ?? null)
    ? (payload.closeReason as CloseReason)
    : payload.doNotContact === true
      ? "do_not_contact"
      : payload.status === "closed"
        ? "closed"
        : null;
  if (requestedCloseReason) {
    updates["status"] = "closed";
    updates["closedReason"] = requestedCloseReason;
    updates["closedAt"] = now;
    updates["closedBy"] = actor.id ?? null;
    updates["attentionHandledAt"] = now;
    updates["attentionHandledBy"] = actor.id ?? null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no_updates" }, { status: 400 });
  }

  updates["updatedAt"] = now;

  const thread = await db.transaction(async (tx) => {
    const [updatedThread] = await tx
      .update(conversationThreads)
      .set(updates)
      .where(eq(conversationThreads.id, threadId))
      .returning();

    if (!updatedThread) return null;

    if (requestedCloseReason === "lost" && existingThread.contactId) {
      await tx
        .insert(crmPipeline)
        .values({
          contactId: existingThread.contactId,
          stage: "lost",
          notes: "Closed from mobile inbox as lost.",
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: crmPipeline.contactId,
          set: {
            stage: "lost",
            notes: "Closed from mobile inbox as lost.",
            updatedAt: now
          }
        });
    }

    if (requestedCloseReason === "do_not_contact" && existingThread.contactId) {
      await tx
        .update(contacts)
        .set({
          doNotContact: true,
          doNotContactAt: now,
          doNotContactBy: actor.id ?? null,
          doNotContactReason:
            typeof payload.doNotContactReason === "string" && payload.doNotContactReason.trim().length > 0
              ? payload.doNotContactReason.trim()
              : "Marked Do Not Contact from mobile inbox.",
          updatedAt: now
        })
        .where(eq(contacts.id, existingThread.contactId));
    }

    if (requestedCloseReason === "do_not_contact" && existingThread.leadId) {
      await tx
        .update(leadAutomationStates)
        .set({
          paused: true,
          dnc: true,
          followupState: "stopped",
          nextFollowupAt: null,
          pausedAt: now,
          pausedBy: actor.id ?? null,
          updatedAt: now
        })
        .where(eq(leadAutomationStates.leadId, existingThread.leadId));
    }

    return updatedThread;
  });

  if (!thread) {
    return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  }

  await recordAuditEvent({
    actor,
    action: "thread.updated",
    entityType: "conversation_thread",
    entityId: threadId,
    meta: { updates, previousState: currentState, closeReason: requestedCloseReason }
  });

  return NextResponse.json({ ok: true });
}
