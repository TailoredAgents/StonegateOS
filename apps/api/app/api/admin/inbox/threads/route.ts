import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  getDb,
  conversationThreads,
  conversationMessages,
  conversationParticipants,
  contacts,
  properties,
  teamMembers,
  leadAutomationStates,
  leads,
  outboxEvents
} from "@/db";
import { isConversationState, type ConversationState } from "@/lib/conversation-state";
import { getServiceAreaPolicy, isPostalCodeAllowed, normalizePostalCode } from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const THREAD_STATUS = ["open", "pending", "closed"] as const;
const CHANNELS = ["sms", "email", "dm", "call", "web"] as const;

type ThreadStatus = (typeof THREAD_STATUS)[number];
type Channel = (typeof CHANNELS)[number];
type ThreadState = ConversationState;

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

function normalizeSearch(term: string): string {
  return term.replace(/[%_]/g, "\\$&").replace(/\s+/g, " ").trim();
}

function isStatus(value: string | null): value is ThreadStatus {
  return value ? (THREAD_STATUS as readonly string[]).includes(value) : false;
}

function isChannel(value: string | null): value is Channel {
  return value ? (CHANNELS as readonly string[]).includes(value) : false;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.read");
  if (permissionError) return permissionError;

  const { searchParams } = request.nextUrl;
  const rawSearch = searchParams.get("q");
  const searchTerm = rawSearch ? normalizeSearch(rawSearch) : null;
  const status = isStatus(searchParams.get("status")) ? (searchParams.get("status") as ThreadStatus) : null;
  const channel = isChannel(searchParams.get("channel")) ? (searchParams.get("channel") as Channel) : null;
  const limit = parseLimit(searchParams.get("limit"));
  const offset = parseOffset(searchParams.get("offset"));

  const filters = [];

  if (status) {
    filters.push(eq(conversationThreads.status, status));
  }
  if (channel) {
    filters.push(eq(conversationThreads.channel, channel));
  }
  if (searchTerm) {
    const likePattern = `%${searchTerm.replace(/\s+/g, "%")}%`;
    filters.push(
      or(
        ilike(contacts.firstName, likePattern),
        ilike(contacts.lastName, likePattern),
        ilike(contacts.email, likePattern),
        ilike(contacts.phone, likePattern),
        ilike(conversationThreads.subject, likePattern),
        ilike(conversationThreads.lastMessagePreview, likePattern)
      )
    );
  }

  const whereClause = filters.length ? and(...filters) : undefined;

  const db = getDb();
  const totalResult = whereClause
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(conversationThreads)
        .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
        .where(whereClause)
    : await db.select({ count: sql<number>`count(*)` }).from(conversationThreads);
  const total = Number(totalResult[0]?.count ?? 0);

  const rows = await (whereClause
    ? db
        .select({
          id: conversationThreads.id,
          status: conversationThreads.status,
          state: conversationThreads.state,
          channel: conversationThreads.channel,
          subject: conversationThreads.subject,
          lastMessagePreview: conversationThreads.lastMessagePreview,
          lastMessageAt: conversationThreads.lastMessageAt,
          updatedAt: conversationThreads.updatedAt,
          stateUpdatedAt: conversationThreads.stateUpdatedAt,
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
          assignedName: teamMembers.name,
          followupState: leadAutomationStates.followupState,
          followupStep: leadAutomationStates.followupStep,
          nextFollowupAt: leadAutomationStates.nextFollowupAt
        })
        .from(conversationThreads)
        .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
        .leftJoin(properties, eq(conversationThreads.propertyId, properties.id))
        .leftJoin(
          leadAutomationStates,
          and(
            eq(leadAutomationStates.leadId, conversationThreads.leadId),
            sql`${leadAutomationStates.channel}::text = ${conversationThreads.channel}::text`
          )
        )
        .leftJoin(teamMembers, eq(conversationThreads.assignedTo, teamMembers.id))
        .where(whereClause)
    : db
        .select({
          id: conversationThreads.id,
          status: conversationThreads.status,
          state: conversationThreads.state,
          channel: conversationThreads.channel,
          subject: conversationThreads.subject,
          lastMessagePreview: conversationThreads.lastMessagePreview,
          lastMessageAt: conversationThreads.lastMessageAt,
          updatedAt: conversationThreads.updatedAt,
          stateUpdatedAt: conversationThreads.stateUpdatedAt,
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
          assignedName: teamMembers.name,
          followupState: leadAutomationStates.followupState,
          followupStep: leadAutomationStates.followupStep,
          nextFollowupAt: leadAutomationStates.nextFollowupAt
        })
        .from(conversationThreads)
        .leftJoin(contacts, eq(conversationThreads.contactId, contacts.id))
        .leftJoin(properties, eq(conversationThreads.propertyId, properties.id))
        .leftJoin(
          leadAutomationStates,
          and(
            eq(leadAutomationStates.leadId, conversationThreads.leadId),
            sql`${leadAutomationStates.channel}::text = ${conversationThreads.channel}::text`
          )
        )
        .leftJoin(teamMembers, eq(conversationThreads.assignedTo, teamMembers.id)))
    .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
    .limit(limit)
    .offset(offset);

  const serviceArea = await getServiceAreaPolicy(db);

  const threadIds = rows.map((row) => row.id);
  const messageCounts =
    threadIds.length > 0
      ? await db
          .select({
            threadId: conversationMessages.threadId,
            count: sql<number>`count(*)`
          })
          .from(conversationMessages)
          .where(inArray(conversationMessages.threadId, threadIds))
          .groupBy(conversationMessages.threadId)
      : [];

  const messageCountMap = new Map<string, number>();
  for (const row of messageCounts) {
    messageCountMap.set(row.threadId, Number(row.count));
  }

  const threads = rows.map((row) => {
    const contactName = [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ").trim();
    const normalizedPostalCode = normalizePostalCode(row.propertyPostalCode ?? null);
    const outOfArea =
      normalizedPostalCode !== null ? !isPostalCodeAllowed(normalizedPostalCode, serviceArea) : null;
    return {
      id: row.id,
      status: row.status,
      state: row.state,
      channel: row.channel,
      subject: row.subject ?? null,
      lastMessagePreview: row.lastMessagePreview ?? null,
      lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      stateUpdatedAt: row.stateUpdatedAt ? row.stateUpdatedAt.toISOString() : null,
      contact: row.contactId
        ? {
            id: row.contactId,
            name: contactName || "Contact",
            email: row.contactEmail ?? null,
            phone: row.contactPhoneE164 ?? row.contactPhone ?? null
          }
        : null,
      property: row.propertyId
        ? {
            id: row.propertyId,
            addressLine1: row.propertyAddressLine1 ?? "",
            city: row.propertyCity ?? "",
            state: row.propertyState ?? "",
            postalCode: row.propertyPostalCode ?? "",
            outOfArea
          }
        : null,
      leadId: row.leadId ?? null,
      assignedTo: row.assignedTo
        ? {
            id: row.assignedTo,
            name: row.assignedName ?? "Assigned"
          }
        : null,
      messageCount: messageCountMap.get(row.id) ?? 0,
      followup: row.leadId
        ? {
            state: row.followupState ?? null,
            step: typeof row.followupStep === "number" ? row.followupStep : null,
            nextAt: row.nextFollowupAt ? row.nextFollowupAt.toISOString() : null
          }
        : null
    };
  });

  const nextOffset = offset + threads.length;

  return NextResponse.json({
    threads,
    pagination: {
      limit,
      offset,
      total,
      nextOffset: nextOffset < total ? nextOffset : null
    }
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as {
    contactId?: string;
    leadId?: string;
    propertyId?: string;
    status?: string;
    state?: string;
    channel?: string;
    subject?: string;
    message?: string;
    direction?: string;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const status = isStatus(payload.status ?? null) ? (payload.status as ThreadStatus) : "open";
  const channel = isChannel(payload.channel ?? null) ? (payload.channel as Channel) : "sms";
  if (payload.state && !isConversationState(payload.state)) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }
  const state = isConversationState(payload.state ?? null) ? (payload.state as ThreadState) : "new";

  let contactId = typeof payload.contactId === "string" ? payload.contactId.trim() : "";
  let leadId = typeof payload.leadId === "string" ? payload.leadId.trim() : "";
  let propertyId = typeof payload.propertyId === "string" ? payload.propertyId.trim() : "";

  if (!contactId && !leadId) {
    return NextResponse.json({ error: "contact_or_lead_required" }, { status: 400 });
  }

  const subject = typeof payload.subject === "string" && payload.subject.trim().length > 0 ? payload.subject.trim() : null;
  const messageBody = typeof payload.message === "string" ? payload.message.trim() : "";
  const direction =
    payload.direction === "inbound" || payload.direction === "internal" ? payload.direction : "outbound";

  const actor = getAuditActorFromRequest(request);
  const db = getDb();

  let result: {
    thread: typeof conversationThreads.$inferSelect;
    message: typeof conversationMessages.$inferSelect | null;
  };
  try {
    result = await db.transaction(async (tx) => {
      let contactRecord =
        contactId.length > 0
          ? await tx
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
              .limit(1)
              .then((rows) => rows[0])
          : undefined;

      if (!contactRecord && leadId) {
        const [leadRow] = await tx
          .select({
            contactId: leads.contactId,
            propertyId: leads.propertyId
          })
          .from(leads)
          .where(eq(leads.id, leadId))
          .limit(1);
        if (leadRow?.contactId) {
          contactId = leadRow.contactId;
          propertyId = propertyId || leadRow.propertyId || "";
          contactRecord = await tx
            .select({
              id: contacts.id,
              firstName: contacts.firstName,
              lastName: contacts.lastName,
              email: contacts.email,
              phone: contacts.phone,
              phoneE164: contacts.phoneE164
            })
            .from(contacts)
            .where(eq(contacts.id, leadRow.contactId))
            .limit(1)
            .then((rows) => rows[0]);
        }
      }

      if (!contactId) {
        throw new Error("contact_not_found");
      }

      const now = new Date();
      const [thread] = await tx
        .insert(conversationThreads)
        .values({
          leadId: leadId || null,
          contactId,
          propertyId: propertyId || null,
          status,
          state,
          channel,
          subject,
          stateUpdatedAt: now,
          createdAt: now,
          updatedAt: now
        })
        .returning();

      if (!thread) {
        throw new Error("thread_create_failed");
      }

      let contactParticipantId: string | null = null;
      if (contactRecord?.id) {
        const displayName = [contactRecord.firstName, contactRecord.lastName].filter(Boolean).join(" ").trim();
        const externalAddress =
          channel === "email"
            ? contactRecord.email
            : contactRecord.phoneE164 ?? contactRecord.phone ?? null;

        const [participant] = await tx
          .insert(conversationParticipants)
          .values({
            threadId: thread.id,
            participantType: "contact",
            contactId: contactRecord.id,
            externalAddress,
            displayName: displayName || "Contact",
            createdAt: new Date()
          })
          .returning();

        contactParticipantId = participant?.id ?? null;
      }

      let messageRecord: typeof conversationMessages.$inferSelect | null = null;

      if (messageBody.length > 0) {
        let participantId = contactParticipantId;
        if (direction !== "inbound") {
          const [teamParticipant] = await tx
            .insert(conversationParticipants)
            .values({
              threadId: thread.id,
              participantType: "team",
              teamMemberId: actor.id ?? null,
              displayName: actor.label ?? "Team Console",
              createdAt: new Date()
            })
            .returning();
          participantId = teamParticipant?.id ?? null;
        }

        const now = new Date();
        const deliveryStatus =
          direction === "inbound" ? "delivered" : direction === "internal" ? "sent" : "queued";

        const [message] = await tx
          .insert(conversationMessages)
          .values({
            threadId: thread.id,
            participantId,
            direction,
            channel,
            subject,
            body: messageBody,
            deliveryStatus,
            sentAt: deliveryStatus === "sent" ? now : null,
            receivedAt: direction === "inbound" ? now : null,
            createdAt: now
          })
          .returning();

        messageRecord = message ?? null;

        await tx
          .update(conversationThreads)
          .set({
            lastMessagePreview: messageBody.slice(0, 140),
            lastMessageAt: now,
            updatedAt: now
          })
          .where(eq(conversationThreads.id, thread.id));

        if (direction === "outbound") {
          await tx.insert(outboxEvents).values({
            type: "message.send",
            payload: {
              messageId: message?.id ?? null
            },
            createdAt: now
          });
        }
      }

      return { thread, message: messageRecord };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "thread_create_failed";
    const status = message === "contact_not_found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  await recordAuditEvent({
    actor,
    action: "thread.created",
    entityType: "conversation_thread",
    entityId: result.thread.id,
    meta: { channel: result.thread.channel, status: result.thread.status, state: result.thread.state }
  });

  if (result.message) {
    await recordAuditEvent({
      actor,
      action: direction === "inbound" ? "message.received" : "message.queued",
      entityType: "conversation_message",
      entityId: result.message.id,
      meta: { threadId: result.thread.id, channel }
    });
  }

  return NextResponse.json({
    thread: {
      id: result.thread.id,
      status: result.thread.status,
      state: result.thread.state,
      channel: result.thread.channel,
      subject: result.thread.subject ?? null,
      stateUpdatedAt: result.thread.stateUpdatedAt
        ? result.thread.stateUpdatedAt.toISOString()
        : null,
      leadId: result.thread.leadId ?? null,
      contactId: result.thread.contactId ?? null,
      propertyId: result.thread.propertyId ?? null
    }
  });
}
