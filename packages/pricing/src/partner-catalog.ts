export const PARTNER_ALLOWED_SERVICE_KEYS = [
  "junk-removal",
  "demo-hauloff",
  "land-clearing"
] as const;

export type PartnerServiceKey = (typeof PARTNER_ALLOWED_SERVICE_KEYS)[number];

export const PARTNER_SERVICE_LABELS: Record<PartnerServiceKey, string> = {
  "junk-removal": "Junk removal",
  "demo-hauloff": "Demo + haul-off",
  "land-clearing": "Land clearing"
};

export const PARTNER_JUNK_BASE_TIER_KEYS = ["quarter", "half", "three_quarter", "full"] as const;
export type PartnerJunkBaseTierKey = (typeof PARTNER_JUNK_BASE_TIER_KEYS)[number];

export const PARTNER_JUNK_ADDON_TIER_KEYS = ["mattress_fee", "paint_fee", "tire_fee"] as const;
export type PartnerJunkAddonTierKey = (typeof PARTNER_JUNK_ADDON_TIER_KEYS)[number];

export const PARTNER_JUNK_TIER_KEYS = [
  ...PARTNER_JUNK_BASE_TIER_KEYS,
  ...PARTNER_JUNK_ADDON_TIER_KEYS
] as const;
export type PartnerJunkTierKey = (typeof PARTNER_JUNK_TIER_KEYS)[number];

export const PARTNER_DEMO_TIER_KEYS = ["small", "medium", "large"] as const;
export type PartnerDemoTierKey = (typeof PARTNER_DEMO_TIER_KEYS)[number];

export const PARTNER_LAND_CLEARING_TIER_KEYS = [
  "small_patch",
  "yard_section",
  "most_of_yard",
  "full_lot",
  "not_sure"
] as const;
export type PartnerLandClearingTierKey = (typeof PARTNER_LAND_CLEARING_TIER_KEYS)[number];

export function isPartnerAllowedServiceKey(value: string): value is PartnerServiceKey {
  return (PARTNER_ALLOWED_SERVICE_KEYS as readonly string[]).includes(value);
}

export function isPartnerJunkTierKey(value: string): value is PartnerJunkTierKey {
  return (PARTNER_JUNK_TIER_KEYS as readonly string[]).includes(value);
}

export function isPartnerJunkBaseTierKey(value: string): value is PartnerJunkBaseTierKey {
  return (PARTNER_JUNK_BASE_TIER_KEYS as readonly string[]).includes(value);
}

export function isPartnerDemoTierKey(value: string): value is PartnerDemoTierKey {
  return (PARTNER_DEMO_TIER_KEYS as readonly string[]).includes(value);
}

export function isPartnerLandClearingTierKey(value: string): value is PartnerLandClearingTierKey {
  return (PARTNER_LAND_CLEARING_TIER_KEYS as readonly string[]).includes(value);
}

function titleCaseFromKey(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getPartnerServiceLabel(serviceKey: string): string {
  const normalized = serviceKey.trim().toLowerCase();
  if (isPartnerAllowedServiceKey(normalized)) {
    return PARTNER_SERVICE_LABELS[normalized];
  }
  return titleCaseFromKey(normalized || "service");
}

const PARTNER_DEMO_TIER_LABELS: Record<PartnerDemoTierKey, string> = {
  small: "Small demo",
  medium: "Medium demo",
  large: "Large demo"
};

const PARTNER_LAND_CLEARING_TIER_LABELS: Record<PartnerLandClearingTierKey, string> = {
  small_patch: "Small patch",
  yard_section: "Yard section",
  most_of_yard: "Most of a yard",
  full_lot: "Full lot (starting)",
  not_sure: "Not sure"
};

export function getPartnerTierLabel(serviceKey: string, tierKey: string): string {
  const normalizedService = serviceKey.trim().toLowerCase();
  const normalizedTier = tierKey.trim();
  if (normalizedService === "junk-removal") {
    return titleCaseFromKey(normalizedTier || "tier");
  }
  if (normalizedService === "demo-hauloff" && isPartnerDemoTierKey(normalizedTier)) {
    return PARTNER_DEMO_TIER_LABELS[normalizedTier];
  }
  if (normalizedService === "land-clearing" && isPartnerLandClearingTierKey(normalizedTier)) {
    return PARTNER_LAND_CLEARING_TIER_LABELS[normalizedTier];
  }
  return titleCaseFromKey(normalizedTier || "tier");
}

export function isPartnerTierKeyForService(serviceKey: string, tierKey: string): boolean {
  const normalizedService = serviceKey.trim().toLowerCase();
  const normalizedTier = tierKey.trim();
  if (normalizedService === "junk-removal") return isPartnerJunkTierKey(normalizedTier);
  if (normalizedService === "demo-hauloff") return isPartnerDemoTierKey(normalizedTier);
  if (normalizedService === "land-clearing") return isPartnerLandClearingTierKey(normalizedTier);
  return false;
}
