import { z } from "zod";
export declare const contactSchema: z.ZodObject<{
    firstName: z.ZodString;
    lastName: z.ZodString;
    email: z.ZodOptional<z.ZodString>;
    phone: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    firstName: string;
    lastName: string;
    phone?: string | undefined;
    email?: string | undefined;
}, {
    firstName: string;
    lastName: string;
    phone?: string | undefined;
    email?: string | undefined;
}>;
export declare const propertySchema: z.ZodObject<{
    addressLine1: z.ZodString;
    addressLine2: z.ZodOptional<z.ZodString>;
    city: z.ZodString;
    state: z.ZodString;
    postalCode: z.ZodString;
    propertyType: z.ZodDefault<z.ZodEnum<["residential", "commercial"]>>;
}, "strip", z.ZodTypeAny, {
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
    propertyType: "residential" | "commercial";
    addressLine2?: string | undefined;
}, {
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
    addressLine2?: string | undefined;
    propertyType?: "residential" | "commercial" | undefined;
}>;
export declare const leadSourceSchema: z.ZodObject<{
    service: z.ZodString;
    notes: z.ZodOptional<z.ZodString>;
    utm: z.ZodOptional<z.ZodObject<{
        source: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        medium: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        campaign: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        term: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        content: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        source?: string | undefined;
        medium?: string | undefined;
        campaign?: string | undefined;
        term?: string | undefined;
        content?: string | undefined;
    }, {
        source?: string | undefined;
        medium?: string | undefined;
        campaign?: string | undefined;
        term?: string | undefined;
        content?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    service: string;
    notes?: string | undefined;
    utm?: {
        source?: string | undefined;
        medium?: string | undefined;
        campaign?: string | undefined;
        term?: string | undefined;
        content?: string | undefined;
    } | undefined;
}, {
    service: string;
    notes?: string | undefined;
    utm?: {
        source?: string | undefined;
        medium?: string | undefined;
        campaign?: string | undefined;
        term?: string | undefined;
        content?: string | undefined;
    } | undefined;
}>;
export declare const leadIntakeRequestSchema: z.ZodObject<{
    contact: z.ZodObject<{
        firstName: z.ZodString;
        lastName: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        phone: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        firstName: string;
        lastName: string;
        phone?: string | undefined;
        email?: string | undefined;
    }, {
        firstName: string;
        lastName: string;
        phone?: string | undefined;
        email?: string | undefined;
    }>;
    property: z.ZodObject<{
        addressLine1: z.ZodString;
        addressLine2: z.ZodOptional<z.ZodString>;
        city: z.ZodString;
        state: z.ZodString;
        postalCode: z.ZodString;
        propertyType: z.ZodDefault<z.ZodEnum<["residential", "commercial"]>>;
    }, "strip", z.ZodTypeAny, {
        addressLine1: string;
        city: string;
        state: string;
        postalCode: string;
        propertyType: "residential" | "commercial";
        addressLine2?: string | undefined;
    }, {
        addressLine1: string;
        city: string;
        state: string;
        postalCode: string;
        addressLine2?: string | undefined;
        propertyType?: "residential" | "commercial" | undefined;
    }>;
    lead: z.ZodObject<{
        service: z.ZodString;
        notes: z.ZodOptional<z.ZodString>;
        utm: z.ZodOptional<z.ZodObject<{
            source: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            medium: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            campaign: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            term: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            content: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, "strip", z.ZodTypeAny, {
            source?: string | undefined;
            medium?: string | undefined;
            campaign?: string | undefined;
            term?: string | undefined;
            content?: string | undefined;
        }, {
            source?: string | undefined;
            medium?: string | undefined;
            campaign?: string | undefined;
            term?: string | undefined;
            content?: string | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        service: string;
        notes?: string | undefined;
        utm?: {
            source?: string | undefined;
            medium?: string | undefined;
            campaign?: string | undefined;
            term?: string | undefined;
            content?: string | undefined;
        } | undefined;
    }, {
        service: string;
        notes?: string | undefined;
        utm?: {
            source?: string | undefined;
            medium?: string | undefined;
            campaign?: string | undefined;
            term?: string | undefined;
            content?: string | undefined;
        } | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    contact: {
        firstName: string;
        lastName: string;
        phone?: string | undefined;
        email?: string | undefined;
    };
    property: {
        addressLine1: string;
        city: string;
        state: string;
        postalCode: string;
        propertyType: "residential" | "commercial";
        addressLine2?: string | undefined;
    };
    lead: {
        service: string;
        notes?: string | undefined;
        utm?: {
            source?: string | undefined;
            medium?: string | undefined;
            campaign?: string | undefined;
            term?: string | undefined;
            content?: string | undefined;
        } | undefined;
    };
}, {
    contact: {
        firstName: string;
        lastName: string;
        phone?: string | undefined;
        email?: string | undefined;
    };
    property: {
        addressLine1: string;
        city: string;
        state: string;
        postalCode: string;
        addressLine2?: string | undefined;
        propertyType?: "residential" | "commercial" | undefined;
    };
    lead: {
        service: string;
        notes?: string | undefined;
        utm?: {
            source?: string | undefined;
            medium?: string | undefined;
            campaign?: string | undefined;
            term?: string | undefined;
            content?: string | undefined;
        } | undefined;
    };
}>;
export declare const leadIntakeResponseSchema: z.ZodObject<{
    leadId: z.ZodString;
    status: z.ZodLiteral<"received">;
}, "strip", z.ZodTypeAny, {
    status: "received";
    leadId: string;
}, {
    status: "received";
    leadId: string;
}>;
export declare const quoteRequestSchema: z.ZodObject<{
    contactId: z.ZodOptional<z.ZodString>;
    propertyId: z.ZodOptional<z.ZodString>;
    service: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    surfaceArea: z.ZodOptional<z.ZodNumber>;
    utm: z.ZodOptional<z.ZodOptional<z.ZodObject<{
        source: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        medium: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        campaign: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        term: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        content: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        source?: string | undefined;
        medium?: string | undefined;
        campaign?: string | undefined;
        term?: string | undefined;
        content?: string | undefined;
    }, {
        source?: string | undefined;
        medium?: string | undefined;
        campaign?: string | undefined;
        term?: string | undefined;
        content?: string | undefined;
    }>>>;
}, "strip", z.ZodTypeAny, {
    service: string;
    contactId?: string | undefined;
    propertyId?: string | undefined;
    utm?: {
        source?: string | undefined;
        medium?: string | undefined;
        campaign?: string | undefined;
        term?: string | undefined;
        content?: string | undefined;
    } | undefined;
    description?: string | undefined;
    surfaceArea?: number | undefined;
}, {
    service: string;
    contactId?: string | undefined;
    propertyId?: string | undefined;
    utm?: {
        source?: string | undefined;
        medium?: string | undefined;
        campaign?: string | undefined;
        term?: string | undefined;
        content?: string | undefined;
    } | undefined;
    description?: string | undefined;
    surfaceArea?: number | undefined;
}>;
export declare const quoteResponseSchema: z.ZodObject<{
    quoteId: z.ZodString;
    status: z.ZodEnum<["pending-review", "priced", "needs-info"]>;
    estimatedTotal: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    status: "pending-review" | "priced" | "needs-info";
    quoteId: string;
    estimatedTotal?: number | undefined;
}, {
    status: "pending-review" | "priced" | "needs-info";
    quoteId: string;
    estimatedTotal?: number | undefined;
}>;
export declare const payDepositRequestSchema: z.ZodObject<{
    quoteId: z.ZodString;
    amount: z.ZodNumber;
    customerEmail: z.ZodString;
    successUrl: z.ZodString;
    cancelUrl: z.ZodString;
}, "strip", z.ZodTypeAny, {
    quoteId: string;
    amount: number;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
}, {
    quoteId: string;
    amount: number;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
}>;
export declare const payDepositResponseSchema: z.ZodObject<{
    paymentLink: z.ZodString;
    expiresAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    expiresAt: string;
    paymentLink: string;
}, {
    expiresAt: string;
    paymentLink: string;
}>;
export type LeadIntakeRequest = z.infer<typeof leadIntakeRequestSchema>;
export type LeadIntakeResponse = z.infer<typeof leadIntakeResponseSchema>;
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type QuoteResponse = z.infer<typeof quoteResponseSchema>;
export type PayDepositRequest = z.infer<typeof payDepositRequestSchema>;
export type PayDepositResponse = z.infer<typeof payDepositResponseSchema>;
//# sourceMappingURL=schemas.d.ts.map