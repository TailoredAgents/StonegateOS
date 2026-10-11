import { z } from "zod";
/** New request choices. Historical land-clearing and demolition aliases remain legacy-only. */
export declare const PARTNER_SERVICE_KEYS: readonly ["junk-removal", "pressure-washing", "soft-washing", "brush-clearing", "demolition-only", "demo-hauloff", "painting", "drywall-repair-paint"];
export declare const PartnerServiceKeyV2Schema: z.ZodEnum<["junk-removal", "pressure-washing", "soft-washing", "brush-clearing", "demolition-only", "demo-hauloff", "painting", "drywall-repair-paint"]>;
export type PartnerServiceKeyV2 = z.infer<typeof PartnerServiceKeyV2Schema>;
export declare const PartnerQuoteRequiredServicesSchema: z.ZodEffects<z.ZodArray<z.ZodEnum<["junk-removal", "pressure-washing", "soft-washing", "brush-clearing", "demolition-only", "demo-hauloff", "painting", "drywall-repair-paint"]>, "many">, ("junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint")[], ("junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint")[]>;
export type PartnerServiceScopeField = {
    key: string;
    label: string;
    type: "text" | "choice";
    options?: readonly {
        value: string;
        label: string;
    }[];
    placeholder?: string;
};
export type PartnerServiceDefinition = {
    key: PartnerServiceKeyV2;
    label: string;
    description: string;
    variants: readonly {
        key: string;
        label: string;
    }[];
    scopeFields: readonly PartnerServiceScopeField[];
    inclusions: readonly string[];
    removalRelated: boolean;
};
export declare const PARTNER_SERVICE_DEFINITIONS: readonly PartnerServiceDefinition[];
export declare function getPartnerServiceDefinition(key: string): PartnerServiceDefinition | undefined;
export declare const PartnerServiceLineInputSchema: z.ZodEffects<z.ZodObject<{
    id: z.ZodString;
    serviceKey: z.ZodEnum<["junk-removal", "pressure-washing", "soft-washing", "brush-clearing", "demolition-only", "demo-hauloff", "painting", "drywall-repair-paint"]>;
    description: z.ZodDefault<z.ZodString>;
    scope: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    selectedAddOns: z.ZodDefault<z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        quantity: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        key: string;
        quantity: number;
    }, {
        key: string;
        quantity: number;
    }>, "many">>;
    proofRequirements: z.ZodDefault<z.ZodObject<{
        before: z.ZodOptional<z.ZodNumber>;
        after: z.ZodOptional<z.ZodNumber>;
        package: z.ZodOptional<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    }, {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    id: string;
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    description: string;
    scope: Record<string, string>;
    selectedAddOns: {
        key: string;
        quantity: number;
    }[];
    proofRequirements: {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    };
}, {
    id: string;
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    description?: string | undefined;
    scope?: Record<string, string> | undefined;
    selectedAddOns?: {
        key: string;
        quantity: number;
    }[] | undefined;
    proofRequirements?: {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    } | undefined;
}>, {
    id: string;
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    description: string;
    scope: Record<string, string>;
    selectedAddOns: {
        key: string;
        quantity: number;
    }[];
    proofRequirements: {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    };
}, {
    id: string;
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    description?: string | undefined;
    scope?: Record<string, string> | undefined;
    selectedAddOns?: {
        key: string;
        quantity: number;
    }[] | undefined;
    proofRequirements?: {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    } | undefined;
}>;
export type PartnerServiceLineInput = z.infer<typeof PartnerServiceLineInputSchema>;
export declare const PartnerServiceLinesInputSchema: z.ZodEffects<z.ZodArray<z.ZodEffects<z.ZodObject<{
    id: z.ZodString;
    serviceKey: z.ZodEnum<["junk-removal", "pressure-washing", "soft-washing", "brush-clearing", "demolition-only", "demo-hauloff", "painting", "drywall-repair-paint"]>;
    description: z.ZodDefault<z.ZodString>;
    scope: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    selectedAddOns: z.ZodDefault<z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        quantity: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        key: string;
        quantity: number;
    }, {
        key: string;
        quantity: number;
    }>, "many">>;
    proofRequirements: z.ZodDefault<z.ZodObject<{
        before: z.ZodOptional<z.ZodNumber>;
        after: z.ZodOptional<z.ZodNumber>;
        package: z.ZodOptional<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    }, {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    id: string;
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    description: string;
    scope: Record<string, string>;
    selectedAddOns: {
        key: string;
        quantity: number;
    }[];
    proofRequirements: {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    };
}, {
    id: string;
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    description?: string | undefined;
    scope?: Record<string, string> | undefined;
    selectedAddOns?: {
        key: string;
        quantity: number;
    }[] | undefined;
    proofRequirements?: {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    } | undefined;
}>, {
    id: string;
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    description: string;
    scope: Record<string, string>;
    selectedAddOns: {
        key: string;
        quantity: number;
    }[];
    proofRequirements: {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    };
}, {
    id: string;
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    description?: string | undefined;
    scope?: Record<string, string> | undefined;
    selectedAddOns?: {
        key: string;
        quantity: number;
    }[] | undefined;
    proofRequirements?: {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    } | undefined;
}>, "many">, {
    id: string;
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    description: string;
    scope: Record<string, string>;
    selectedAddOns: {
        key: string;
        quantity: number;
    }[];
    proofRequirements: {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    };
}[], {
    id: string;
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    description?: string | undefined;
    scope?: Record<string, string> | undefined;
    selectedAddOns?: {
        key: string;
        quantity: number;
    }[] | undefined;
    proofRequirements?: {
        before?: number | undefined;
        after?: number | undefined;
        package?: boolean | undefined;
    } | undefined;
}[]>;
export declare const PartnerServiceRateUnitSchema: z.ZodEnum<["job", "item", "load", "sq_ft", "linear_ft", "acre", "crew_hour", "crew_day", "room", "repair", "door_side"]>;
export declare const PARTNER_SERVICE_RATE_UNIT_LABELS: Record<z.infer<typeof PartnerServiceRateUnitSchema>, string>;
export declare const PartnerDecimalRateSchema: z.ZodEffects<z.ZodString, string, string>;
export declare const PartnerServiceRateSchema: z.ZodEffects<z.ZodObject<{
    key: z.ZodString;
    serviceKey: z.ZodEnum<["junk-removal", "pressure-washing", "soft-washing", "brush-clearing", "demolition-only", "demo-hauloff", "painting", "drywall-repair-paint"]>;
    variantKey: z.ZodString;
    label: z.ZodString;
    unit: z.ZodEnum<["job", "item", "load", "sq_ft", "linear_ft", "acre", "crew_hour", "crew_day", "room", "repair", "door_side"]>;
    unitAmount: z.ZodEffects<z.ZodString, string, string>;
    measurement: z.ZodString;
    inclusions: z.ZodArray<z.ZodString, "many">;
    exclusions: z.ZodArray<z.ZodString, "many">;
    materials: z.ZodDefault<z.ZodNullable<z.ZodEnum<["stonegate", "partner", "mixed"]>>>;
    coats: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    fullLoadCubicYards: z.ZodDefault<z.ZodNullable<z.ZodEffects<z.ZodString, string, string>>>;
    roomMaxSquareFeet: z.ZodOptional<z.ZodNullable<z.ZodEffects<z.ZodString, string, string>>>;
    roomMaxHeightFeet: z.ZodOptional<z.ZodNullable<z.ZodEffects<z.ZodString, string, string>>>;
}, "strict", z.ZodTypeAny, {
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    key: string;
    variantKey: string;
    label: string;
    unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
    unitAmount: string;
    measurement: string;
    inclusions: string[];
    exclusions: string[];
    materials: "stonegate" | "partner" | "mixed" | null;
    coats: number | null;
    fullLoadCubicYards: string | null;
    roomMaxSquareFeet?: string | null | undefined;
    roomMaxHeightFeet?: string | null | undefined;
}, {
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    key: string;
    variantKey: string;
    label: string;
    unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
    unitAmount: string;
    measurement: string;
    inclusions: string[];
    exclusions: string[];
    materials?: "stonegate" | "partner" | "mixed" | null | undefined;
    coats?: number | null | undefined;
    fullLoadCubicYards?: string | null | undefined;
    roomMaxSquareFeet?: string | null | undefined;
    roomMaxHeightFeet?: string | null | undefined;
}>, {
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    key: string;
    variantKey: string;
    label: string;
    unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
    unitAmount: string;
    measurement: string;
    inclusions: string[];
    exclusions: string[];
    materials: "stonegate" | "partner" | "mixed" | null;
    coats: number | null;
    fullLoadCubicYards: string | null;
    roomMaxSquareFeet?: string | null | undefined;
    roomMaxHeightFeet?: string | null | undefined;
}, {
    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
    key: string;
    variantKey: string;
    label: string;
    unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
    unitAmount: string;
    measurement: string;
    inclusions: string[];
    exclusions: string[];
    materials?: "stonegate" | "partner" | "mixed" | null | undefined;
    coats?: number | null | undefined;
    fullLoadCubicYards?: string | null | undefined;
    roomMaxSquareFeet?: string | null | undefined;
    roomMaxHeightFeet?: string | null | undefined;
}>;
export type PartnerServiceRate = z.infer<typeof PartnerServiceRateSchema>;
export declare const PartnerServiceRateCardInputSchema: z.ZodEffects<z.ZodObject<{
    currency: z.ZodDefault<z.ZodLiteral<"USD">>;
    visitMinimum: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    effectiveFrom: z.ZodString;
    effectiveTo: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    rates: z.ZodArray<z.ZodEffects<z.ZodObject<{
        key: z.ZodString;
        serviceKey: z.ZodEnum<["junk-removal", "pressure-washing", "soft-washing", "brush-clearing", "demolition-only", "demo-hauloff", "painting", "drywall-repair-paint"]>;
        variantKey: z.ZodString;
        label: z.ZodString;
        unit: z.ZodEnum<["job", "item", "load", "sq_ft", "linear_ft", "acre", "crew_hour", "crew_day", "room", "repair", "door_side"]>;
        unitAmount: z.ZodEffects<z.ZodString, string, string>;
        measurement: z.ZodString;
        inclusions: z.ZodArray<z.ZodString, "many">;
        exclusions: z.ZodArray<z.ZodString, "many">;
        materials: z.ZodDefault<z.ZodNullable<z.ZodEnum<["stonegate", "partner", "mixed"]>>>;
        coats: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        fullLoadCubicYards: z.ZodDefault<z.ZodNullable<z.ZodEffects<z.ZodString, string, string>>>;
        roomMaxSquareFeet: z.ZodOptional<z.ZodNullable<z.ZodEffects<z.ZodString, string, string>>>;
        roomMaxHeightFeet: z.ZodOptional<z.ZodNullable<z.ZodEffects<z.ZodString, string, string>>>;
    }, "strict", z.ZodTypeAny, {
        serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
        key: string;
        variantKey: string;
        label: string;
        unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
        unitAmount: string;
        measurement: string;
        inclusions: string[];
        exclusions: string[];
        materials: "stonegate" | "partner" | "mixed" | null;
        coats: number | null;
        fullLoadCubicYards: string | null;
        roomMaxSquareFeet?: string | null | undefined;
        roomMaxHeightFeet?: string | null | undefined;
    }, {
        serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
        key: string;
        variantKey: string;
        label: string;
        unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
        unitAmount: string;
        measurement: string;
        inclusions: string[];
        exclusions: string[];
        materials?: "stonegate" | "partner" | "mixed" | null | undefined;
        coats?: number | null | undefined;
        fullLoadCubicYards?: string | null | undefined;
        roomMaxSquareFeet?: string | null | undefined;
        roomMaxHeightFeet?: string | null | undefined;
    }>, {
        serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
        key: string;
        variantKey: string;
        label: string;
        unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
        unitAmount: string;
        measurement: string;
        inclusions: string[];
        exclusions: string[];
        materials: "stonegate" | "partner" | "mixed" | null;
        coats: number | null;
        fullLoadCubicYards: string | null;
        roomMaxSquareFeet?: string | null | undefined;
        roomMaxHeightFeet?: string | null | undefined;
    }, {
        serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
        key: string;
        variantKey: string;
        label: string;
        unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
        unitAmount: string;
        measurement: string;
        inclusions: string[];
        exclusions: string[];
        materials?: "stonegate" | "partner" | "mixed" | null | undefined;
        coats?: number | null | undefined;
        fullLoadCubicYards?: string | null | undefined;
        roomMaxSquareFeet?: string | null | undefined;
        roomMaxHeightFeet?: string | null | undefined;
    }>, "many">;
    quoteRequiredServiceKeys: z.ZodOptional<z.ZodEffects<z.ZodArray<z.ZodEnum<["junk-removal", "pressure-washing", "soft-washing", "brush-clearing", "demolition-only", "demo-hauloff", "painting", "drywall-repair-paint"]>, "many">, ("junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint")[], ("junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint")[]>>;
}, "strict", z.ZodTypeAny, {
    currency: "USD";
    visitMinimum: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
    rates: {
        serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
        key: string;
        variantKey: string;
        label: string;
        unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
        unitAmount: string;
        measurement: string;
        inclusions: string[];
        exclusions: string[];
        materials: "stonegate" | "partner" | "mixed" | null;
        coats: number | null;
        fullLoadCubicYards: string | null;
        roomMaxSquareFeet?: string | null | undefined;
        roomMaxHeightFeet?: string | null | undefined;
    }[];
    quoteRequiredServiceKeys?: ("junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint")[] | undefined;
}, {
    effectiveFrom: string;
    rates: {
        serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
        key: string;
        variantKey: string;
        label: string;
        unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
        unitAmount: string;
        measurement: string;
        inclusions: string[];
        exclusions: string[];
        materials?: "stonegate" | "partner" | "mixed" | null | undefined;
        coats?: number | null | undefined;
        fullLoadCubicYards?: string | null | undefined;
        roomMaxSquareFeet?: string | null | undefined;
        roomMaxHeightFeet?: string | null | undefined;
    }[];
    currency?: "USD" | undefined;
    visitMinimum?: string | null | undefined;
    effectiveTo?: string | null | undefined;
    quoteRequiredServiceKeys?: ("junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint")[] | undefined;
}>, {
    currency: "USD";
    visitMinimum: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
    rates: {
        serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
        key: string;
        variantKey: string;
        label: string;
        unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
        unitAmount: string;
        measurement: string;
        inclusions: string[];
        exclusions: string[];
        materials: "stonegate" | "partner" | "mixed" | null;
        coats: number | null;
        fullLoadCubicYards: string | null;
        roomMaxSquareFeet?: string | null | undefined;
        roomMaxHeightFeet?: string | null | undefined;
    }[];
    quoteRequiredServiceKeys?: ("junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint")[] | undefined;
}, {
    effectiveFrom: string;
    rates: {
        serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
        key: string;
        variantKey: string;
        label: string;
        unit: "job" | "item" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
        unitAmount: string;
        measurement: string;
        inclusions: string[];
        exclusions: string[];
        materials?: "stonegate" | "partner" | "mixed" | null | undefined;
        coats?: number | null | undefined;
        fullLoadCubicYards?: string | null | undefined;
        roomMaxSquareFeet?: string | null | undefined;
        roomMaxHeightFeet?: string | null | undefined;
    }[];
    currency?: "USD" | undefined;
    visitMinimum?: string | null | undefined;
    effectiveTo?: string | null | undefined;
    quoteRequiredServiceKeys?: ("junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint")[] | undefined;
}>;
export type PartnerServiceRateCardInput = z.infer<typeof PartnerServiceRateCardInputSchema>;
export declare function getPartnerRateCompleteness(rates: readonly PartnerServiceRate[], quoteRequiredServiceKeys?: readonly PartnerServiceKeyV2[]): {
    complete: boolean;
    missing: {
        serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
        variantKey: string;
        label: string;
    }[];
};
/** Exact positive decimal multiplication; round only the final result, half-up to cents. */
export declare function multiplyPartnerRateToCents(unitAmount: string, quantity: string): number;
//# sourceMappingURL=partner-services.d.ts.map