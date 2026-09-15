type PropertyAddress = {
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  postalCode: string;
};

export function formatPropertyAddress(property: PropertyAddress): string {
  return [
    property.addressLine1,
    property.addressLine2,
    property.city,
    [property.state, property.postalCode].filter(Boolean).join(" "),
  ]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
}
