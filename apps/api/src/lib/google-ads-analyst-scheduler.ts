import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, googleAdsAnalystReports, outboxEvents, providerHealth } from "@/db";
import { getGoogleAdsAnalystPolicy } from "@/lib/policy";

function hasOpenAi(): boolean {
  return Boolean(process.env["OPENAI_API_KEY"]);
}

export async function queueGoogleAdsAnalystIfNeeded(input?: {
  invokedBy?: "worker" | "admin";
  rangeDays?: number;
}): Promise<{ queued: boolean; reason: string; eventId?: string | null }> {
  if (process.env["GOOGLE_ADS_ANALYST_DISABLED"] === "1") {
    return { queued: false, reason: "disabled" };
  }

  const policy = await getGoogleAdsAnalystPolicy();
  if (!policy.enabled) {
    return { queued: false, reason: "not_enabled" };
  }
  if (!policy.autonomous && input?.invokedBy !== "admin") {
    return { queued: false, reason: "autonomous_off" };
  }

  if (!hasOpenAi()) {
    return { queued: false, reason: "openai_not_configured" };
  }

  const rangeDaysRaw = input?.rangeDays;
  const rangeDays =
    typeof rangeDaysRaw === "number" && Number.isFinite(rangeDaysRaw)
      ? Math.min(Math.max(Math.floor(rangeDaysRaw), 1), 30)
      : 7;

  const db = getDb();

  const existing = await db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.type, "google.ads_analyst.run"), isNull(outboxEvents.processedAt)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing?.id) {
    return { queued: false, reason: "already_queued", eventId: existing.id };
  }

  const lastReport = await db
    .select({ createdAt: googleAdsAnalystReports.createdAt })
    .from(googleAdsAnalystReports)
    .orderBy(desc(googleAdsAnalystReports.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const lastCreatedAtMs = lastReport?.createdAt ? lastReport.createdAt.getTime() : null;
  if (lastCreatedAtMs && Date.now() - lastCreatedAtMs < 20 * 60 * 60 * 1000) {
    return { queued: false, reason: "recent_report" };
  }

  const [event] = await db
    .insert(outboxEvents)
    .values({
      type: "google.ads_analyst.run",
      payload: {
        rangeDays,
        invokedBy: input?.invokedBy ?? "worker"
      }
    })
    .returning({ id: outboxEvents.id });

  await db.insert(providerHealth).values({ provider: "google_ads_analyst" }).onConflictDoNothing();

  return { queued: true, reason: "queued", eventId: event?.id ?? null };
}
