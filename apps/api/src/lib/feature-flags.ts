const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Operational feature flags default off in production and on elsewhere. An
 * explicit environment value always wins so staging can exercise production
 * behavior and developers can test a disabled path.
 */
export function isOperationalFeatureEnabled(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw && TRUE_VALUES.has(raw)) return true;
  if (raw && FALSE_VALUES.has(raw)) return false;
  return process.env["NODE_ENV"] !== "production";
}

export function areAppointmentMediaWritesEnabled(): boolean {
  return isOperationalFeatureEnabled("APPOINTMENT_MEDIA_WRITES_ENABLED");
}

export function arePublicQuoteMediaUploadsEnabled(): boolean {
  return isOperationalFeatureEnabled("PUBLIC_QUOTE_MEDIA_UPLOADS_ENABLED");
}

export function isMediaAutoImportEnabled(): boolean {
  return isOperationalFeatureEnabled("MEDIA_AUTO_IMPORT_ENABLED");
}

export function isMobileOfflineMediaEnabled(): boolean {
  return isOperationalFeatureEnabled("MOBILE_OFFLINE_MEDIA_ENABLED");
}

export const QUOTE_V2_FEATURE_FLAGS = {
  dualWrite: "QUOTE_V2_DUAL_WRITE_ENABLED",
  staff: "QUOTE_V2_STAFF_ENABLED",
  sender: "QUOTE_V2_SENDER_ENABLED",
  public: "QUOTE_V2_PUBLIC_ENABLED",
  mutations: "QUOTE_V2_MUTATIONS_ENABLED",
  deposits: "QUOTE_V2_DEPOSITS_ENABLED",
  booking: "QUOTE_V2_BOOKING_ENABLED",
} as const;

export type QuoteV2Feature = keyof typeof QUOTE_V2_FEATURE_FLAGS;

export function isQuoteV2FeatureEnabled(feature: QuoteV2Feature): boolean {
  return isOperationalFeatureEnabled(QUOTE_V2_FEATURE_FLAGS[feature]);
}

export function getQuoteV2FeatureState(): Record<QuoteV2Feature, boolean> {
  return {
    dualWrite: isQuoteV2FeatureEnabled("dualWrite"),
    staff: isQuoteV2FeatureEnabled("staff"),
    sender: isQuoteV2FeatureEnabled("sender"),
    public: isQuoteV2FeatureEnabled("public"),
    mutations: isQuoteV2FeatureEnabled("mutations"),
    deposits: isQuoteV2FeatureEnabled("deposits"),
    booking: isQuoteV2FeatureEnabled("booking"),
  };
}
