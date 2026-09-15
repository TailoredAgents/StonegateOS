type PropertyAddress = {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
};

function joinAddressParts(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
}

/** Keep unit and building details attached wherever a saved street is shown. */
export function formatPropertyStreet(
  property: PropertyAddress | null | undefined,
): string {
  if (!property) return "";
  return joinAddressParts([property.addressLine1, property.addressLine2]);
}

export function formatPropertyAddress(
  property: PropertyAddress | null | undefined,
): string {
  if (!property) return "";
  return joinAddressParts([
    formatPropertyStreet(property),
    property.city,
    [property.state?.trim(), property.postalCode?.trim()]
      .filter(Boolean)
      .join(" "),
  ]);
}
