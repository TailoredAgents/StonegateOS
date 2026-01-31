import { and, desc, eq, sql } from "drizzle-orm";
import {
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb,
  leads,
  outboxEvents
} from "@/db";

export type SystemOutboundChannel = "sms" | "email" | "dm";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<DatabaseClient["transaction"]>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

async function ensureThreadForContactChannel(
  db: DbExecutor,
  input: { contactId: string; channel: SystemOutboundChannel }
): Promise<string | null> {
  const [existing] = await db
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(and(eq(conversationThreads.contactId, input.contactId), eq(conversationThreads.channel, input.channel)))
    .orderBy(desc(conversationThreads.lastMessageAt), desc(conversationThreads.updatedAt))
    .limit(1);

  if (existing?.id) return existing.id;

  const [latestLead] = await db
    .select({ leadId: leads.id, propertyId: leads.propertyId })
    .from(leads)
    .where(eq(leads.contactId, input.contactId))
    .orderBy(desc(leads.createdAt), desc(leads.updatedAt))
    .limit(1);

  const now = new Date();
  const [created] = await db
    .insert(conversationThreads)
    .values({
      contactId: input.contactId,
      leadId: latestLead?.leadId ?? null,
      propertyId: latestLead?.propertyId ?? null,
      status: "open",
      channel: input.channel,
      subject: input.channel === "email" ? "Stonegate" : null,
      lastMessagePreview: "System message queued",
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now
    })
    .returning({ id: conversationThreads.id });

  return created?.id ?? null;
}

async function ensureSystemParticipant(db: DbExecutor, threadId: string, createdAt: Date): Promise<string | null> {
  const [existing] = await db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(and(eq(conversationParticipants.threadId, threadId), eq(conversationParticipants.participantType, "system")))
    .limit(1);

  if (existing?.id) return existing.id;

  const [created] = await db
    .insert(conversationParticipants)
    .values({
      threadId,
      participantType: "system",
      displayName: "Stonegate Assistant",
      createdAt
    })
    .returning({ id: conversationParticipants.id });

  return created?.id ?? null;
}

export async function queueSystemOutboundMessage(input: {
  db?: DbExecutor;
  contactId: string;
  channel: SystemOutboundChannel;
  toAddress?: string | null;
  subject?: string | null;
  body: string;
  mediaUrls?: string[] | null;
  metadata?: Record<string, unknown> | null;
  dedupeKey?: string | null;
  nextAttemptAt?: Date | null;
}): Promise<string | null> {
  const db = input.db ?? getDb();
  const now = new Date();

  const threadId = await ensureThreadForContactChannel(db, { contactId: input.contactId, channel: input.channel });
  if (!threadId) return null;

  const dedupeKey = typeof input.dedupeKey === "string" && input.dedupeKey.trim().length > 0 ? input.dedupeKey.trim() : null;
  if (dedupeKey) {
    const [existing] = await db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.threadId, threadId),
          eq(conversationMessages.direction, "outbound"),
          sql`${conversationMessages.metadata} ->> 'dedupeKey' = ${dedupeKey}`
        )
      )
      .limit(1);

    if (existing?.id) {
      return existing.id;
    }
  }

  const participantId = await ensureSystemParticipant(db, threadId, now);

  const metadata = {
    ...(input.metadata ?? {}),
    system: true,
    automation: true,
    dedupeKey: dedupeKey ?? undefined
  };

  const [message] = await db
    .insert(conversationMessages)
    .values({
      threadId,
      participantId,
      direction: "outbound",
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      mediaUrls: Array.isArray(input.mediaUrls) ? input.mediaUrls : [],
      toAddress: input.toAddress ?? null,
      deliveryStatus: "queued",
      metadata,
      createdAt: now
    })
    .returning({ id: conversationMessages.id });

  if (!message?.id) return null;

  await db
    .update(conversationThreads)
    .set({
      lastMessagePreview: input.body.slice(0, 140),
      lastMessageAt: now,
      updatedAt: now
    })
    .where(eq(conversationThreads.id, threadId));

  await db.insert(outboxEvents).values({
    type: "message.send",
    payload: { messageId: message.id },
    createdAt: now,
    nextAttemptAt: input.nextAttemptAt ?? null
  });

  return message.id;
}

