import { eq } from "drizzle-orm";
import { getDb, providerHealth } from "@/db";

export type ProviderName = "sms" | "email" | "calendar" | "meta_ads" | "google_ads";

export async function recordProviderSuccess(provider: ProviderName): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(providerHealth)
    .values({
      provider,
      lastSuccessAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: providerHealth.provider,
      set: {
        lastSuccessAt: now,
        updatedAt: now
      }
    });
}

export async function recordProviderFailure(
  provider: ProviderName,
  detail: string | null
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(providerHealth)
    .values({
      provider,
      lastFailureAt: now,
      lastFailureDetail: detail,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: providerHealth.provider,
      set: {
        lastFailureAt: now,
        lastFailureDetail: detail,
        updatedAt: now
      }
    });
}
