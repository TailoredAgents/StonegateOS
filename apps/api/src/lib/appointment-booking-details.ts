import { z } from "zod";
import type { AppointmentBookingDetails } from "@/db/schema";

const MAXIMUM_CENTS = 2_147_483_647;
const MAXIMUM_CUSTOM_LOADS = 100;

const sourceTypeSchema = z.enum([
  "google",
  "facebook",
  "team_member",
  "referral",
]);
const priceModeSchema = z.enum(["range", "exact", "both"]);
const serviceTypeSchema = z.enum([
  "junk_removal",
  "land_clearing",
  "demolition",
  "rental_dumpster",
]);
const loadSizeKindSchema = z.enum([
  "quarter_to_half",
  "half_to_three_quarters",
  "three_quarters_to_full",
  "custom",
]);
const landClearingAccessSchema = z.enum(["easy", "moderate", "hard"]);
const demolitionTypeSchema = z.enum([
  "shed",
  "deck",
  "fence",
  "interior",
  "concrete",
  "other",
]);
const dumpsterSizeSchema = z.enum(["10_yard", "15_yard", "20_yard"]);

const sourceSchema = z
  .object({
    type: sourceTypeSchema,
    teamMemberId: z.string().uuid().optional().nullable(),
    referralName: z.string().trim().min(1).max(120).optional().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "team_member" && !value.teamMemberId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "team_member_id_required",
      });
    }
    if (value.type === "referral" && !value.referralName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "referral_name_required",
      });
    }
    if (value.type !== "team_member" && value.teamMemberId != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["teamMemberId"],
        message: "team_member_id_not_allowed_for_source",
      });
    }
    if (value.type !== "referral" && value.referralName != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["referralName"],
        message: "referral_name_not_allowed_for_source",
      });
    }
  });

const pricingSchema = z
  .object({
    mode: priceModeSchema,
    rangeMinCents: z
      .number()
      .int()
      .min(0)
      .max(MAXIMUM_CENTS)
      .optional()
      .nullable(),
    rangeMaxCents: z
      .number()
      .int()
      .min(0)
      .max(MAXIMUM_CENTS)
      .optional()
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.mode === "range" || value.mode === "both") &&
      value.rangeMinCents == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "range_min_required",
      });
    }
    if (
      (value.mode === "range" || value.mode === "both") &&
      value.rangeMaxCents == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "range_max_required",
      });
    }
    if (
      typeof value.rangeMinCents === "number" &&
      typeof value.rangeMaxCents === "number" &&
      value.rangeMaxCents < value.rangeMinCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "range_max_must_be_greater_than_or_equal_to_min",
      });
    }
    if (
      value.mode === "exact" &&
      (value.rangeMinCents != null || value.rangeMaxCents != null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rangeMinCents"],
        message: "price_range_not_allowed_for_exact_mode",
      });
    }
  });

const loadSizeSchema = z
  .object({
    kind: loadSizeKindSchema,
    customLoads: z
      .number()
      .positive()
      .max(MAXIMUM_CUSTOM_LOADS)
      .optional()
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "custom" && value.customLoads == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custom_loads_required",
      });
    }
    if (value.kind !== "custom" && value.customLoads != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customLoads"],
        message: "custom_loads_not_allowed_for_standard_size",
      });
    }
  });

const landClearingSchema = z
  .object({
    areaScope: z.string().trim().min(1).max(240),
    accessDifficulty: landClearingAccessSchema,
    haulAway: z.boolean(),
  })
  .strict();

const demolitionSchema = z
  .object({
    demoType: demolitionTypeSchema,
    scopeSize: z.string().trim().min(1).max(240),
    haulAway: z.boolean(),
  })
  .strict();

const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "invalid_calendar_date");

const rentalDumpsterSchema = z
  .object({
    dumpsterSize: dumpsterSizeSchema,
    pickupDate: dateOnlySchema,
    placementLocation: z.string().trim().min(1).max(240),
  })
  .strict();

export const appointmentBookingDetailsSchema = z
  .object({
    serviceType: serviceTypeSchema.optional(),
    source: sourceSchema,
    pricing: pricingSchema,
    loadSize: loadSizeSchema.optional().nullable(),
    landClearing: landClearingSchema.optional().nullable(),
    demolition: demolitionSchema.optional().nullable(),
    rentalDumpster: rentalDumpsterSchema.optional().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const serviceType =
      value.serviceType ?? (value.loadSize ? "junk_removal" : undefined);
    const detailsByService = {
      junk_removal: ["landClearing", "demolition", "rentalDumpster"],
      land_clearing: ["loadSize", "demolition", "rentalDumpster"],
      demolition: ["loadSize", "landClearing", "rentalDumpster"],
      rental_dumpster: ["loadSize", "landClearing", "demolition"],
    } as const;
    if (!serviceType) return;
    for (const field of detailsByService[serviceType]) {
      if (value[field] != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field}_not_allowed_for_${serviceType}`,
        });
      }
    }
  })
  .transform((value, ctx): AppointmentBookingDetails => {
    const serviceType =
      value.serviceType ?? (value.loadSize ? "junk_removal" : undefined);

    if (!serviceType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "service_type_required",
      });
      return z.NEVER;
    }

    const source =
      value.source.type === "team_member"
        ? {
            type: "team_member" as const,
            teamMemberId: value.source.teamMemberId ?? null,
          }
        : value.source.type === "referral"
          ? {
              type: "referral" as const,
              referralName: value.source.referralName ?? null,
            }
          : { type: value.source.type };
    const pricing =
      value.pricing.mode === "exact"
        ? {
            mode: "exact" as const,
            rangeMinCents: null,
            rangeMaxCents: null,
          }
        : {
            mode: value.pricing.mode,
            rangeMinCents: value.pricing.rangeMinCents ?? null,
            rangeMaxCents: value.pricing.rangeMaxCents ?? null,
          };

    if (serviceType === "junk_removal") {
      if (!value.loadSize) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "load_size_required",
        });
        return z.NEVER;
      }

      return {
        serviceType,
        source,
        pricing,
        loadSize: {
          kind: value.loadSize.kind,
          customLoads: value.loadSize.customLoads ?? null,
        },
      };
    }

    if (serviceType === "land_clearing") {
      if (!value.landClearing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "land_clearing_details_required",
        });
        return z.NEVER;
      }

      return {
        serviceType,
        source,
        pricing,
        landClearing: value.landClearing,
      };
    }

    if (serviceType === "demolition") {
      if (!value.demolition) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "demolition_details_required",
        });
        return z.NEVER;
      }

      return {
        serviceType,
        source,
        pricing,
        demolition: value.demolition,
      };
    }

    if (value.pricing.mode !== "exact") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dumpster_price_must_be_exact",
      });
      return z.NEVER;
    }

    if (!value.rentalDumpster) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rental_dumpster_details_required",
      });
      return z.NEVER;
    }

    return {
      serviceType,
      source,
      pricing: {
        mode: "exact",
        rangeMinCents: null,
        rangeMaxCents: null,
      },
      rentalDumpster: value.rentalDumpster,
    };
  });

export function parseAppointmentBookingDetails(
  value: unknown,
): AppointmentBookingDetails | null {
  const parsed = appointmentBookingDetailsSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

export function validateQuotedTotalForBookingDetails(
  details: AppointmentBookingDetails | null,
  quotedTotalCents: number | null,
): string | null {
  if (!details) return null;
  if (
    (details.pricing.mode === "exact" || details.pricing.mode === "both") &&
    quotedTotalCents == null
  ) {
    return "exact_quote_required";
  }
  return null;
}
