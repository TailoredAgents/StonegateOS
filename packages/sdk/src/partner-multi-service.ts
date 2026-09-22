import { z } from "zod";
import {
  PartnerServiceLineInputSchema,
  PartnerServiceRateSchema,
} from "@myst-os/pricing";

export const partnerServiceRateSnapshotSchema = z.object({
  versionId: z.string().nullable(),
  currency: z.string(),
  visitMinimum: z.string().nullable(),
  rates: z.array(PartnerServiceRateSchema),
  status: z.enum(["published", "missing", "hidden"]),
});
export const partnerRequestServiceLineSchema = z.object({
  id: z.string().uuid(),
  serviceKey: z.string(),
  label: z.string(),
  description: z.string(),
  scope: z.record(z.string()),
  selectedAddOns: z.array(
    z.object({ key: z.string(), quantity: z.number().finite() }),
  ),
  proofRequirements: z.object({
    before: z.number().optional(),
    after: z.number().optional(),
    package: z.boolean().optional(),
  }),
  status: z.enum(["pending", "in_progress", "completed", "canceled"]),
  rateSnapshot: partnerServiceRateSnapshotSchema.nullable(),
  pricingSnapshot: partnerServiceRateSnapshotSchema.nullable(),
  currentRateSnapshot: partnerServiceRateSnapshotSchema.nullable().optional(),
  quotedAmountCents: z.number().int().nonnegative().nullable(),
  priceDescription: z.string().nullable(),
  photoEvidenceIds: z.array(z.string().uuid()).optional(),
});
export const partnerRequestVisitSchema = z.object({
  id: z.string().uuid(),
  appointmentId: z.string().uuid(),
  status: z.enum(["scheduled", "in_progress", "completed", "canceled"]),
  serviceLineIds: z.array(z.string().uuid()).min(1),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().nullable(),
  arrivalStartAt: z.string().datetime().nullable(),
  arrivalEndAt: z.string().datetime().nullable(),
  timezone: z.string(),
  version: z.number().int().positive(),
  minimumAmountCents: z.number().int().nonnegative().nullable(),
});
export const partnerMultiServiceRequestSchema = z.object({
  modelVersion: z.literal(2),
  version: z.number().int().positive(),
  pricingVersion: z.number().int().positive(),
  quotedTotalCents: z.number().int().nonnegative().nullable(),
  finalTotalCents: z.number().int().nonnegative().nullable(),
  serviceLines: z.array(partnerRequestServiceLineSchema).min(1).max(8),
  visits: z.array(partnerRequestVisitSchema),
  unscheduledServiceLineIds: z.array(z.string().uuid()).optional(),
});
export type PartnerMultiServiceRequest = z.infer<
  typeof partnerMultiServiceRequestSchema
>;
export type PartnerRequestServiceLine = z.infer<
  typeof partnerRequestServiceLineSchema
>;
export type PartnerRequestVisit = z.infer<typeof partnerRequestVisitSchema>;
export { PartnerServiceLineInputSchema };
