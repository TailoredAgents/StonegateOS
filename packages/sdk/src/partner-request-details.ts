import { z } from "zod";
import { partnerMultiServiceRequestSchema } from "./partner-multi-service";

const text = z.string().nullable();
const number = z.number().finite().nullable();
const contact = z.object({ name: text, phone: text, email: text }).nullable();
const window = z.object({ startAt: z.string(), endAt: z.string() }).nullable();

/** Staff-safe submitted request data. Private location secrets are excluded. */
export const partnerRequestDetailsSchema = z.object({
  version: z.literal(1),
  multiService: partnerMultiServiceRequestSchema.optional(),
  jobId: z.string().min(1),
  accountId: z.string().min(1),
  accountName: z.string(),
  service: z.object({
    key: text,
    label: z.string(),
    tierKey: text,
    tierLabel: text,
  }),
  publicStatus: z.string(),
  confirmationMode: z.string(),
  originalJob: z.object({ jobId: z.string() }).nullable(),
  visibility: z.object({ financials: z.boolean(), photos: z.boolean() }),
  location: z
    .object({
      id: z.string(),
      name: z.string(),
      externalPropertyId: text,
      timezone: z.string(),
      address: z.object({
        line1: z.string(),
        line2: text,
        city: z.string(),
        state: z.string(),
        postalCode: z.string(),
      }),
    })
    .nullable(),
  description: text,
  onSiteContact: contact,
  alternateContact: contact,
  accessDetails: text,
  crewInstructions: text,
  scope: z.object({
    itemCount: number,
    volumeCubicYards: number,
    restrictedItems: z.boolean(),
    nonStandard: z.boolean(),
    hazardCategories: z.array(z.string()),
    equipmentNeeds: z.array(z.string()),
    requiredCompletion: z
      .object({ localDate: z.string(), localTime: text })
      .nullable(),
    multiStop: z.boolean(),
    multiStopDetails: text,
    additionalFields: z.array(
      z.object({
        key: z.string(),
        value: z.union([z.string(), z.number().finite(), z.boolean()]),
      }),
    ),
  }),
  addOns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      unitLabel: z.string(),
      quantity: z.number().finite(),
      unitAmountMinor: number,
      lineTotalMinor: number,
      currency: text,
      requiresReview: z.boolean(),
    }),
  ),
  commercial: z.object({
    poNumber: text,
    costCenter: text,
    projectReference: text,
    billingContact: z.object({ name: text, email: text }).nullable(),
  }),
  proof: z.object({ before: number, after: number, package: z.boolean() }),
  scheduling: z.object({
    timezone: text,
    preferredWindows: z.array(
      z.object({
        localDate: z.string(),
        timeOfDay: z.enum(["morning", "afternoon", "anytime"]),
        timezone: text,
      }),
    ),
    requestedWindow: window,
    confirmedWindow: window,
    confirmedStartAt: text,
    assistancePreference: z.enum(["none", "waitlist", "callback"]),
  }),
  photos: z.object({ count: z.number().int().nonnegative(), detailPath: text }),
});

export type PartnerRequestDetails = z.infer<typeof partnerRequestDetailsSchema>;

export const partnerRequestPhotoSchema = z.object({
  id: z.string().min(1),
  category: z.string(),
  caption: z.string(),
  status: z.string(),
  url: z.string().nullable(),
  filename: z.string().nullable().optional(),
});

export type PartnerRequestPhoto = z.infer<typeof partnerRequestPhotoSchema>;

export function parsePartnerRequestPhotos(
  value: unknown,
): PartnerRequestPhoto[] | null {
  const parsed = z.array(partnerRequestPhotoSchema).safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parsePartnerRequestDetails(
  value: unknown,
): PartnerRequestDetails | null {
  const parsed = partnerRequestDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
