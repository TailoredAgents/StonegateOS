import type { PartnerLocation } from "./portal-v2";
import { z } from "zod";

const nullableText = z.string().nullable();
const locationSchema = z.object({
  id: z.string(),
  timezone: z.string().optional(),
  siteName: nullableText,
  externalPropertyId: nullableText,
  address: z.object({
    line1: z.string(),
    line2: nullableText,
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
  }),
  access: z.object({
    details: nullableText,
    parking: nullableText,
    loading: nullableText,
    hasSecret: z.boolean().optional(),
  }),
  onSiteContact: z.record(z.unknown()).nullable(),
  portfolio: z.object({
    isDefault: z.boolean(),
    isFavorite: z.boolean(),
    parentLocationId: nullableText,
    childCount: z.number().int().nonnegative(),
    directoryVersion: z.number().int().nullable(),
    mergedIntoLocationId: nullableText,
    mergedAt: nullableText,
  }),
  addressVerification: z.object({
    status: z.string(),
    provider: z.string(),
    confidence: z.number().nullable(),
    suggestedAddress: z
      .object({
        line1: nullableText,
        line2: nullableText,
        city: nullableText,
        state: nullableText,
        postalCode: nullableText,
      })
      .nullable(),
    verifiedAt: nullableText,
  }),
  serviceArea: z.object({ status: z.string(), reason: nullableText }),
  active: z.boolean(),
  revision: z.number().int(),
  etag: z.string(),
  updatedAt: z.string(),
});

export function isPartnerLocation(value: unknown): value is PartnerLocation {
  return locationSchema.safeParse(value).success;
}

export function parseLocationDirectory(payload: unknown): {
  locations: PartnerLocation[];
  nextCursor: string | null;
  etag: string;
} | null {
  const parsed = z
    .object({
      ok: z.literal(true),
      locations: z.array(locationSchema),
      directory: z.object({ etag: z.string().min(1) }),
      page: z.object({ nextCursor: z.string().nullable() }),
    })
    .safeParse(payload);
  if (!parsed.success) return null;
  return {
    locations: parsed.data.locations,
    nextCursor: parsed.data.page.nextCursor,
    etag: parsed.data.directory.etag,
  };
}

const locationValidationSchema = z.object({
  status: z.enum(["verified", "review_required", "duplicate"]),
  verification: z.object({
    status: z.enum(["verified", "suggested_correction", "review_required"]),
    suggestedAddress: z
      .object({
        addressLine1: z.string(),
        addressLine2: nullableText,
        city: z.string(),
        state: z.string(),
        postalCode: z.string(),
      })
      .nullable(),
  }),
  duplicates: z.array(
    z.object({ id: z.string(), siteName: z.string(), confidence: z.number() }),
  ),
  canCreateForReview: z.boolean(),
});

export function parseLocationValidation(payload: unknown) {
  const result = z
    .object({ ok: z.literal(true), validation: locationValidationSchema })
    .safeParse(payload);
  return result.success ? result.data.validation : null;
}

export type BookingLocation = {
  id: string;
  name: string;
  address: string;
  serviceAreaStatus?: string;
  timezone?: string;
  isDefault?: boolean;
  isFavorite?: boolean;
  contact?: { name: string; phone: string; email: string };
  accessDetails?: string;
};

export function toBookingLocation(location: PartnerLocation): BookingLocation {
  const text = (key: string): string => {
    const value = location.onSiteContact?.[key];
    return typeof value === "string" ? value : "";
  };
  return {
    id: location.id,
    name: location.siteName?.trim() || location.address.line1,
    address: [
      location.address.line1,
      location.address.line2,
      `${location.address.city}, ${location.address.state} ${location.address.postalCode}`,
    ]
      .filter(Boolean)
      .join(", "),
    serviceAreaStatus: location.serviceArea.status,
    timezone: location.timezone ?? "America/New_York",
    isDefault: location.portfolio?.isDefault ?? false,
    isFavorite: location.portfolio?.isFavorite ?? false,
    contact: { name: text("name"), phone: text("phone"), email: text("email") },
    // Private access secrets are deliberately absent from this DTO.
    accessDetails: [
      location.access.details,
      location.access.parking ? `Parking: ${location.access.parking}` : null,
      location.access.loading ? `Loading: ${location.access.loading}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function sortBookingLocations(
  locations: BookingLocation[],
): BookingLocation[] {
  return [...locations].sort(
    (a, b) =>
      Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
      Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite)) ||
      a.name.localeCompare(b.name),
  );
}
