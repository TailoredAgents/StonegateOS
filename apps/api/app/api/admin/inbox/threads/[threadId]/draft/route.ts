import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import {
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const CHANNELS = ["sms", "email", "dm", "call", "web"] as const;
type Channel = (typeof CHANNELS)[number];

function isChannel(value: string | null): value is Channel {
  return value ? (CHANNELS as readonly string[]).includes(value) : false;
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

  const payload = (await request.json().catch(() => null)) as
    | { body?: string; subject?: string; channel?: string }
    | null;

  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!body) {
    return NextResponse.json({ error: "body_required" }, { status: 400 });
  }

  const channel: Channel | null = isChannel(payload?.channel ?? null) ? (payload!.channel as Channel) : null;
  const subject =
    typeof payload?.subject === "string" && payload.subject.trim().length > 0 ? payload.subject.trim() : null;

  const actor = getAuditActorFromRequest(request);
  const db = getDb();
  const now = new Date();

  try {
    const result = await db.transaction(async (tx) => {
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

      const existingTeam = await tx
        .select({ id: conversationParticipants.id })
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.threadId, threadId),
            eq(conversationParticipants.participantType, "team"),
            actor.id ? eq(conversationParticipants.teamMemberId, actor.id) : isNull(conversationParticipants.teamMemberId)
          )
        )
        .limit(1);

      let participantId = existingTeam[0]?.id ?? null;
      if (!participantId) {
        const [created] = await tx
          .insert(conversationParticipants)
          .values({
            threadId,
            participantType: "team",
            teamMemberId: actor.id ?? null,
            displayName: actor.label ?? "Team Console",
            createdAt: now
          })
          .returning({ id: conversationParticipants.id });
        participantId = created?.id ?? null;
      }

      let toAddress: string | null = null;
      if (messageChannel === "dm") {
        // DM drafts are not supported here (handled by suggest + provider metadata).
        throw new Error("dm_draft_not_supported");
      }

      if (thread.contactId) {
        const [contact] = await tx
          .select({
            email: contacts.email,
            phone: contacts.phone,
            phoneE164: contacts.phoneE164
          })
          .from(contacts)
          .where(eq(contacts.id, thread.contactId))
          .limit(1);
        toAddress =
          messageChannel === "email" ? contact?.email ?? null : contact?.phoneE164 ?? contact?.phone ?? null;
      }

      if (!toAddress) {
        throw new Error("missing_recipient");
      }

      const [message] = await tx
        .insert(conversationMessages)
        .values({
          threadId,
          participantId,
          direction: "outbound",
          channel: messageChannel,
          subject: messageChannel === "email" ? subject ?? "Stonegate message" : null,
          body,
          toAddress,
          deliveryStatus: "queued",
          metadata: { draft: true, source: "canvass_quote" },
          createdAt: now
        })
        .returning({ id: conversationMessages.id });

      if (!message?.id) {
        throw new Error("draft_create_failed");
      }

      return { messageId: message.id, channel: messageChannel };
    });

    await recordAuditEvent({
      actor,
      action: "message.draft_created",
      entityType: "conversation_thread",
      entityId: threadId,
      meta: { messageId: result.messageId, channel: result.channel }
    });

    return NextResponse.json({ ok: true, messageId: result.messageId, channel: result.channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : "draft_create_failed";
    const status = message === "thread_not_found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
