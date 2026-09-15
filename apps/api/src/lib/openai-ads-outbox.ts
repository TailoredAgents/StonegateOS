import type { OutboxFinalizationOutcome } from "@/lib/outbox-finalization";
import {
  isOpenAiAdsConsentRevoked,
  parseOpenAiAdsConsentId,
} from "@/lib/openai-ads-consent";
import {
  OPENAI_ADS_MAX_EVENT_AGE_MS,
  parseOpenAiAdsEvent,
  sendOpenAiAdsConversion,
  type OpenAiAdsDeliveryResult,
} from "@/lib/openai-ads";

// Age, rather than a short generic attempt budget, governs recoverability.
// Keep failures durable throughout the provider's seven-day acceptance window.
export const OPENAI_ADS_MAX_ATTEMPTS = 10_000;

export async function processOpenAiAdsConversionOutbox(
  payload: unknown,
  options: {
    now?: Date;
    send?: typeof sendOpenAiAdsConversion;
    isConsentRevoked?: (consentId: string) => Promise<boolean>;
  } = {},
): Promise<OutboxFinalizationOutcome> {
  const event = parseOpenAiAdsEvent(
    payload && typeof payload === "object" && "event" in payload
      ? payload.event
      : null,
  );
  const now = options.now ?? new Date();
  if (!event) {
    return {
      status: "quarantined",
      error: "openai_ads_event_invalid",
      quarantineReason: "openai_ads_event_invalid",
    };
  }
  const age = now.getTime() - event.timestamp_ms;
  if (age > OPENAI_ADS_MAX_EVENT_AGE_MS || age < -10 * 60_000) {
    const reason =
      age > 0 ? "openai_ads_event_expired" : "openai_ads_event_time_invalid";
    return { status: "quarantined", error: reason, quarantineReason: reason };
  }
  let result: OpenAiAdsDeliveryResult;
  try {
    const consentId =
      payload && typeof payload === "object" && "consentId" in payload
        ? parseOpenAiAdsConsentId(payload.consentId)
        : null;
    if (!consentId) {
      return {
        status: "quarantined",
        error: "openai_ads_consent_missing",
        quarantineReason: "openai_ads_consent_missing",
      };
    }
    if (
      await (options.isConsentRevoked ?? isOpenAiAdsConsentRevoked)(consentId)
    ) {
      return {
        status: "quarantined",
        error: "openai_ads_consent_revoked",
        quarantineReason: "openai_ads_consent_revoked",
      };
    }
    result = await (options.send ?? sendOpenAiAdsConversion)(event);
  } catch {
    // Unexpected adapter failures must retain the conversion. Replaying the
    // persisted ID remains safe even if the provider accepted it first.
    result = { ok: false, retryable: true, code: "openai_ads_delivery_error" };
  }
  if (result.ok) return { status: "processed" };
  if (!result.retryable) {
    return {
      status: "quarantined",
      error: result.code,
      quarantineReason: "openai_ads_request_rejected",
    };
  }
  const retryAfterMs =
    result.retryAfterMs ??
    (result.code === "openai_ads_http_401" ||
    result.code === "openai_ads_http_403"
      ? 60 * 60_000
      : 5 * 60_000);
  return {
    status: "retry",
    error: result.code,
    nextAttemptAt: new Date(now.getTime() + retryAfterMs),
    maxAttempts: OPENAI_ADS_MAX_ATTEMPTS,
    quarantineReason: "openai_ads_retry_budget_exhausted",
  };
}
