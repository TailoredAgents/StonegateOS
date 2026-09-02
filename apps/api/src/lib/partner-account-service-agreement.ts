import { z } from "zod";

export const PARTNER_SERVICE_PRICING_STATES = [
  "contracted",
  "estimate",
  "quote_required",
  "standard_rate",
] as const;

export type PartnerServicePricingState =
  (typeof PARTNER_SERVICE_PRICING_STATES)[number];

export const PARTNER_AGREEMENT_TEXT_ITEM_MAXIMUM = 500;
export const PARTNER_AGREEMENT_LIST_MAXIMUM = 40;
export const PARTNER_AGREEMENT_SERVICE_MAXIMUM = 100;

const ServiceKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{1,79}$/u);
const BoundedList = z
  .array(z.string().trim().min(1).max(PARTNER_AGREEMENT_TEXT_ITEM_MAXIMUM))
  .max(PARTNER_AGREEMENT_LIST_MAXIMUM);

export const PartnerAccountServiceEntitlementSchema = z
  .object({
    serviceKey: ServiceKeySchema,
    pricingState: z.enum(PARTNER_SERVICE_PRICING_STATES),
    inclusions: BoundedList,
    exclusions: BoundedList,
    quoteRule: z.string().trim().min(1).max(1_000).nullable(),
  })
  .strict();

export const PartnerAccountServiceAgreementMutationSchema = z
  .object({
    active: z.boolean(),
    agreementLabel: z.string().trim().min(1).max(160),
    currency: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{3}$/u)),
    effectiveFrom: z.string().datetime({ offset: true }),
    effectiveTo: z.string().datetime({ offset: true }).nullable(),
    inclusions: BoundedList,
    exclusions: BoundedList,
    quoteRules: z.string().trim().min(1).max(2_000).nullable(),
    agreementDocumentId: z.string().uuid().nullable(),
    services: z
      .array(PartnerAccountServiceEntitlementSchema)
      .min(1)
      .max(PARTNER_AGREEMENT_SERVICE_MAXIMUM),
  })
  .strict()
  .superRefine((value, context) => {
    const effectiveFrom = new Date(value.effectiveFrom);
    const effectiveTo = value.effectiveTo ? new Date(value.effectiveTo) : null;
    if (effectiveTo && effectiveTo <= effectiveFrom) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveTo"],
        message: "The agreement end must be after its start.",
      });
    }
    const seen = new Set<string>();
    value.services.forEach((service, index) => {
      if (seen.has(service.serviceKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["services", index, "serviceKey"],
          message: "Each service may appear once.",
        });
      }
      seen.add(service.serviceKey);
    });
  });

export type PartnerAccountServiceEntitlement = z.infer<
  typeof PartnerAccountServiceEntitlementSchema
>;
export type PartnerAccountServiceAgreementMutation = z.infer<
  typeof PartnerAccountServiceAgreementMutationSchema
>;

export type PartnerAccountServiceAgreementRecord = Readonly<{
  partnerAccountId: string;
  active: boolean;
  agreementLabel: string;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  inclusions: readonly string[];
  exclusions: readonly string[];
  quoteRules: string | null;
  agreementDocumentId: string | null;
  services: readonly PartnerAccountServiceEntitlement[];
  revision: number;
  updatedAt: Date;
}>;

export function parsePersistedPartnerServiceEntitlements(
  value: unknown,
): readonly PartnerAccountServiceEntitlement[] | null {
  const parsed = z
    .array(PartnerAccountServiceEntitlementSchema)
    .min(1)
    .max(PARTNER_AGREEMENT_SERVICE_MAXIMUM)
    .safeParse(value);
  if (!parsed.success) return null;
  const serviceKeys = parsed.data.map((item) => item.serviceKey);
  if (new Set(serviceKeys).size !== serviceKeys.length) return null;
  return Object.freeze(parsed.data.map((item) => Object.freeze(item)));
}

export function isPartnerAgreementEffective(
  agreement: Pick<
    PartnerAccountServiceAgreementRecord,
    "active" | "effectiveFrom" | "effectiveTo"
  >,
  now: Date,
): boolean {
  return (
    agreement.active &&
    agreement.effectiveFrom <= now &&
    (!agreement.effectiveTo || agreement.effectiveTo > now)
  );
}

export function findPartnerServiceEntitlement(
  agreement: Pick<PartnerAccountServiceAgreementRecord, "services">,
  serviceKey: string,
): PartnerAccountServiceEntitlement | null {
  return (
    agreement.services.find((item) => item.serviceKey === serviceKey) ?? null
  );
}

export function partnerPricingStateRequiresRate(
  state: PartnerServicePricingState,
): boolean {
  return state !== "quote_required";
}

export function partnerPricingStateAllowsInstantConfirmation(
  state: PartnerServicePricingState,
): boolean {
  return state === "contracted";
}

export function partnerAgreementRevision(input: {
  partnerAccountId: string;
  revision: number;
  updatedAt: Date;
}): string {
  return [
    "partner-service-agreement",
    input.partnerAccountId,
    input.revision,
    input.updatedAt.toISOString(),
  ].join(":");
}
