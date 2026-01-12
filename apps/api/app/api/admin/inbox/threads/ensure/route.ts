import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, or } from "drizzle-orm";
import { conversationParticipants, conversationThreads, contacts, getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const CHANNELS = ["sms", "email", "dm", "call", "web"] as const;
type Channel = (typeof CHANNELS)[number];

function isChannel(value: string | null): value is Channel {
  return value ? (CHANNELS as readonly string[]).includes(value) : false;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as {
    contactId?: string;
    channel?: string;
  } | null;

  const contactId = typeof payload?.contactId === "string" ? payload.contactId.trim() : "";
  if (!contactId) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const channel: Channel = isChannel(payload?.channel ?? null) ? (payload!.channel as Channel) : "sms";
  const db = getDb();

  const [existing] = await db
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.contactId, contactId),
        eq(conversationThreads.channel, channel),
        or(eq(conversationThreads.status, "open"), eq(conversationThreads.status, "pending"), eq(conversationThreads.status, "closed"))
      )
    )
    .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
    .limit(1);

  if (existing?.id) {
    return NextResponse.json({ ok: true, threadId: existing.id, created: false });
  }

  const actor = getAuditActorFromRequest(request);

  const now = new Date();
  let threadId: string;
  try {
    threadId = await db.transaction(async (tx) => {
      const [contact] = await tx
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
          phone: contacts.phone,
          phoneE164: contacts.phoneE164,
          salespersonMemberId: contacts.salespersonMemberId
        })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);

      if (!contact?.id) {
        throw new Error("contact_not_found");
      }

      const [thread] = await tx
        .insert(conversationThreads)
        .values({
          contactId: contact.id,
          channel,
          status: "open",
          state: "new",
          assignedTo: contact.salespersonMemberId ?? null,
          stateUpdatedAt: now,
          createdAt: now,
          updatedAt: now
        })
        .returning();

      if (!thread?.id) {
        throw new Error("thread_create_failed");
      }

      const displayName = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
      const externalAddress =
        channel === "email"
          ? contact.email ?? null
          : channel === "dm"
            ? null
            : contact.phoneE164 ?? contact.phone ?? null;

      await tx.insert(conversationParticipants).values({
        threadId: thread.id,
        participantType: "contact",
        contactId: contact.id,
        externalAddress,
        displayName: displayName || "Contact",
        createdAt: now
      });

      return thread.id;
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
    entityId: threadId,
    meta: { channel, contactId, ensured: true }
  });

  return NextResponse.json({ ok: true, threadId, created: true });
}

