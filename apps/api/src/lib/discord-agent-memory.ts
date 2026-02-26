import { and, desc, eq, ilike, or } from "drizzle-orm";
import { discordAgentMemory, getDb } from "../db";

export type DiscordAgentMemoryType = "note" | "preference" | "project" | "fact";
export type DiscordAgentMemoryScope = "channel" | "guild";

export type DiscordAgentMemoryRecord = typeof discordAgentMemory.$inferSelect & {
  scope: DiscordAgentMemoryScope;
  memoryType: DiscordAgentMemoryType;
};

function now() {
  return new Date();
}

function normalizeType(value: string | null | undefined): DiscordAgentMemoryType {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (trimmed === "preference" || trimmed === "project" || trimmed === "fact") return trimmed;
  return "note";
}

function normalizeScope(value: string | null | undefined): DiscordAgentMemoryScope {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (trimmed === "guild") return "guild";
  return "channel";
}

function trimMax(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export async function createDiscordAgentMemory(input: {
  discordGuildId?: string | null;
  discordChannelId: string;
  scope?: DiscordAgentMemoryScope | string | null;
  memoryType?: DiscordAgentMemoryType | string | null;
  title: string;
  content: string;
  tags?: string | null;
  pinned?: boolean | null;
  createdByDiscordUserId?: string | null;
}) {
  const db = getDb();
  const ts = now();

  const title = trimMax(input.title, 120);
  const content = trimMax(input.content, 4000);
  if (!title.length || !content.length) throw new Error("memory_title_content_required");

  const record = await db
    .insert(discordAgentMemory)
    .values({
      discordGuildId: input.discordGuildId ?? null,
      discordChannelId: input.discordChannelId,
      scope: normalizeScope(input.scope),
      memoryType: normalizeType(input.memoryType),
      title,
      content,
      tags: input.tags ?? null,
      pinned: Boolean(input.pinned),
      archived: false,
      createdByDiscordUserId: input.createdByDiscordUserId ?? null,
      createdAt: ts,
      updatedAt: ts
    })
    .returning()
    .then((rows) => rows[0] ?? null);

  if (!record) throw new Error("memory_insert_failed");
  return record as unknown as DiscordAgentMemoryRecord;
}

export async function archiveDiscordAgentMemory(input: { id: string }) {
  const db = getDb();
  const ts = now();
  const row = await db
    .update(discordAgentMemory)
    .set({ archived: true, updatedAt: ts })
    .where(eq(discordAgentMemory.id, input.id))
    .returning()
    .then((rows) => rows[0] ?? null);
  return (row as unknown as DiscordAgentMemoryRecord | null) ?? null;
}

export async function listDiscordAgentMemoryForContext(input: {
  discordGuildId?: string | null;
  discordChannelId: string;
  maxItems?: number;
}) {
  const db = getDb();
  const maxItems = Number.isFinite(Number(input.maxItems))
    ? Math.max(1, Math.min(50, Math.floor(Number(input.maxItems))))
    : 12;

  const channelRows = await db
    .select()
    .from(discordAgentMemory)
    .where(and(eq(discordAgentMemory.discordChannelId, input.discordChannelId), eq(discordAgentMemory.archived, false)))
    .orderBy(desc(discordAgentMemory.pinned), desc(discordAgentMemory.updatedAt))
    .limit(maxItems);

  const guildId = (input.discordGuildId ?? "").trim();
  if (!guildId) {
    return channelRows as unknown as DiscordAgentMemoryRecord[];
  }

  const remaining = Math.max(0, maxItems - channelRows.length);
  if (remaining <= 0) return channelRows as unknown as DiscordAgentMemoryRecord[];

  const guildRows = await db
    .select()
    .from(discordAgentMemory)
    .where(
      and(
        eq(discordAgentMemory.discordGuildId, guildId),
        eq(discordAgentMemory.scope, "guild"),
        eq(discordAgentMemory.archived, false)
      )
    )
    .orderBy(desc(discordAgentMemory.pinned), desc(discordAgentMemory.updatedAt))
    .limit(remaining);

  return [...(channelRows as any[]), ...(guildRows as any[])] as unknown as DiscordAgentMemoryRecord[];
}

export async function searchDiscordAgentMemory(input: {
  discordGuildId?: string | null;
  discordChannelId: string;
  q: string;
  maxItems?: number;
}) {
  const db = getDb();
  const q = input.q.trim();
  if (!q) return [] as DiscordAgentMemoryRecord[];
  const maxItems = Number.isFinite(Number(input.maxItems))
    ? Math.max(1, Math.min(20, Math.floor(Number(input.maxItems))))
    : 8;

  const like = `%${q.replace(/%/g, "")}%`;
  const rows = await db
    .select()
    .from(discordAgentMemory)
    .where(
      and(
        eq(discordAgentMemory.archived, false),
        or(
          eq(discordAgentMemory.discordChannelId, input.discordChannelId),
          and(eq(discordAgentMemory.discordGuildId, input.discordGuildId ?? ""), eq(discordAgentMemory.scope, "guild"))
        ),
        or(ilike(discordAgentMemory.title, like), ilike(discordAgentMemory.content, like))
      )
    )
    .orderBy(desc(discordAgentMemory.pinned), desc(discordAgentMemory.updatedAt))
    .limit(maxItems);

  return rows as unknown as DiscordAgentMemoryRecord[];
}

