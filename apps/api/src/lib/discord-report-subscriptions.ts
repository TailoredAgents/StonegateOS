import { and, desc, eq } from "drizzle-orm";
import { discordReportSubscriptions, getDb } from "../db";

export type DiscordReportType = "daily_ops";

export type DiscordReportSubscriptionRecord = typeof discordReportSubscriptions.$inferSelect & {
  reportType: DiscordReportType;
};

function now() {
  return new Date();
}

function normalizeTimeOfDay(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export async function upsertDiscordReportSubscription(input: {
  discordGuildId?: string | null;
  discordChannelId: string;
  reportType: DiscordReportType;
  timezone?: string | null;
  timeOfDay?: string | null;
  createdByDiscordUserId?: string | null;
}) {
  const db = getDb();
  const ts = now();

  const timeOfDay = normalizeTimeOfDay(input.timeOfDay) ?? "08:30";
  const timezone = (input.timezone ?? "").trim() || "America/New_York";

  const rows = await db
    .insert(discordReportSubscriptions)
    .values({
      discordGuildId: input.discordGuildId ?? null,
      discordChannelId: input.discordChannelId,
      reportType: input.reportType,
      timezone,
      timeOfDay,
      enabled: true,
      createdByDiscordUserId: input.createdByDiscordUserId ?? null,
      updatedAt: ts
    })
    .onConflictDoUpdate({
      target: [discordReportSubscriptions.discordChannelId, discordReportSubscriptions.reportType],
      set: {
        enabled: true,
        timezone,
        timeOfDay,
        discordGuildId: input.discordGuildId ?? null,
        createdByDiscordUserId: input.createdByDiscordUserId ?? null,
        updatedAt: ts
      }
    })
    .returning();

  const record = rows[0] as unknown as DiscordReportSubscriptionRecord | undefined;
  if (!record) throw new Error("discord_report_subscription_upsert_failed");
  return record;
}

export async function disableDiscordReportSubscription(input: { discordChannelId: string; reportType: DiscordReportType }) {
  const db = getDb();
  const ts = now();
  const rows = await db
    .update(discordReportSubscriptions)
    .set({ enabled: false, updatedAt: ts })
    .where(
      and(
        eq(discordReportSubscriptions.discordChannelId, input.discordChannelId),
        eq(discordReportSubscriptions.reportType, input.reportType)
      )
    )
    .returning();
  return (rows[0] as unknown as DiscordReportSubscriptionRecord | undefined) ?? null;
}

export async function listEnabledDiscordReportSubscriptions(reportType?: DiscordReportType) {
  const db = getDb();
  const rows = await db
    .select()
    .from(discordReportSubscriptions)
    .where(
      reportType
        ? and(eq(discordReportSubscriptions.enabled, true), eq(discordReportSubscriptions.reportType, reportType))
        : eq(discordReportSubscriptions.enabled, true)
    )
    .orderBy(desc(discordReportSubscriptions.updatedAt))
    .limit(200);
  return rows as unknown as DiscordReportSubscriptionRecord[];
}

export async function markDiscordReportSubscriptionSent(input: { id: string; sentAt?: Date }) {
  const db = getDb();
  const ts = input.sentAt ?? now();
  const rows = await db
    .update(discordReportSubscriptions)
    .set({ lastSentAt: ts, updatedAt: ts })
    .where(eq(discordReportSubscriptions.id, input.id))
    .returning();
  return (rows[0] as unknown as DiscordReportSubscriptionRecord | undefined) ?? null;
}

