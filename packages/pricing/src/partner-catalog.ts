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

export function isPartnerAllowedServiceKey(value: string): value is PartnerServiceKey {
  return (PARTNER_ALLOWED_SERVICE_KEYS as readonly string[]).includes(value);
}

export function isPartnerJunkTierKey(value: string): value is PartnerJunkTierKey {
  return (PARTNER_JUNK_TIER_KEYS as readonly string[]).includes(value);
}

export function isPartnerJunkBaseTierKey(value: string): value is PartnerJunkBaseTierKey {
  return (PARTNER_JUNK_BASE_TIER_KEYS as readonly string[]).includes(value);
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

