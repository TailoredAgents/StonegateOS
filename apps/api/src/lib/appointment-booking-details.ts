import { z } from "zod";
import type { AppointmentBookingDetails } from "@/db/schema";

const sourceTypeSchema = z.enum([
  "google",
  "facebook",
  "team_member",
  "referral",
]);
const priceModeSchema = z.enum(["range", "exact", "both"]);
const loadSizeKindSchema = z.enum([
  "quarter_to_half",
  "half_to_three_quarters",
  "three_quarters_to_full",
  "custom",
]);

export const appointmentBookingDetailsSchema = z
  .object({
    source: z
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
      }),
    pricing: z
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
      }),
    loadSize: z
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
      }),
  })
  .strict();

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
