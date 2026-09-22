import { z } from "zod";
import {
  getPartnerServiceDefinition,
  PARTNER_SERVICE_RATE_UNIT_LABELS,
  PartnerServiceRateSchema,
  PartnerQuoteRequiredServicesSchema,
  type PartnerServiceRate,
} from "./partner-services";

// Drafts preserve incomplete rows, but accept only the same bounded fields as
// published rates. Required amount/measurement checks happen on publication.
export const PartnerServiceRateDraftSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/u),
    quoteRequiredServiceKeys: PartnerQuoteRequiredServicesSchema.optional(),
    visitMinimum: z.string().trim().max(30).nullable(),
    effectiveFrom: z.string().datetime({ offset: true }),
    effectiveTo: z.string().datetime({ offset: true }).nullable(),
    rates: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u),
            serviceKey: z.string().max(80),
            variantKey: z.string().max(80),
            label: z.string().trim().max(160),
            unit: z.enum([
              "job",
              "item",
              "load",
              "sq_ft",
              "linear_ft",
              "acre",
              "crew_hour",
              "crew_day",
              "room",
              "repair",
              "door_side",
            ]),
            unitAmount: z.string().trim().max(30),
            measurement: z.string().trim().max(2000),
            inclusions: z.array(z.string().trim().max(1000)).max(30),
            exclusions: z.array(z.string().trim().max(1000)).max(30),
            materials: z.enum(["stonegate", "partner", "mixed"]).nullable(),
            coats: z.number().int().min(1).max(10).nullable(),
            fullLoadCubicYards: z.string().trim().max(30).nullable(),
            roomMaxSquareFeet: z.string().trim().max(30).nullable().optional(),
            roomMaxHeightFeet: z.string().trim().max(30).nullable().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    value.rates.forEach((rate, index) => {
      const definition = getPartnerServiceDefinition(rate.serviceKey);
      if (
        !definition ||
        !definition.variants.some((variant) => variant.key === rate.variantKey)
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rates", index, "serviceKey"],
          message: "Choose a supported service and variant.",
        });
      const key = rate.key;
      if (keys.has(key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rates", index, "key"],
          message: "Each service rate needs its own key.",
        });
      keys.add(key);
    });
  });
export const PartnerServiceRateWriteSchema = z
  .object({
    action: z.enum(["draft", "publish"]),
    portalVisible: z.boolean(),
    card: PartnerServiceRateDraftSchema,
  })
  .strict();

export type PartnerServiceRateDraft = z.infer<
  typeof PartnerServiceRateDraftSchema
>;
export type PartnerServiceRateWrite = z.infer<
  typeof PartnerServiceRateWriteSchema
>;
export const PartnerPublishedServiceRateCardSchema = z.object({
  rateCardVersionId: z.string().uuid(),
  version: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().nullable(),
  visitMinimum: z.string().nullable(),
  portalVisible: z.boolean(),
  source: z.enum(["structured", "legacy"]),
  rates: z.array(PartnerServiceRateSchema),
  quoteRequiredServiceKeys: PartnerQuoteRequiredServicesSchema.optional(),
  legacyItems: z.array(
    z.object({
      id: z.string().uuid(),
      serviceKey: z.string(),
      tierKey: z.string(),
      label: z.string().nullable(),
      amountCents: z.number().int().nonnegative(),
    }),
  ),
  complete: z.boolean(),
  missing: z.array(
    z.object({
      serviceKey: z.string(),
      variantKey: z.string(),
      label: z.string(),
    }),
  ),
});
export const PartnerServiceRateEditorSchema = z.object({
  accountId: z.string().uuid(),
  accountName: z.string(),
  revision: z.string().regex(/^[1-9][0-9]*$/u),
  draft: PartnerServiceRateDraftSchema.nullable(),
  portalVisible: z.boolean(),
  setupStatus: z.enum(["complete", "rates_required"]),
  published: PartnerPublishedServiceRateCardSchema.nullable(),
});
export type PartnerServiceRateEditorData = z.infer<
  typeof PartnerServiceRateEditorSchema
>;
export function formatPartnerServiceRate(
  rate: PartnerServiceRate,
  currency: string,
): string {
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number(rate.unitAmount));
  return `${amount} / ${PARTNER_SERVICE_RATE_UNIT_LABELS[rate.unit]}`;
}
