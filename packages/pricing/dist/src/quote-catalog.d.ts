export declare const professionalQuoteServicePresets: {
    id: import("./types").ServiceCategory;
    catalogKey: string;
    name: string;
    description: string;
    unit: string;
    suggestedUnitPriceCents: number;
}[];
export declare const professionalQuoteZonePresets: {
    id: string;
    name: string;
    travelFeeCents: number;
    postalCodes: string[];
}[];
export declare const professionalQuoteBundlePresets: {
    id: string;
    adjustmentId: string;
    name: string;
    requiredCatalogKeys: string[];
    basisPoints: number;
}[];
export declare const professionalQuoteServiceCatalogKeys: Set<string>;
export declare const professionalQuoteZoneIds: Set<string>;
//# sourceMappingURL=quote-catalog.d.ts.map