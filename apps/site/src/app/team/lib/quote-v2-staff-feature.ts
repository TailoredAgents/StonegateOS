const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

function operationalFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value && ENABLED_VALUES.has(value)) return true;
  if (value && DISABLED_VALUES.has(value)) return false;
  return process.env["NODE_ENV"] !== "production";
}

/** Mirrors the API operational-flag default while keeping Site imports isolated. */
export function isQuoteV2StaffFeatureEnabled(): boolean {
  return operationalFlag("QUOTE_V2_STAFF_ENABLED");
}

export function isQuoteV2SenderFeatureEnabled(): boolean {
  return operationalFlag("QUOTE_V2_SENDER_ENABLED");
}
