import { z } from "zod";
import type { AppointmentBookingDetails } from "@/db/schema";

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
  });

const pricingSchema = z
  .object({
    mode: priceModeSchema,
    rangeMinCents: z.number().int().nonnegative().optional().nullable(),
    rangeMaxCents: z.number().int().nonnegative().optional().nullable(),
  })
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
  });

const loadSizeSchema = z
  .object({
    kind: loadSizeKindSchema,
    customLoads: z.number().positive().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "custom" && value.customLoads == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custom_loads_required",
      });
    }
  });

const landClearingSchema = z.object({
  areaScope: z.string().trim().min(1).max(240),
  accessDifficulty: landClearingAccessSchema,
  haulAway: z.boolean(),
});

const demolitionSchema = z.object({
  demoType: demolitionTypeSchema,
  scopeSize: z.string().trim().min(1).max(240),
  haulAway: z.boolean(),
});

const rentalDumpsterSchema = z.object({
  dumpsterSize: dumpsterSizeSchema,
  pickupDate: z.string().trim().min(1).max(64),
  placementLocation: z.string().trim().min(1).max(240),
});

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
        source: value.source,
        pricing: value.pricing,
        loadSize: value.loadSize,
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
        source: value.source,
        pricing: value.pricing,
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
        source: value.source,
        pricing: value.pricing,
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
      source: value.source,
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
