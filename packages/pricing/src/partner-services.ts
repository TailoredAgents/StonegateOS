import { z } from "zod";

/** New request choices. Historical land-clearing and demolition aliases remain legacy-only. */
export const PARTNER_SERVICE_KEYS = [
  "junk-removal",
  "pressure-washing",
  "soft-washing",
  "brush-clearing",
  "demolition-only",
  "demo-hauloff",
  "painting",
  "drywall-repair-paint",
] as const;
export const PartnerServiceKeyV2Schema = z.enum(PARTNER_SERVICE_KEYS);
export type PartnerServiceKeyV2 = z.infer<typeof PartnerServiceKeyV2Schema>;
export const PartnerQuoteRequiredServicesSchema = z
  .array(PartnerServiceKeyV2Schema)
  .max(PARTNER_SERVICE_KEYS.length)
  .refine(
    (keys) => new Set(keys).size === keys.length,
    "Choose each quote-required service only once.",
  );
export type PartnerServiceScopeField = {
  key: string;
  label: string;
  type: "text" | "choice";
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
};
export type PartnerServiceDefinition = {
  key: PartnerServiceKeyV2;
  label: string;
  description: string;
  variants: readonly { key: string; label: string }[];
  scopeFields: readonly PartnerServiceScopeField[];
  inclusions: readonly string[];
  removalRelated: boolean;
};
const unknown = { value: "not_sure", label: "Not sure" };
const field = (
  key: string,
  label: string,
  placeholder = "Not sure is fine",
): PartnerServiceScopeField => ({ key, label, type: "text", placeholder });
const choice = (
  key: string,
  label: string,
  options: { value: string; label: string }[],
): PartnerServiceScopeField => ({ key, label, type: "choice", options });
const standard = [{ key: "standard", label: "Standard work" }];

export const PARTNER_SERVICE_DEFINITIONS: readonly PartnerServiceDefinition[] =
  [
    {
      key: "junk-removal",
      label: "Junk removal",
      description: "Remove unwanted items and materials.",
      variants: standard,
      removalRelated: true,
      inclusions: ["Loading and disposal as described in your service rates."],
      scopeFields: [
        field(
          "approximateAmount",
          "Approximate amount",
          "For example, a sofa and two chairs, or Not sure",
        ),
      ],
    },
    {
      key: "pressure-washing",
      label: "Pressure washing",
      description: "Clean suitable outdoor surfaces with pressurized water.",
      variants: standard,
      removalRelated: false,
      inclusions: [],
      scopeFields: [
        field(
          "surfaces",
          "Surfaces to clean",
          "For example, a driveway or concrete walkway",
        ),
        field("approximateArea", "Approximate surface size (optional)"),
      ],
    },
    {
      key: "soft-washing",
      label: "Soft washing",
      description:
        "Clean building exteriors or roofs with a low-pressure treatment.",
      variants: [
        { key: "building", label: "Building exterior" },
        { key: "roof", label: "Roof" },
      ],
      removalRelated: false,
      inclusions: [],
      scopeFields: [
        choice("washArea", "What needs cleaning?", [
          { value: "building", label: "Building exterior" },
          { value: "roof", label: "Roof" },
          { value: "both", label: "Building and roof" },
          unknown,
        ]),
        field("approximateArea", "Approximate surface size (optional)"),
        field(
          "material",
          "Surface material (optional)",
          "For example, vinyl siding or shingles",
        ),
      ],
    },
    {
      key: "brush-clearing",
      label: "Brush clearing",
      description: "Clear unwanted brush and remove the cut material.",
      variants: standard,
      removalRelated: true,
      inclusions: ["Hauloff of the cleared brush is included."],
      scopeFields: [
        field("approximateArea", "Approximate area (optional)"),
        choice("growth", "Growth", [
          { value: "light", label: "Light" },
          { value: "moderate", label: "Moderate" },
          { value: "dense", label: "Dense" },
          unknown,
        ]),
        field(
          "preserveItems",
          "What should remain? (optional)",
          "For example, marked trees or landscaping",
        ),
      ],
    },
    {
      key: "demolition-only",
      label: "Demolition",
      description: "Take down the agreed structure; debris remains on-site.",
      variants: standard,
      removalRelated: false,
      inclusions: [
        "Debris remains on-site. Choose Demolition and hauloff if it should be removed.",
      ],
      scopeFields: [
        field(
          "target",
          "What should be removed?",
          "For example, a shed, deck, or interior wall",
        ),
        field("approximateDimensions", "Approximate dimensions (optional)"),
        field(
          "preserveItems",
          "What should remain? (optional)",
          "List any nearby items or surfaces to protect",
        ),
      ],
    },
    {
      key: "demo-hauloff",
      label: "Demolition and hauloff",
      description: "Take down the agreed structure and remove its debris.",
      variants: standard,
      removalRelated: true,
      inclusions: [
        "Removal and disposal of the demolition debris are included, subject to your agreed material exclusions.",
      ],
      scopeFields: [
        field(
          "target",
          "What should be removed?",
          "For example, a shed, deck, or interior wall",
        ),
        field("approximateDimensions", "Approximate dimensions (optional)"),
        field(
          "preserveItems",
          "What should remain? (optional)",
          "List any nearby items or surfaces to protect",
        ),
      ],
    },
    {
      key: "painting",
      label: "Painting",
      description: "Repaint or touch up interior or exterior surfaces.",
      variants: [
        { key: "interior", label: "Interior" },
        { key: "exterior", label: "Exterior" },
      ],
      removalRelated: false,
      inclusions: [],
      scopeFields: [
        choice("workArea", "Work area", [
          { value: "interior", label: "Interior" },
          { value: "exterior", label: "Exterior" },
          { value: "both", label: "Interior and exterior" },
          unknown,
        ]),
        field(
          "surfaces",
          "Rooms or surfaces",
          "For example, two bedrooms or exterior trim",
        ),
        choice("finish", "Type of work", [
          { value: "repaint", label: "Repaint" },
          { value: "touch_up", label: "Touch-up" },
          unknown,
        ]),
      ],
    },
    {
      key: "drywall-repair-paint",
      label: "Drywall repair and painting",
      description: "Repair drywall and paint the agreed area.",
      variants: [
        { key: "repaired_area", label: "Paint repaired areas" },
        { key: "full_surface", label: "Paint affected walls or ceilings" },
      ],
      removalRelated: false,
      inclusions: [
        "Painting is included for the selected repair coverage. Add Painting only for other work.",
      ],
      scopeFields: [
        choice("surface", "Repair location", [
          { value: "wall", label: "Walls" },
          { value: "ceiling", label: "Ceilings" },
          { value: "both", label: "Walls and ceilings" },
          unknown,
        ]),
        field(
          "repairSizes",
          "Approximate repair sizes (optional)",
          "For example, nail holes or a hole the size of a fist",
        ),
        field("repairCount", "Number of repairs (optional)"),
        choice("paintCoverage", "Paint coverage", [
          { value: "repaired_area", label: "Repaired areas only" },
          { value: "full_surface", label: "Full affected walls or ceilings" },
          unknown,
        ]),
      ],
    },
  ];

export function getPartnerServiceDefinition(
  key: string,
): PartnerServiceDefinition | undefined {
  return PARTNER_SERVICE_DEFINITIONS.find((service) => service.key === key);
}

const scopeValue = z.string().trim().max(2000);
const scopeSchema = z.record(scopeValue).default({});
export const PartnerServiceLineInputSchema = z
  .object({
    id: z.string().uuid(),
    serviceKey: PartnerServiceKeyV2Schema,
    description: z.string().trim().max(10000).default(""),
    scope: scopeSchema,
    selectedAddOns: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(100),
            quantity: z.number().finite().positive().max(10000),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    proofRequirements: z
      .object({
        before: z.number().int().min(0).max(100).optional(),
        after: z.number().int().min(0).max(100).optional(),
        package: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((line, context) => {
    const service = getPartnerServiceDefinition(line.serviceKey)!;
    for (const [key, value] of Object.entries(line.scope)) {
      const input = service.scopeFields.find((entry) => entry.key === key);
      if (!input)
        context.addIssue({
          code: "custom",
          path: ["scope", key],
          message: "This detail does not apply to this service.",
        });
      else if (
        input.type === "choice" &&
        value !== "" &&
        !input.options?.some((option) => option.value === value)
      )
        context.addIssue({
          code: "custom",
          path: ["scope", key],
          message: "Choose one of the available answers.",
        });
    }
    if (!service.removalRelated && line.selectedAddOns.length)
      context.addIssue({
        code: "custom",
        path: ["selectedAddOns"],
        message: "Removal extras do not apply to this service.",
      });
  });
export type PartnerServiceLineInput = z.infer<
  typeof PartnerServiceLineInputSchema
>;
export const PartnerServiceLinesInputSchema = z
  .array(PartnerServiceLineInputSchema)
  .max(8)
  .superRefine((lines, context) => {
    if (new Set(lines.map((line) => line.id)).size !== lines.length)
      context.addIssue({
        code: "custom",
        message: "Each service must have its own identifier.",
      });
    if (new Set(lines.map((line) => line.serviceKey)).size !== lines.length)
      context.addIssue({
        code: "custom",
        message: "Choose each service only once.",
      });
  });

export const PartnerServiceRateUnitSchema = z.enum([
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
]);
export const PARTNER_SERVICE_RATE_UNIT_LABELS: Record<
  z.infer<typeof PartnerServiceRateUnitSchema>,
  string
> = {
  job: "job",
  item: "item",
  load: "defined load",
  sq_ft: "square foot",
  linear_ft: "linear foot",
  acre: "acre",
  crew_hour: "crew hour",
  crew_day: "crew day",
  room: "defined room",
  repair: "defined repair",
  door_side: "door side",
};
export const PartnerDecimalRateSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,7})(?:\.\d{1,4})?$/,
    "Enter a positive rate with up to four decimal places.",
  )
  .refine((value) => Number(value) > 0, "Enter a rate greater than zero.");
const currencyAmount = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/,
    "Enter an amount with up to two decimal places.",
  );
export const PartnerServiceRateSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
    serviceKey: PartnerServiceKeyV2Schema,
    variantKey: z.string().min(1).max(80),
    label: z.string().trim().min(1).max(160),
    unit: PartnerServiceRateUnitSchema,
    unitAmount: PartnerDecimalRateSchema,
    measurement: z
      .string()
      .trim()
      .min(1, "Describe the work and the area or size this rate covers.")
      .max(2000),
    inclusions: z.array(z.string().trim().min(1).max(1000)).min(1).max(30),
    exclusions: z.array(z.string().trim().min(1).max(1000)).max(30),
    materials: z
      .enum(["stonegate", "partner", "mixed"])
      .nullable()
      .default(null),
    coats: z.number().int().min(1).max(10).nullable().default(null),
    fullLoadCubicYards: PartnerDecimalRateSchema.nullable().default(null),
    roomMaxSquareFeet: PartnerDecimalRateSchema.nullable().optional(),
    roomMaxHeightFeet: PartnerDecimalRateSchema.nullable().optional(),
  })
  .strict()
  .superRefine((rate, context) => {
    const service = getPartnerServiceDefinition(rate.serviceKey)!;
    if (!service.variants.some((variant) => variant.key === rate.variantKey))
      context.addIssue({
        code: "custom",
        path: ["variantKey"],
        message: "Choose an offered service variant.",
      });
    if (rate.unit === "load" && !rate.fullLoadCubicYards)
      context.addIssue({
        code: "custom",
        path: ["fullLoadCubicYards"],
        message: "State the volume of a full load.",
      });
    if (rate.unit === "room") {
      for (const field of ["roomMaxSquareFeet", "roomMaxHeightFeet"] as const)
        if (!rate[field])
          context.addIssue({
            code: "custom",
            path: [field],
            message:
              field === "roomMaxSquareFeet"
                ? "Set the maximum room floor area for this package."
                : "Set the maximum ceiling height for this package.",
          });
    }
    if (
      (rate.serviceKey === "painting" ||
        rate.serviceKey === "drywall-repair-paint") &&
      (!rate.materials || !rate.coats)
    )
      context.addIssue({
        code: "custom",
        path: ["materials"],
        message:
          "State who supplies materials and how many coats are included.",
      });
  });
export type PartnerServiceRate = z.infer<typeof PartnerServiceRateSchema>;
export const PartnerServiceRateCardInputSchema = z
  .object({
    currency: z.literal("USD").default("USD"),
    visitMinimum: currencyAmount.nullable().default(null),
    effectiveFrom: z.string().datetime({ offset: true }),
    effectiveTo: z.string().datetime({ offset: true }).nullable().default(null),
    rates: z.array(PartnerServiceRateSchema).max(200),
    quoteRequiredServiceKeys: PartnerQuoteRequiredServicesSchema.optional(),
  })
  .strict()
  .superRefine((card, context) => {
    if (
      card.rates.some((rate) =>
        card.quoteRequiredServiceKeys?.includes(rate.serviceKey),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["quoteRequiredServiceKeys"],
        message: "Choose agreed rates or Quote required for each service.",
      });
    if (new Set(card.rates.map((rate) => rate.key)).size !== card.rates.length)
      context.addIssue({
        code: "custom",
        path: ["rates"],
        message: "Each rate needs a unique reference.",
      });
    if (
      card.effectiveTo &&
      Date.parse(card.effectiveTo) <= Date.parse(card.effectiveFrom)
    )
      context.addIssue({
        code: "custom",
        path: ["effectiveTo"],
        message: "The end date must follow the start date.",
      });
  });
export type PartnerServiceRateCardInput = z.infer<
  typeof PartnerServiceRateCardInputSchema
>;
export function getPartnerRateCompleteness(
  rates: readonly PartnerServiceRate[],
  quoteRequiredServiceKeys: readonly PartnerServiceKeyV2[] = [],
) {
  const missing = PARTNER_SERVICE_DEFINITIONS.filter(
    (service) => !quoteRequiredServiceKeys.includes(service.key),
  ).flatMap((service) =>
    service.variants
      .filter(
        (variant) =>
          !rates.some(
            (rate) =>
              rate.serviceKey === service.key &&
              rate.variantKey === variant.key,
          ),
      )
      .map((variant) => ({
        serviceKey: service.key,
        variantKey: variant.key,
        label:
          service.variants.length === 1
            ? service.label
            : `${service.label}: ${variant.label}`,
      })),
  );
  return { complete: missing.length === 0, missing };
}

/** Exact positive decimal multiplication; round only the final result, half-up to cents. */
export function multiplyPartnerRateToCents(
  unitAmount: string,
  quantity: string,
): number {
  const decimal = (value: string) => {
    if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,4})?$/.test(value))
      throw new Error("Invalid decimal amount");
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole + fraction.padEnd(4, "0"));
  };
  const result = (decimal(unitAmount) * decimal(quantity) + 500000n) / 1000000n;
  if (result > 2147483647n)
    throw new Error("Amount exceeds supported currency limit");
  return Number(result);
}
