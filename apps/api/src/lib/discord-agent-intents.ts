import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { discordActionIntents, getDb } from "../db";

export type DiscordActionIntentStatus =
  | "pending"
  | "approved"
  | "executed"
  | "canceled"
  | "expired"
  | "failed";

export type CreateDiscordActionIntentInput = {
  discordGuildId?: string | null;
  discordChannelId: string;
  discordIntentMessageId: string;
  requestedByDiscordUserId: string;
  requestText?: string | null;
  agentReply?: string | null;
  actions?: Array<Record<string, unknown>> | null;
  expiresAt?: Date | null;
};

export type DiscordActionIntentRecord = typeof discordActionIntents.$inferSelect & {
  status: DiscordActionIntentStatus;
};

function now() {
  return new Date();
}

export async function createDiscordActionIntent(input: CreateDiscordActionIntentInput): Promise<DiscordActionIntentRecord> {
  const db = getDb();
  const expiresAt = input.expiresAt ?? null;

  const rows = await db
    .insert(discordActionIntents)
    .values({
      discordGuildId: input.discordGuildId ?? null,
      discordChannelId: input.discordChannelId,
      discordIntentMessageId: input.discordIntentMessageId,
      requestedByDiscordUserId: input.requestedByDiscordUserId,
      requestText: input.requestText ?? null,
      agentReply: input.agentReply ?? null,
      actions: input.actions ?? null,
      expiresAt
    })
    .returning();

  const record = rows[0] as unknown as DiscordActionIntentRecord | undefined;
  if (!record) throw new Error("discord_action_intent_insert_failed");
  return record;
}

export async function findPendingDiscordActionIntentByBotMessageId(discordIntentMessageId: string) {
  const db = getDb();
  const current = now();

  const rows = await db
    .select()
    .from(discordActionIntents)
    .where(
      and(
        eq(discordActionIntents.discordIntentMessageId, discordIntentMessageId),
        eq(discordActionIntents.status, "pending"),
        or(isNull(discordActionIntents.expiresAt), gt(discordActionIntents.expiresAt, current))
      )
    )
    .limit(1);

  return (rows[0] as unknown as DiscordActionIntentRecord | undefined) ?? null;
}

export async function findLatestPendingDiscordActionIntent(input: {
  discordChannelId: string;
  requestedByDiscordUserId: string;
}) {
  const db = getDb();
  const current = now();

  const rows = await db
    .select()
    .from(discordActionIntents)
    .where(
      and(
        eq(discordActionIntents.discordChannelId, input.discordChannelId),
        eq(discordActionIntents.requestedByDiscordUserId, input.requestedByDiscordUserId),
        eq(discordActionIntents.status, "pending"),
        or(isNull(discordActionIntents.expiresAt), gt(discordActionIntents.expiresAt, current))
      )
    )
    .orderBy(desc(discordActionIntents.createdAt))
    .limit(1);

  return (rows[0] as unknown as DiscordActionIntentRecord | undefined) ?? null;
}

export async function cancelDiscordActionIntent(id: string, executedByDiscordUserId?: string | null) {
  const db = getDb();
  const canceledAt = now();

  const rows = await db
    .update(discordActionIntents)
    .set({
      status: "canceled",
      canceledAt,
      executedByDiscordUserId: executedByDiscordUserId ?? null,
      updatedAt: canceledAt
    })
    .where(and(eq(discordActionIntents.id, id), eq(discordActionIntents.status, "pending")))
    .returning();

  return (rows[0] as unknown as DiscordActionIntentRecord | undefined) ?? null;
}

export async function markDiscordActionIntentApproved(id: string, executedByDiscordUserId?: string | null) {
  const db = getDb();
  const approvedAt = now();

  const rows = await db
    .update(discordActionIntents)
    .set({
      status: "approved",
      approvedAt,
      executedByDiscordUserId: executedByDiscordUserId ?? null,
      updatedAt: approvedAt
    })
    .where(and(eq(discordActionIntents.id, id), eq(discordActionIntents.status, "pending")))
    .returning();

  return (rows[0] as unknown as DiscordActionIntentRecord | undefined) ?? null;
}

export async function markDiscordActionIntentExecuted(input: {
  id: string;
  ok: boolean;
  result?: Record<string, unknown> | null;
  error?: string | null;
}) {
  const db = getDb();
  const executedAt = now();

  const rows = await db
    .update(discordActionIntents)
    .set({
      status: input.ok ? "executed" : "failed",
      executedAt,
      result: input.result ?? null,
      error: input.error ?? null,
      updatedAt: executedAt
    })
    .where(eq(discordActionIntents.id, input.id))
    .returning();

  return (rows[0] as unknown as DiscordActionIntentRecord | undefined) ?? null;
}
