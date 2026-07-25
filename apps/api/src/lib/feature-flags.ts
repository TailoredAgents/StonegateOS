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
