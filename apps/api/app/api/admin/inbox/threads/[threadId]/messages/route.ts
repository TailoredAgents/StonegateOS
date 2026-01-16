import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  conversationThreads,
  conversationMessages,
  conversationParticipants,
  contacts,
  outboxEvents
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { completeNextFollowupTaskOnTouch } from "@/lib/sales-followups";

const CHANNELS = ["sms", "email", "dm", "call", "web"] as const;
const DIRECTIONS = ["inbound", "outbound", "internal"] as const;

type Channel = (typeof CHANNELS)[number];
type Direction = (typeof DIRECTIONS)[number];

function isChannel(value: string | null): value is Channel {
  return value ? (CHANNELS as readonly string[]).includes(value) : false;
}

function isDirection(value: string | null): value is Direction {
  return value ? (DIRECTIONS as readonly string[]).includes(value) : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(
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
    body?: string;
    subject?: string;
    direction?: string;
    channel?: string;
    mediaUrls?: string[];
    toAddress?: string;
    fromAddress?: string;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!body) {
    return NextResponse.json({ error: "body_required" }, { status: 400 });
  }

  const subject = typeof payload.subject === "string" && payload.subject.trim().length > 0 ? payload.subject.trim() : null;
  const direction = isDirection(payload.direction ?? null) ? (payload.direction as Direction) : "outbound";
  const channel = isChannel(payload.channel ?? null) ? (payload.channel as Channel) : null;
  const mediaUrls = Array.isArray(payload.mediaUrls)
    ? payload.mediaUrls.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
    : [];
  const toAddress = typeof payload.toAddress === "string" && payload.toAddress.trim().length > 0 ? payload.toAddress.trim() : null;
  const fromAddress =
    typeof payload.fromAddress === "string" && payload.fromAddress.trim().length > 0
      ? payload.fromAddress.trim()
      : null;

  const actor = getAuditActorFromRequest(request);
  const db = getDb();

  let result: { message: typeof conversationMessages.$inferSelect; messageChannel: string; contactId: string | null; salespersonMemberId: string | null };
  try {
    result = await db.transaction(async (tx) => {
      const [thread] = await tx
      .select({
        id: conversationThreads.id,
        channel: conversationThreads.channel,
        contactId: conversationThreads.contactId
      })
      .from(conversationThreads)
      .where(eq(conversationThreads.id, threadId))
      .limit(1);

      if (!thread) {
        throw new Error("thread_not_found");
      }

    const messageChannel = channel ?? thread.channel ?? "sms";
    const now = new Date();

    let participantId: string | null = null;
    let resolvedToAddress: string | null = toAddress;
    let resolvedMetadata: Record<string, unknown> | null = null;
    let salespersonMemberId: string | null = null;

    if (direction === "inbound") {
      const contactParticipant = await tx
        .select({ id: conversationParticipants.id })
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.threadId, threadId),
            eq(conversationParticipants.participantType, "contact")
          )
        )
        .limit(1);

       if (!contactParticipant[0] && thread.contactId) {
         const [contact] = await tx
           .select({
             id: contacts.id,
             firstName: contacts.firstName,
             lastName: contacts.lastName,
             email: contacts.email,
             phone: contacts.phone,
             phoneE164: contacts.phoneE164
           })
           .from(contacts)
           .where(eq(contacts.id, thread.contactId))
           .limit(1);

         const displayName =
           contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() : "Contact";
         const externalAddress =
           messageChannel === "email"
             ? contact?.email ?? null
             : messageChannel === "dm"
               ? fromAddress ?? toAddress ?? null
               : contact?.phoneE164 ?? contact?.phone ?? null;

         const [created] = await tx
           .insert(conversationParticipants)
           .values({
             threadId,
            participantType: "contact",
            contactId: contact?.id ?? null,
            displayName: displayName || "Contact",
            externalAddress,
            createdAt: now
          })
          .returning();
        participantId = created?.id ?? null;
      } else {
        participantId = contactParticipant[0]?.id ?? null;
      }
     } else {
      const teamFilters = [
        eq(conversationParticipants.threadId, threadId),
        eq(conversationParticipants.participantType, "team")
      ];
      if (actor.id) {
        teamFilters.push(eq(conversationParticipants.teamMemberId, actor.id));
      }

      const existingTeam = await tx
        .select({ id: conversationParticipants.id })
        .from(conversationParticipants)
        .where(and(...teamFilters))
        .limit(1);

      if (existingTeam[0]) {
        participantId = existingTeam[0].id;
      } else {
        const [teamParticipant] = await tx
          .insert(conversationParticipants)
          .values({
            threadId,
            participantType: "team",
            teamMemberId: actor.id ?? null,
            displayName: actor.label ?? "Team Console",
            createdAt: now
          })
          .returning();
        participantId = teamParticipant?.id ?? null;
      }
    }

    if (direction === "outbound") {
      if (messageChannel === "dm") {
        const [lastInboundDm] = await tx
          .select({
            fromAddress: conversationMessages.fromAddress,
            metadata: conversationMessages.metadata
          })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.threadId, threadId),
              eq(conversationMessages.direction, "inbound"),
              eq(conversationMessages.channel, "dm")
            )
          )
          .orderBy(desc(conversationMessages.createdAt))
          .limit(1);

        resolvedToAddress = resolvedToAddress ?? (lastInboundDm?.fromAddress ?? null);
        resolvedMetadata = isRecord(lastInboundDm?.metadata) ? lastInboundDm!.metadata : null;
        resolvedMetadata = resolvedMetadata ?? { source: "facebook" };
      } else {
        const [contact] = thread.contactId
          ? await tx
              .select({
                email: contacts.email,
                phone: contacts.phone,
                phoneE164: contacts.phoneE164,
                salespersonMemberId: contacts.salespersonMemberId
              })
              .from(contacts)
              .where(eq(contacts.id, thread.contactId))
              .limit(1)
          : [null];

        salespersonMemberId = (contact?.salespersonMemberId ?? null) as string | null;
        resolvedToAddress =
          resolvedToAddress ??
          (messageChannel === "email"
            ? contact?.email ?? null
            : contact?.phoneE164 ?? contact?.phone ?? null);
      }

      if (!resolvedToAddress) {
        throw new Error("missing_recipient");
      }
    }

    const deliveryStatus =
      direction === "inbound" ? "delivered" : direction === "internal" ? "sent" : "queued";

    const [message] = await tx
      .insert(conversationMessages)
      .values({
        threadId,
        participantId,
        direction,
        channel: messageChannel,
        subject,
        body,
        mediaUrls,
        toAddress: resolvedToAddress,
        fromAddress,
        deliveryStatus,
        sentAt: deliveryStatus === "sent" ? now : null,
        receivedAt: direction === "inbound" ? now : null,
        metadata: resolvedMetadata,
        createdAt: now
      })
      .returning();

    if (!message) {
      throw new Error("message_create_failed");
    }

    await tx
      .update(conversationThreads)
      .set({
        lastMessagePreview: body.slice(0, 140),
        lastMessageAt: now,
        updatedAt: now
      })
      .where(eq(conversationThreads.id, threadId));

    if (direction === "outbound") {
      await tx.insert(outboxEvents).values({
        type: "message.send",
        payload: { messageId: message.id },
        createdAt: now
      });

      if (thread.contactId) {
        await completeNextFollowupTaskOnTouch({
          db: tx,
          contactId: thread.contactId,
          memberId: salespersonMemberId ?? actor.id ?? null,
          now
        });
      }
    }

      return { message, messageChannel, contactId: thread.contactId ?? null, salespersonMemberId };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "message_create_failed";
    const status = message === "thread_not_found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  await recordAuditEvent({
    actor,
    action: direction === "inbound" ? "message.received" : "message.queued",
    entityType: "conversation_message",
    entityId: result.message.id,
    meta: { threadId, channel: result.messageChannel, direction }
  });

  return NextResponse.json({
    message: {
      id: result.message.id,
      threadId: result.message.threadId,
      direction: result.message.direction,
      channel: result.message.channel,
      deliveryStatus: result.message.deliveryStatus,
      createdAt: result.message.createdAt.toISOString()
    }
  });
}
