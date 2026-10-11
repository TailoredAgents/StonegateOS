import { z } from "zod";
/** Staff-safe submitted request data. Private location secrets are excluded. */
export declare const partnerRequestDetailsSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    multiService: z.ZodOptional<z.ZodObject<{
        modelVersion: z.ZodLiteral<2>;
        version: z.ZodNumber;
        pricingVersion: z.ZodNumber;
        quotedTotalCents: z.ZodNullable<z.ZodNumber>;
        finalTotalCents: z.ZodNullable<z.ZodNumber>;
        serviceLines: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            serviceKey: z.ZodString;
            label: z.ZodString;
            description: z.ZodString;
            scope: z.ZodRecord<z.ZodString, z.ZodString>;
            selectedAddOns: z.ZodArray<z.ZodObject<{
                key: z.ZodString;
                quantity: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                key: string;
                quantity: number;
            }, {
                key: string;
                quantity: number;
            }>, "many">;
            proofRequirements: z.ZodObject<{
                before: z.ZodOptional<z.ZodNumber>;
                after: z.ZodOptional<z.ZodNumber>;
                package: z.ZodOptional<z.ZodBoolean>;
            }, "strip", z.ZodTypeAny, {
                before?: number | undefined;
                after?: number | undefined;
                package?: boolean | undefined;
            }, {
                before?: number | undefined;
                after?: number | undefined;
                package?: boolean | undefined;
            }>;
            status: z.ZodEnum<["pending", "in_progress", "completed", "canceled"]>;
            rateSnapshot: z.ZodNullable<z.ZodObject<{
                versionId: z.ZodNullable<z.ZodString>;
                currency: z.ZodString;
                visitMinimum: z.ZodNullable<z.ZodString>;
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                status: z.ZodEnum<["published", "quote_required", "missing", "hidden"]>;
            }, "strip", z.ZodTypeAny, {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            }, {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            }>>;
            pricingSnapshot: z.ZodNullable<z.ZodObject<{
                versionId: z.ZodNullable<z.ZodString>;
                currency: z.ZodString;
                visitMinimum: z.ZodNullable<z.ZodString>;
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                status: z.ZodEnum<["published", "quote_required", "missing", "hidden"]>;
            }, "strip", z.ZodTypeAny, {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            }, {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            }>>;
            currentRateSnapshot: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                versionId: z.ZodNullable<z.ZodString>;
                currency: z.ZodString;
                visitMinimum: z.ZodNullable<z.ZodString>;
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                status: z.ZodEnum<["published", "quote_required", "missing", "hidden"]>;
            }, "strip", z.ZodTypeAny, {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            }, {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            }>>>;
            quotedAmountCents: z.ZodNullable<z.ZodNumber>;
            priceDescription: z.ZodNullable<z.ZodString>;
            photoEvidenceIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            status: "pending" | "in_progress" | "completed" | "canceled";
            description: string;
            serviceKey: string;
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
            label: string;
            rateSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            pricingSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            quotedAmountCents: number | null;
            priceDescription: string | null;
            currentRateSnapshot?: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null | undefined;
            photoEvidenceIds?: string[] | undefined;
        }, {
            id: string;
            status: "pending" | "in_progress" | "completed" | "canceled";
            description: string;
            serviceKey: string;
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
            label: string;
            rateSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            pricingSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            quotedAmountCents: number | null;
            priceDescription: string | null;
            currentRateSnapshot?: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null | undefined;
            photoEvidenceIds?: string[] | undefined;
        }>, "many">;
        visits: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            appointmentId: z.ZodString;
            status: z.ZodEnum<["scheduled", "in_progress", "completed", "canceled"]>;
            serviceLineIds: z.ZodArray<z.ZodString, "many">;
            startAt: z.ZodString;
            endAt: z.ZodNullable<z.ZodString>;
            arrivalStartAt: z.ZodNullable<z.ZodString>;
            arrivalEndAt: z.ZodNullable<z.ZodString>;
            timezone: z.ZodString;
            version: z.ZodNumber;
            minimumAmountCents: z.ZodNullable<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            version: number;
            id: string;
            appointmentId: string;
            startAt: string;
            status: "in_progress" | "completed" | "canceled" | "scheduled";
            serviceLineIds: string[];
            endAt: string | null;
            arrivalStartAt: string | null;
            arrivalEndAt: string | null;
            timezone: string;
            minimumAmountCents: number | null;
        }, {
            version: number;
            id: string;
            appointmentId: string;
            startAt: string;
            status: "in_progress" | "completed" | "canceled" | "scheduled";
            serviceLineIds: string[];
            endAt: string | null;
            arrivalStartAt: string | null;
            arrivalEndAt: string | null;
            timezone: string;
            minimumAmountCents: number | null;
        }>, "many">;
        unscheduledServiceLineIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        version: number;
        quotedTotalCents: number | null;
        modelVersion: 2;
        pricingVersion: number;
        finalTotalCents: number | null;
        serviceLines: {
            id: string;
            status: "pending" | "in_progress" | "completed" | "canceled";
            description: string;
            serviceKey: string;
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
            label: string;
            rateSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            pricingSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            quotedAmountCents: number | null;
            priceDescription: string | null;
            currentRateSnapshot?: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null | undefined;
            photoEvidenceIds?: string[] | undefined;
        }[];
        visits: {
            version: number;
            id: string;
            appointmentId: string;
            startAt: string;
            status: "in_progress" | "completed" | "canceled" | "scheduled";
            serviceLineIds: string[];
            endAt: string | null;
            arrivalStartAt: string | null;
            arrivalEndAt: string | null;
            timezone: string;
            minimumAmountCents: number | null;
        }[];
        unscheduledServiceLineIds?: string[] | undefined;
    }, {
        version: number;
        quotedTotalCents: number | null;
        modelVersion: 2;
        pricingVersion: number;
        finalTotalCents: number | null;
        serviceLines: {
            id: string;
            status: "pending" | "in_progress" | "completed" | "canceled";
            description: string;
            serviceKey: string;
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
            label: string;
            rateSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            pricingSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            quotedAmountCents: number | null;
            priceDescription: string | null;
            currentRateSnapshot?: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null | undefined;
            photoEvidenceIds?: string[] | undefined;
        }[];
        visits: {
            version: number;
            id: string;
            appointmentId: string;
            startAt: string;
            status: "in_progress" | "completed" | "canceled" | "scheduled";
            serviceLineIds: string[];
            endAt: string | null;
            arrivalStartAt: string | null;
            arrivalEndAt: string | null;
            timezone: string;
            minimumAmountCents: number | null;
        }[];
        unscheduledServiceLineIds?: string[] | undefined;
    }>>;
    jobId: z.ZodString;
    accountId: z.ZodString;
    accountName: z.ZodString;
    service: z.ZodObject<{
        key: z.ZodNullable<z.ZodString>;
        label: z.ZodString;
        tierKey: z.ZodNullable<z.ZodString>;
        tierLabel: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        key: string | null;
        label: string;
        tierKey: string | null;
        tierLabel: string | null;
    }, {
        key: string | null;
        label: string;
        tierKey: string | null;
        tierLabel: string | null;
    }>;
    publicStatus: z.ZodString;
    confirmationMode: z.ZodString;
    originalJob: z.ZodNullable<z.ZodObject<{
        jobId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        jobId: string;
    }, {
        jobId: string;
    }>>;
    visibility: z.ZodObject<{
        financials: z.ZodBoolean;
        photos: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        financials: boolean;
        photos: boolean;
    }, {
        financials: boolean;
        photos: boolean;
    }>;
    location: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        externalPropertyId: z.ZodNullable<z.ZodString>;
        timezone: z.ZodString;
        address: z.ZodObject<{
            line1: z.ZodString;
            line2: z.ZodNullable<z.ZodString>;
            city: z.ZodString;
            state: z.ZodString;
            postalCode: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            city: string;
            state: string;
            postalCode: string;
            line1: string;
            line2: string | null;
        }, {
            city: string;
            state: string;
            postalCode: string;
            line1: string;
            line2: string | null;
        }>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        timezone: string;
        name: string;
        externalPropertyId: string | null;
        address: {
            city: string;
            state: string;
            postalCode: string;
            line1: string;
            line2: string | null;
        };
    }, {
        id: string;
        timezone: string;
        name: string;
        externalPropertyId: string | null;
        address: {
            city: string;
            state: string;
            postalCode: string;
            line1: string;
            line2: string | null;
        };
    }>>;
    description: z.ZodNullable<z.ZodString>;
    onSiteContact: z.ZodNullable<z.ZodObject<{
        name: z.ZodNullable<z.ZodString>;
        phone: z.ZodNullable<z.ZodString>;
        email: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        phone: string | null;
        email: string | null;
        name: string | null;
    }, {
        phone: string | null;
        email: string | null;
        name: string | null;
    }>>;
    alternateContact: z.ZodNullable<z.ZodObject<{
        name: z.ZodNullable<z.ZodString>;
        phone: z.ZodNullable<z.ZodString>;
        email: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        phone: string | null;
        email: string | null;
        name: string | null;
    }, {
        phone: string | null;
        email: string | null;
        name: string | null;
    }>>;
    accessDetails: z.ZodNullable<z.ZodString>;
    crewInstructions: z.ZodNullable<z.ZodString>;
    scope: z.ZodObject<{
        itemCount: z.ZodNullable<z.ZodNumber>;
        volumeCubicYards: z.ZodNullable<z.ZodNumber>;
        restrictedItems: z.ZodBoolean;
        nonStandard: z.ZodBoolean;
        hazardCategories: z.ZodArray<z.ZodString, "many">;
        equipmentNeeds: z.ZodArray<z.ZodString, "many">;
        requiredCompletion: z.ZodNullable<z.ZodObject<{
            localDate: z.ZodString;
            localTime: z.ZodNullable<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            localDate: string;
            localTime: string | null;
        }, {
            localDate: string;
            localTime: string | null;
        }>>;
        multiStop: z.ZodBoolean;
        multiStopDetails: z.ZodNullable<z.ZodString>;
        additionalFields: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            value: z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>;
        }, "strip", z.ZodTypeAny, {
            key: string;
            value: string | number | boolean;
        }, {
            key: string;
            value: string | number | boolean;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        itemCount: number | null;
        volumeCubicYards: number | null;
        restrictedItems: boolean;
        nonStandard: boolean;
        hazardCategories: string[];
        equipmentNeeds: string[];
        requiredCompletion: {
            localDate: string;
            localTime: string | null;
        } | null;
        multiStop: boolean;
        multiStopDetails: string | null;
        additionalFields: {
            key: string;
            value: string | number | boolean;
        }[];
    }, {
        itemCount: number | null;
        volumeCubicYards: number | null;
        restrictedItems: boolean;
        nonStandard: boolean;
        hazardCategories: string[];
        equipmentNeeds: string[];
        requiredCompletion: {
            localDate: string;
            localTime: string | null;
        } | null;
        multiStop: boolean;
        multiStopDetails: string | null;
        additionalFields: {
            key: string;
            value: string | number | boolean;
        }[];
    }>;
    addOns: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        label: z.ZodString;
        unitLabel: z.ZodString;
        quantity: z.ZodNumber;
        unitAmountMinor: z.ZodNullable<z.ZodNumber>;
        lineTotalMinor: z.ZodNullable<z.ZodNumber>;
        currency: z.ZodNullable<z.ZodString>;
        requiresReview: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        key: string;
        quantity: number;
        label: string;
        currency: string | null;
        unitLabel: string;
        unitAmountMinor: number | null;
        lineTotalMinor: number | null;
        requiresReview: boolean;
    }, {
        key: string;
        quantity: number;
        label: string;
        currency: string | null;
        unitLabel: string;
        unitAmountMinor: number | null;
        lineTotalMinor: number | null;
        requiresReview: boolean;
    }>, "many">;
    commercial: z.ZodObject<{
        poNumber: z.ZodNullable<z.ZodString>;
        costCenter: z.ZodNullable<z.ZodString>;
        projectReference: z.ZodNullable<z.ZodString>;
        billingContact: z.ZodNullable<z.ZodObject<{
            name: z.ZodNullable<z.ZodString>;
            email: z.ZodNullable<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            email: string | null;
            name: string | null;
        }, {
            email: string | null;
            name: string | null;
        }>>;
    }, "strip", z.ZodTypeAny, {
        poNumber: string | null;
        costCenter: string | null;
        projectReference: string | null;
        billingContact: {
            email: string | null;
            name: string | null;
        } | null;
    }, {
        poNumber: string | null;
        costCenter: string | null;
        projectReference: string | null;
        billingContact: {
            email: string | null;
            name: string | null;
        } | null;
    }>;
    proof: z.ZodObject<{
        before: z.ZodNullable<z.ZodNumber>;
        after: z.ZodNullable<z.ZodNumber>;
        package: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        before: number | null;
        after: number | null;
        package: boolean;
    }, {
        before: number | null;
        after: number | null;
        package: boolean;
    }>;
    scheduling: z.ZodObject<{
        timezone: z.ZodNullable<z.ZodString>;
        preferredWindows: z.ZodArray<z.ZodObject<{
            localDate: z.ZodString;
            timeOfDay: z.ZodEnum<["morning", "afternoon", "anytime"]>;
            timezone: z.ZodNullable<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            timezone: string | null;
            localDate: string;
            timeOfDay: "morning" | "afternoon" | "anytime";
        }, {
            timezone: string | null;
            localDate: string;
            timeOfDay: "morning" | "afternoon" | "anytime";
        }>, "many">;
        requestedWindow: z.ZodNullable<z.ZodObject<{
            startAt: z.ZodString;
            endAt: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            startAt: string;
            endAt: string;
        }, {
            startAt: string;
            endAt: string;
        }>>;
        confirmedWindow: z.ZodNullable<z.ZodObject<{
            startAt: z.ZodString;
            endAt: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            startAt: string;
            endAt: string;
        }, {
            startAt: string;
            endAt: string;
        }>>;
        confirmedStartAt: z.ZodNullable<z.ZodString>;
        assistancePreference: z.ZodEnum<["none", "waitlist", "callback"]>;
    }, "strip", z.ZodTypeAny, {
        timezone: string | null;
        preferredWindows: {
            timezone: string | null;
            localDate: string;
            timeOfDay: "morning" | "afternoon" | "anytime";
        }[];
        requestedWindow: {
            startAt: string;
            endAt: string;
        } | null;
        confirmedWindow: {
            startAt: string;
            endAt: string;
        } | null;
        confirmedStartAt: string | null;
        assistancePreference: "none" | "waitlist" | "callback";
    }, {
        timezone: string | null;
        preferredWindows: {
            timezone: string | null;
            localDate: string;
            timeOfDay: "morning" | "afternoon" | "anytime";
        }[];
        requestedWindow: {
            startAt: string;
            endAt: string;
        } | null;
        confirmedWindow: {
            startAt: string;
            endAt: string;
        } | null;
        confirmedStartAt: string | null;
        assistancePreference: "none" | "waitlist" | "callback";
    }>;
    photos: z.ZodObject<{
        count: z.ZodNumber;
        detailPath: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        count: number;
        detailPath: string | null;
    }, {
        count: number;
        detailPath: string | null;
    }>;
}, "strip", z.ZodTypeAny, {
    service: {
        key: string | null;
        label: string;
        tierKey: string | null;
        tierLabel: string | null;
    };
    version: 1;
    commercial: {
        poNumber: string | null;
        costCenter: string | null;
        projectReference: string | null;
        billingContact: {
            email: string | null;
            name: string | null;
        } | null;
    };
    description: string | null;
    scope: {
        itemCount: number | null;
        volumeCubicYards: number | null;
        restrictedItems: boolean;
        nonStandard: boolean;
        hazardCategories: string[];
        equipmentNeeds: string[];
        requiredCompletion: {
            localDate: string;
            localTime: string | null;
        } | null;
        multiStop: boolean;
        multiStopDetails: string | null;
        additionalFields: {
            key: string;
            value: string | number | boolean;
        }[];
    };
    accountId: string;
    accountName: string;
    jobId: string;
    publicStatus: string;
    confirmationMode: string;
    originalJob: {
        jobId: string;
    } | null;
    visibility: {
        financials: boolean;
        photos: boolean;
    };
    photos: {
        count: number;
        detailPath: string | null;
    };
    location: {
        id: string;
        timezone: string;
        name: string;
        externalPropertyId: string | null;
        address: {
            city: string;
            state: string;
            postalCode: string;
            line1: string;
            line2: string | null;
        };
    } | null;
    onSiteContact: {
        phone: string | null;
        email: string | null;
        name: string | null;
    } | null;
    alternateContact: {
        phone: string | null;
        email: string | null;
        name: string | null;
    } | null;
    accessDetails: string | null;
    crewInstructions: string | null;
    addOns: {
        key: string;
        quantity: number;
        label: string;
        currency: string | null;
        unitLabel: string;
        unitAmountMinor: number | null;
        lineTotalMinor: number | null;
        requiresReview: boolean;
    }[];
    proof: {
        before: number | null;
        after: number | null;
        package: boolean;
    };
    scheduling: {
        timezone: string | null;
        preferredWindows: {
            timezone: string | null;
            localDate: string;
            timeOfDay: "morning" | "afternoon" | "anytime";
        }[];
        requestedWindow: {
            startAt: string;
            endAt: string;
        } | null;
        confirmedWindow: {
            startAt: string;
            endAt: string;
        } | null;
        confirmedStartAt: string | null;
        assistancePreference: "none" | "waitlist" | "callback";
    };
    multiService?: {
        version: number;
        quotedTotalCents: number | null;
        modelVersion: 2;
        pricingVersion: number;
        finalTotalCents: number | null;
        serviceLines: {
            id: string;
            status: "pending" | "in_progress" | "completed" | "canceled";
            description: string;
            serviceKey: string;
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
            label: string;
            rateSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            pricingSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            quotedAmountCents: number | null;
            priceDescription: string | null;
            currentRateSnapshot?: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null | undefined;
            photoEvidenceIds?: string[] | undefined;
        }[];
        visits: {
            version: number;
            id: string;
            appointmentId: string;
            startAt: string;
            status: "in_progress" | "completed" | "canceled" | "scheduled";
            serviceLineIds: string[];
            endAt: string | null;
            arrivalStartAt: string | null;
            arrivalEndAt: string | null;
            timezone: string;
            minimumAmountCents: number | null;
        }[];
        unscheduledServiceLineIds?: string[] | undefined;
    } | undefined;
}, {
    service: {
        key: string | null;
        label: string;
        tierKey: string | null;
        tierLabel: string | null;
    };
    version: 1;
    commercial: {
        poNumber: string | null;
        costCenter: string | null;
        projectReference: string | null;
        billingContact: {
            email: string | null;
            name: string | null;
        } | null;
    };
    description: string | null;
    scope: {
        itemCount: number | null;
        volumeCubicYards: number | null;
        restrictedItems: boolean;
        nonStandard: boolean;
        hazardCategories: string[];
        equipmentNeeds: string[];
        requiredCompletion: {
            localDate: string;
            localTime: string | null;
        } | null;
        multiStop: boolean;
        multiStopDetails: string | null;
        additionalFields: {
            key: string;
            value: string | number | boolean;
        }[];
    };
    accountId: string;
    accountName: string;
    jobId: string;
    publicStatus: string;
    confirmationMode: string;
    originalJob: {
        jobId: string;
    } | null;
    visibility: {
        financials: boolean;
        photos: boolean;
    };
    photos: {
        count: number;
        detailPath: string | null;
    };
    location: {
        id: string;
        timezone: string;
        name: string;
        externalPropertyId: string | null;
        address: {
            city: string;
            state: string;
            postalCode: string;
            line1: string;
            line2: string | null;
        };
    } | null;
    onSiteContact: {
        phone: string | null;
        email: string | null;
        name: string | null;
    } | null;
    alternateContact: {
        phone: string | null;
        email: string | null;
        name: string | null;
    } | null;
    accessDetails: string | null;
    crewInstructions: string | null;
    addOns: {
        key: string;
        quantity: number;
        label: string;
        currency: string | null;
        unitLabel: string;
        unitAmountMinor: number | null;
        lineTotalMinor: number | null;
        requiresReview: boolean;
    }[];
    proof: {
        before: number | null;
        after: number | null;
        package: boolean;
    };
    scheduling: {
        timezone: string | null;
        preferredWindows: {
            timezone: string | null;
            localDate: string;
            timeOfDay: "morning" | "afternoon" | "anytime";
        }[];
        requestedWindow: {
            startAt: string;
            endAt: string;
        } | null;
        confirmedWindow: {
            startAt: string;
            endAt: string;
        } | null;
        confirmedStartAt: string | null;
        assistancePreference: "none" | "waitlist" | "callback";
    };
    multiService?: {
        version: number;
        quotedTotalCents: number | null;
        modelVersion: 2;
        pricingVersion: number;
        finalTotalCents: number | null;
        serviceLines: {
            id: string;
            status: "pending" | "in_progress" | "completed" | "canceled";
            description: string;
            serviceKey: string;
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
            label: string;
            rateSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            pricingSnapshot: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null;
            quotedAmountCents: number | null;
            priceDescription: string | null;
            currentRateSnapshot?: {
                status: "missing" | "published" | "quote_required" | "hidden";
                currency: string;
                visitMinimum: string | null;
                rates: {
                    key: string;
                    serviceKey: "junk-removal" | "pressure-washing" | "soft-washing" | "brush-clearing" | "demolition-only" | "demo-hauloff" | "painting" | "drywall-repair-paint";
                    variantKey: string;
                    label: string;
                    unit: "item" | "job" | "load" | "sq_ft" | "linear_ft" | "acre" | "crew_hour" | "crew_day" | "room" | "repair" | "door_side";
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
                versionId: string | null;
            } | null | undefined;
            photoEvidenceIds?: string[] | undefined;
        }[];
        visits: {
            version: number;
            id: string;
            appointmentId: string;
            startAt: string;
            status: "in_progress" | "completed" | "canceled" | "scheduled";
            serviceLineIds: string[];
            endAt: string | null;
            arrivalStartAt: string | null;
            arrivalEndAt: string | null;
            timezone: string;
            minimumAmountCents: number | null;
        }[];
        unscheduledServiceLineIds?: string[] | undefined;
    } | undefined;
}>;
export type PartnerRequestDetails = z.infer<typeof partnerRequestDetailsSchema>;
export declare const partnerRequestPhotoSchema: z.ZodObject<{
    id: z.ZodString;
    category: z.ZodString;
    caption: z.ZodString;
    status: z.ZodString;
    url: z.ZodNullable<z.ZodString>;
    filename: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    status: string;
    category: string;
    caption: string;
    url: string | null;
    filename?: string | null | undefined;
}, {
    id: string;
    status: string;
    category: string;
    caption: string;
    url: string | null;
    filename?: string | null | undefined;
}>;
export type PartnerRequestPhoto = z.infer<typeof partnerRequestPhotoSchema>;
export declare function parsePartnerRequestPhotos(value: unknown): PartnerRequestPhoto[] | null;
export declare function parsePartnerRequestDetails(value: unknown): PartnerRequestDetails | null;
//# sourceMappingURL=partner-request-details.d.ts.map