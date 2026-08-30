export const APPOINTMENT_MEDIA_MAX_ATTEMPTS = 5;
export const GOOGLE_ADS_SYNC_MAX_ATTEMPTS = 5;

const GOOGLE_ADS_INVALID_RESPONSE_ERRORS = new Set([
  "google_ads_invalid_response",
  "google_ads_accessible_customers_invalid_response",
]);

/**
 * A successful HTTP response with a malformed Google Ads body is a stable
 * contract failure. Replaying the identical job cannot repair that response,
 * so it belongs in quarantine rather than the transient retry path.
 */
export function isGoogleAdsInvalidResponseFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return GOOGLE_ADS_INVALID_RESPONSE_ERRORS.has(message);
}
