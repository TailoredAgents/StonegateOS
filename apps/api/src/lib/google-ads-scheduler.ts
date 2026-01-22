import { and, eq, isNull } from "drizzle-orm";
import { getDb, outboxEvents, providerHealth } from "@/db";

function hasGoogleAdsConfig(): boolean {
  const developerToken = process.env["GOOGLE_ADS_DEVELOPER_TOKEN"] ?? "";
  const clientId = process.env["GOOGLE_ADS_CLIENT_ID"] ?? "";
  const clientSecret = process.env["GOOGLE_ADS_CLIENT_SECRET"] ?? "";
  const refreshToken = process.env["GOOGLE_ADS_REFRESH_TOKEN"] ?? "";
  const customerId = process.env["GOOGLE_ADS_CUSTOMER_ID"] ?? "";
  return Boolean(developerToken && clientId && clientSecret && refreshToken && customerId);
}

export async function queueGoogleAdsSyncIfNeeded(input?: {
  days?: number;
  invokedBy?: "worker" | "admin";
}): Promise<{ queued: boolean; reason: string; eventId?: string | null }> {
  if (process.env["GOOGLE_ADS_SYNC_DISABLED"] === "1") {
    return { queued: false, reason: "disabled" };
  }

  if (!hasGoogleAdsConfig()) {
    return { queued: false, reason: "not_configured" };
  }

  const daysRaw = input?.days;
  const days = Number.isFinite(daysRaw) && typeof daysRaw === "number" && daysRaw > 0 ? Math.min(Math.floor(daysRaw), 30) : 14;

  const db = getDb();
  const existing = await db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.type, "google.ads_insights.sync"), isNull(outboxEvents.processedAt)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing?.id) {
    return { queued: false, reason: "already_queued", eventId: existing.id };
  }

  const [event] = await db
    .insert(outboxEvents)
    .values({
      type: "google.ads_insights.sync",
      payload: {
        days,
        invokedBy: input?.invokedBy ?? "worker"
      }
    })
    .returning({ id: outboxEvents.id });

  // Mark the provider as "unknown" (row exists) so the UI can show a status even before first success.
  await db
    .insert(providerHealth)
    .values({ provider: "google_ads" })
    .onConflictDoNothing();

  return { queued: true, reason: "queued", eventId: event?.id ?? null };
}
