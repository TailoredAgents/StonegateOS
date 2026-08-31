import { z } from "zod";
import type { partnerAccountLocations } from "@/db";
import { createPortalV2StrongEtag } from "@/lib/portal-v2-contract";

const optionalTrimmed = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .transform((value) => value || null)
    .nullable()
    .optional();

const AddressSchema = z
  .object({
    line1: z.string().trim().min(3).max(200),
    line2: optionalTrimmed(100),
    city: z.string().trim().min(2).max(100),
    state: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/u)
      .transform((value) => value.toUpperCase()),
    postalCode: z.string().trim().min(3).max(16),
  })
  .strict();

const AccessSchema = z
  .object({
    details: optionalTrimmed(2_000),
    parking: optionalTrimmed(2_000),
    loading: optionalTrimmed(2_000),
  })
  .strict();

const OnSiteContactSchema = z
  .object({
    name: optionalTrimmed(120),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase())
      .nullable()
      .optional(),
    phone: optionalTrimmed(40),
  })
  .strict()
  .transform((value) => {
    const normalized = {
      name: value.name ?? null,
      email: value.email ?? null,
      phone: value.phone ?? null,
    };
    return Object.values(normalized).some(Boolean) ? normalized : null;
  });

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const CommonLocationFields = {
  siteName: z.string().trim().min(1).max(120),
  externalPropertyId: optionalTrimmed(100),
  address: AddressSchema,
  timezone: z.string().trim().max(100).refine(validTimeZone).optional(),
  locale: z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u).optional(),
  access: AccessSchema.optional(),
  accessSecret: z.string().trim().min(1).max(2_000).nullable().optional(),
  onSiteContact: OnSiteContactSchema.nullable().optional(),
} as const;

export const PartnerLocationCreateSchema = z
  .object(CommonLocationFields)
  .strict();

export const PartnerLocationUpdateSchema = z
  .object({
    siteName: CommonLocationFields.siteName.optional(),
    externalPropertyId: CommonLocationFields.externalPropertyId,
    address: CommonLocationFields.address.optional(),
    timezone: CommonLocationFields.timezone,
    locale: CommonLocationFields.locale,
    access: CommonLocationFields.access,
    accessSecret: CommonLocationFields.accessSecret,
    onSiteContact: CommonLocationFields.onSiteContact,
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be supplied.",
  });

export type PartnerLocationCreateInput = z.infer<
  typeof PartnerLocationCreateSchema
>;
export type PartnerLocationUpdateInput = z.infer<
  typeof PartnerLocationUpdateSchema
>;
export type PartnerLocationRecord = typeof partnerAccountLocations.$inferSelect;

export function partnerLocationRevision(
  row: Pick<PartnerLocationRecord, "id" | "version" | "updatedAt">,
): string {
  return `${row.id}:${row.version}:${row.updatedAt.toISOString()}`;
}

export function partnerLocationEtag(
  row: Pick<PartnerLocationRecord, "id" | "version" | "updatedAt">,
): string {
  return createPortalV2StrongEtag(partnerLocationRevision(row));
}

export function createPartnerLocationDto(row: PartnerLocationRecord) {
  return {
    id: row.id,
    siteName: row.siteName,
    externalPropertyId: row.externalPropertyId,
    address: {
      line1: row.addressLine1,
      line2: row.addressLine2,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
    },
    timezone: row.timezone,
    locale: row.locale,
    access: {
      details: row.accessInstructions,
      parking: row.parkingInstructions,
      loading: row.loadingInstructions,
      hasSecret: Boolean(row.accessSecretCiphertext),
    },
    onSiteContact: row.onSiteContact,
    serviceArea: {
      status: row.serviceAreaStatus,
      geocodeStatus: row.geocodeStatus,
      reason:
        row.serviceAreaStatus === "eligible"
          ? null
          : row.geocodeStatus === "failed"
            ? "Address verification requires staff review."
            : row.serviceAreaStatus === "outside"
              ? "This location is outside the configured service area."
              : "Service-area eligibility requires staff review.",
    },
    active: row.active,
    revision: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    etag: partnerLocationEtag(row),
  };
}
