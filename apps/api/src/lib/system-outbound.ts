import { and, desc, eq, sql } from "drizzle-orm";
import {
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb,
  leads,
  outboxEvents,
} from "@/db";
import { requireActiveContactForDirectOutbound } from "@/lib/contact-outbound-safety";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export type SystemOutboundChannel = "sms" | "email" | "dm";

const SYSTEM_OUTBOUND_DEDUPE_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{15,239}$/u;

type DbExecutor = TeamMutationTransaction;

export function normalizeSystemOutboundDedupeKey(
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new TeamMutationFailure(
      "invalid",
      "The system notification operation key is invalid.",
    );
  }

  const normalized = value.trim();
  if (!SYSTEM_OUTBOUND_DEDUPE_KEY_PATTERN.test(normalized)) {
    throw new TeamMutationFailure(
      "invalid",
      "The system notification operation key is invalid.",
    );
  }
  return normalized;
}

async function ensureThreadForContactChannel(
  db: DbExecutor,
  input: { contactId: string; channel: SystemOutboundChannel },
): Promise<string | null> {
  const [existing] = await db
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.contactId, input.contactId),
        eq(conversationThreads.channel, input.channel),
      ),
    )
    .orderBy(
      desc(conversationThreads.lastMessageAt),
      desc(conversationThreads.updatedAt),
    )
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
      updatedAt: now,
    })
    .returning({ id: conversationThreads.id });

  return created?.id ?? null;
}

async function ensureSystemParticipant(
  db: DbExecutor,
  threadId: string,
  createdAt: Date,
): Promise<string | null> {
  const [existing] = await db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, threadId),
        eq(conversationParticipants.participantType, "system"),
      ),
    )
    .limit(1);

  if (existing?.id) return existing.id;

  const [created] = await db
    .insert(conversationParticipants)
    .values({
      threadId,
      participantType: "system",
      displayName: "Stonegate Assistant",
      createdAt,
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
  if (!input.db) {
    const db = getDb();
    return db.transaction((tx) =>
      queueSystemOutboundMessage({ ...input, db: tx }),
    );
  }

  const db = input.db;
  try {
    await requireActiveContactForDirectOutbound(db, input.contactId);
  } catch (error) {
    if (error instanceof TeamMutationFailure) return null;
    throw error;
  }
  const now = new Date();
  const dedupeKey = normalizeSystemOutboundDedupeKey(input.dedupeKey);

  // System notifications may be retried after any downstream failure. Lock
  // the contact/channel scope before selecting a thread or checking the
  // caller's logical operation key so two workers cannot create parallel
  // threads and enqueue the same customer effect twice.
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`system-outbound:${input.contactId}:${input.channel}`}, 0))`,
  );
  if (dedupeKey) {
    const [existing] = await db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .innerJoin(
        conversationThreads,
        eq(conversationThreads.id, conversationMessages.threadId),
      )
      .where(
        and(
          eq(conversationThreads.contactId, input.contactId),
          eq(conversationThreads.channel, input.channel),
          eq(conversationMessages.direction, "outbound"),
          sql`${conversationMessages.metadata} ->> 'dedupeKey' = ${dedupeKey}`,
        ),
      )
      .limit(1);

    if (existing?.id) return existing.id;
  }

  const threadId = await ensureThreadForContactChannel(db, {
    contactId: input.contactId,
    channel: input.channel,
  });
  if (!threadId) return null;

  const participantId = await ensureSystemParticipant(db, threadId, now);

  const metadata = {
    ...(input.metadata ?? {}),
    system: true,
    automation: true,
    dedupeKey: dedupeKey ?? undefined,
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
      createdAt: now,
    })
    .returning({ id: conversationMessages.id });

  if (!message?.id) return null;

  await db
    .update(conversationThreads)
    .set({
      lastMessagePreview: input.body.slice(0, 140),
      lastMessageAt: now,
      updatedAt: now,
    })
    .where(eq(conversationThreads.id, threadId));

  await db.insert(outboxEvents).values({
    type: "message.send",
    payload: { messageId: message.id },
    createdAt: now,
    nextAttemptAt: input.nextAttemptAt ?? null,
  });

  return message.id;
}
