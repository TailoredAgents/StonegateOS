import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, outboxEvents, type DatabaseClient } from "@/db";

export const OPENAI_ADS_CONSENT_REVOKED_EVENT = "ads.openai.consent_revoked";
type ConsentDatabase = Pick<DatabaseClient, "select" | "insert">;

export function parseOpenAiAdsConsentId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      value,
    )
    ? value.toLowerCase()
    : null;
}

export function openAiAdsConsentRevocationId(consentId: string): string {
  const normalized = parseOpenAiAdsConsentId(consentId);
  if (!normalized) throw new Error("openai_ads_consent_id_invalid");
  const digest = createHash("sha256")
    .update(`stonegate:openai-ads:consent-revoked:${normalized}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  digest[12] = "4";
  digest[16] = "8";
  const value = digest.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * A revocation stays terminal even if an older browser request arrives later.
 * Regranting creates a fresh browser consent ID; it never deletes this marker.
 * Retain these markers for at least the 30-day attribution lifetime. The current
 * outbox has no age-based cleanup; its targeted reminder cleanup excludes them.
 */
export async function recordOpenAiAdsConsentRevocation(
  consentId: string,
  database: ConsentDatabase = getDb(),
  now = new Date(),
): Promise<void> {
  const normalized = parseOpenAiAdsConsentId(consentId);
  if (!normalized) throw new Error("openai_ads_consent_id_invalid");
  await database
    .insert(outboxEvents)
    .values({
      id: openAiAdsConsentRevocationId(normalized),
      type: OPENAI_ADS_CONSENT_REVOKED_EVENT,
      payload: { consentId: normalized },
      createdAt: now,
      processedAt: now,
    })
    .onConflictDoNothing({ target: outboxEvents.id });
}

export async function isOpenAiAdsConsentRevoked(
  consentId: string,
  database: ConsentDatabase = getDb(),
): Promise<boolean> {
  const normalized = parseOpenAiAdsConsentId(consentId);
  if (!normalized) return true;
  const [revocation] = await database
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.id, openAiAdsConsentRevocationId(normalized)),
        eq(outboxEvents.type, OPENAI_ADS_CONSENT_REVOKED_EVENT),
      ),
    )
    .limit(1);
  return Boolean(revocation);
}
