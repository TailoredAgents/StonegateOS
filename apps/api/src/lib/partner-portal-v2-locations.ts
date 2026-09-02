import { z } from "zod";
import type { partnerAccountLocations } from "@/db";
import { createPortalV2StrongEtag } from "@/lib/portal-v2-contract";

const UuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

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
  locale: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u)
    .optional(),
  access: AccessSchema.optional(),
  accessSecret: z.string().trim().min(1).max(2_000).nullable().optional(),
  onSiteContact: OnSiteContactSchema.nullable().optional(),
  parentLocationId: UuidSchema.nullable().optional(),
  makeDefault: z.boolean().optional(),
} as const;

export const PartnerLocationCreateSchema = z
  .object({
    ...CommonLocationFields,
    requestAddressReview: z.boolean().optional(),
  })
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
    parentLocationId: CommonLocationFields.parentLocationId,
    makeDefault: CommonLocationFields.makeDefault,
    requestAddressReview: z.boolean().optional(),
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

export const PartnerLocationArchiveSchema = z
  .object({
    replacementDefaultLocationId: UuidSchema.nullable().optional(),
    childDisposition: z.enum(["promote", "move"]).optional(),
    replacementParentLocationId: UuidSchema.nullable().optional(),
    reason: z.string().trim().min(5).max(500),
    confirmation: z.literal("ARCHIVE LOCATION"),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.childDisposition === "move" &&
      !value.replacementParentLocationId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replacementParentLocationId"],
        message: "Choose a replacement parent.",
      });
    }
    if (
      value.childDisposition !== "move" &&
      value.replacementParentLocationId !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replacementParentLocationId"],
        message: "A replacement parent is only valid when moving children.",
      });
    }
  });

export const PartnerLocationFavoriteSchema = z
  .object({ favorite: z.boolean() })
  .strict();

export const PartnerLocationValidateSchema = z
  .object({
    address: AddressSchema,
    externalPropertyId: optionalTrimmed(100),
    excludeLocationId: UuidSchema.optional(),
  })
  .strict();

export const PartnerLocationMergeSchema = z
  .object({
    targetLocationId: UuidSchema,
    reason: z.string().trim().min(5).max(500),
    confirmation: z.literal("MERGE DUPLICATE LOCATION"),
  })
  .strict();

export const PartnerLocationUnmergeSchema = z
  .object({
    reason: z.string().trim().min(5).max(500),
    confirmation: z.literal("RESTORE MERGED LOCATION"),
  })
  .strict();

export const PartnerLocationImportDryRunSchema = z
  .object({ csv: z.string().min(1).max(262_144) })
  .strict();

export const PartnerLocationImportCommitSchema = z
  .object({
    confirmation: z
      .string()
      .trim()
      .regex(/^IMPORT [1-9][0-9]{0,2} LOCATIONS$/u),
  })
  .strict();

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

export function createPartnerLocationDto(
  row: PartnerLocationRecord,
  portfolio?: Readonly<{
    defaultLocationId?: string | null;
    favoriteLocationIds?: ReadonlySet<string>;
    childCount?: number;
    directoryVersion?: number;
    includeHierarchy?: boolean;
  }>,
) {
  const suggestion =
    row.addressVerificationSuggestion &&
    typeof row.addressVerificationSuggestion === "object"
      ? row.addressVerificationSuggestion
      : null;
  const suggestedAddress = suggestion
    ? {
        line1:
          typeof suggestion["addressLine1"] === "string"
            ? suggestion["addressLine1"]
            : null,
        line2:
          typeof suggestion["addressLine2"] === "string"
            ? suggestion["addressLine2"]
            : null,
        city:
          typeof suggestion["city"] === "string" ? suggestion["city"] : null,
        state:
          typeof suggestion["state"] === "string"
            ? suggestion["state"]
            : null,
        postalCode:
          typeof suggestion["postalCode"] === "string"
            ? suggestion["postalCode"]
            : null,
      }
    : null;
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
    portfolio: {
      isDefault: portfolio?.defaultLocationId === row.id,
      isFavorite: portfolio?.favoriteLocationIds?.has(row.id) ?? false,
      parentLocationId: portfolio?.includeHierarchy
        ? row.parentLocationId
        : null,
      childCount: portfolio?.childCount ?? 0,
      directoryVersion: portfolio?.directoryVersion ?? null,
      mergedIntoLocationId: row.mergedIntoLocationId,
      mergedAt: row.mergedAt?.toISOString() ?? null,
    },
    addressVerification: {
      status: row.addressVerificationStatus,
      provider: row.addressVerificationProvider,
      confidence: row.addressVerificationConfidence,
      suggestedAddress,
      verifiedAt: row.addressVerifiedAt?.toISOString() ?? null,
    },
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
