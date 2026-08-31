export declare const PARTNER_ALLOWED_SERVICE_KEYS: readonly ["junk-removal", "demo-hauloff", "land-clearing"];
export type PartnerServiceKey = (typeof PARTNER_ALLOWED_SERVICE_KEYS)[number];
export declare const PARTNER_SERVICE_LABELS: Record<PartnerServiceKey, string>;
export declare const PARTNER_JUNK_BASE_TIER_KEYS: readonly ["quarter", "half", "three_quarter", "full"];
export type PartnerJunkBaseTierKey = (typeof PARTNER_JUNK_BASE_TIER_KEYS)[number];
export declare const PARTNER_JUNK_ADDON_TIER_KEYS: readonly ["mattress_fee", "paint_fee", "tire_fee"];
export type PartnerJunkAddonTierKey = (typeof PARTNER_JUNK_ADDON_TIER_KEYS)[number];
export declare const PARTNER_JUNK_ADDON_CATALOG: readonly [{
    readonly tierKey: "mattress_fee";
    readonly addOnKey: "mattress_disposal";
    readonly label: "Mattress disposal";
    readonly description: "Additional disposal handling for each mattress or box spring.";
    readonly unitLabel: "mattress";
}, {
    readonly tierKey: "paint_fee";
    readonly addOnKey: "paint_can_disposal";
    readonly label: "Paint can disposal";
    readonly description: "Additional handling for each accepted paint can.";
    readonly unitLabel: "can";
}, {
    readonly tierKey: "tire_fee";
    readonly addOnKey: "tire_disposal";
    readonly label: "Tire disposal";
    readonly description: "Additional disposal handling for each accepted tire.";
    readonly unitLabel: "tire";
}];
export declare function getPartnerAddOnKeyForLegacyTier(serviceKey: string, tierKey: string): string | null;
export declare function isPartnerAddOnTierKey(serviceKey: string, tierKey: string): boolean;
export declare const PARTNER_JUNK_TIER_KEYS: readonly ["quarter", "half", "three_quarter", "full", "mattress_fee", "paint_fee", "tire_fee"];
export type PartnerJunkTierKey = (typeof PARTNER_JUNK_TIER_KEYS)[number];
export declare const PARTNER_DEMO_TIER_KEYS: readonly ["small", "medium", "large"];
export type PartnerDemoTierKey = (typeof PARTNER_DEMO_TIER_KEYS)[number];
export declare const PARTNER_LAND_CLEARING_TIER_KEYS: readonly ["small_patch", "yard_section", "most_of_yard", "full_lot", "not_sure"];
export type PartnerLandClearingTierKey = (typeof PARTNER_LAND_CLEARING_TIER_KEYS)[number];
export declare function isPartnerAllowedServiceKey(value: string): value is PartnerServiceKey;
export declare function isPartnerJunkTierKey(value: string): value is PartnerJunkTierKey;
export declare function isPartnerJunkBaseTierKey(value: string): value is PartnerJunkBaseTierKey;
export declare function isPartnerDemoTierKey(value: string): value is PartnerDemoTierKey;
export declare function isPartnerLandClearingTierKey(value: string): value is PartnerLandClearingTierKey;
export declare function getPartnerServiceLabel(serviceKey: string): string;
export declare function getPartnerTierLabel(serviceKey: string, tierKey: string): string;
export declare function isPartnerTierKeyForService(serviceKey: string, tierKey: string): boolean;
//# sourceMappingURL=partner-catalog.d.ts.map