import type { PartnerLocation } from "./portal-v2";

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
