type SiteRecord = {
  id: string;
  siteName: string;
  externalPropertyId: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  timezone: string;
};

/** Immutable public site identity only: no gate codes, coordinates, or access secrets. */
export function partnerJobLocationSnapshot(location: SiteRecord) {
  return {
    id: location.id,
    name: location.siteName,
    externalPropertyId: location.externalPropertyId,
    address: {
      line1: location.addressLine1,
      line2: location.addressLine2,
      city: location.city,
      state: location.state,
      postalCode: location.postalCode,
    },
    timezone: location.timezone,
  };
}

export function readPartnerJobLocationSnapshot(
  scope: unknown,
): ReturnType<typeof partnerJobLocationSnapshot> | null {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const value = (scope as Record<string, unknown>)["locationSnapshot"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const address = row["address"] as Record<string, unknown> | undefined;
  if (
    typeof row["id"] !== "string" ||
    typeof row["name"] !== "string" ||
    typeof row["timezone"] !== "string" ||
    !address ||
    typeof address !== "object" ||
    ["line1", "city", "state", "postalCode"].some(
      (key) => typeof address[key] !== "string",
    )
  )
    return null;
  return {
    id: row["id"],
    name: row["name"],
    externalPropertyId:
      typeof row["externalPropertyId"] === "string"
        ? row["externalPropertyId"]
        : null,
    timezone: row["timezone"],
    address: {
      line1: address["line1"] as string,
      line2: typeof address["line2"] === "string" ? address["line2"] : null,
      city: address["city"] as string,
      state: address["state"] as string,
      postalCode: address["postalCode"] as string,
    },
  };
}
