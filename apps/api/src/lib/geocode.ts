type GeocodeInput = {
  addressLine1: string;
  addressLine2?: string | null;
  city?: string;
  state?: string;
  postalCode?: string;
};

export type GeocodeResult = {
  lat: number;
  lng: number;
} | null;

export type VerifiedAddress = Readonly<{
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
}>;

export type AddressVerificationResult = Readonly<{
  status: "verified" | "suggested_correction" | "review_required";
  provider: "mapbox" | "none";
  reasonCode:
    | "verified"
    | "provider_unavailable"
    | "low_confidence"
    | "suggested_correction";
  confidence: number | null;
  featureId: string | null;
  coordinates: Readonly<{ lat: number; lng: number }> | null;
  suggestedAddress: VerifiedAddress | null;
  changedFields: readonly ("addressLine1" | "city" | "state" | "postalCode")[];
}>;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.normalize("NFKC").replace(/\s+/gu, " ").trim()
    : null;
}

function canonicalState(value: string): string {
  const normalized = value.trim().toUpperCase();
  const separator = normalized.lastIndexOf("-");
  return (separator >= 0 ? normalized.slice(separator + 1) : normalized).slice(
    0,
    2,
  );
}

function comparableStreet(value: string): string {
  const replacements: Readonly<Record<string, string>> = Object.freeze({
    avenue: "ave",
    boulevard: "blvd",
    circle: "cir",
    court: "ct",
    drive: "dr",
    highway: "hwy",
    lane: "ln",
    parkway: "pkwy",
    place: "pl",
    road: "rd",
    square: "sq",
    street: "st",
    terrace: "ter",
    trail: "trl",
    north: "n",
    south: "s",
    east: "e",
    west: "w",
  });
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[.'’#,-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .split(" ")
    .map((token) => replacements[token] ?? token)
    .join(" ");
}

function comparableText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "")
    .trim();
}

function comparablePostal(value: string): string {
  return value
    .replace(/[^a-z0-9]/giu, "")
    .toUpperCase()
    .slice(0, 5);
}

function confidenceScore(value: unknown): number {
  switch (nonEmptyString(value)?.toLowerCase()) {
    case "exact":
      return 100;
    case "high":
      return 90;
    case "medium":
      return 70;
    case "low":
      return 40;
    default:
      return 0;
  }
}

function coordinatePair(feature: JsonRecord, properties: JsonRecord) {
  const providerCoordinates = record(properties["coordinates"]);
  const geometry = record(feature["geometry"]);
  const geometryCoordinates = Array.isArray(geometry?.["coordinates"])
    ? geometry["coordinates"]
    : null;
  const lng =
    typeof providerCoordinates?.["longitude"] === "number"
      ? providerCoordinates["longitude"]
      : typeof geometryCoordinates?.[0] === "number"
        ? geometryCoordinates[0]
        : null;
  const lat =
    typeof providerCoordinates?.["latitude"] === "number"
      ? providerCoordinates["latitude"]
      : typeof geometryCoordinates?.[1] === "number"
        ? geometryCoordinates[1]
        : null;
  return typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
    ? Object.freeze({ lat, lng })
    : null;
}

/** Converts the allow-listed Mapbox Geocoding v6 response surface into
 * provider-neutral verification evidence. Raw provider payloads are never
 * persisted or returned to the portal. */
export function parseMapboxAddressVerification(
  input: GeocodeInput,
  payload: unknown,
): AddressVerificationResult {
  const root = record(payload);
  const feature = Array.isArray(root?.["features"])
    ? record(root["features"][0])
    : null;
  const properties = record(feature?.["properties"]);
  const context = record(properties?.["context"]);
  const addressContext = record(context?.["address"]);
  const placeContext = record(context?.["place"]);
  const regionContext = record(context?.["region"]);
  const postcodeContext = record(context?.["postcode"]);
  const countryContext = record(context?.["country"]);
  const featureType = nonEmptyString(properties?.["feature_type"]);
  const countryCode = nonEmptyString(countryContext?.["country_code"]);
  const coordinates =
    feature && properties ? coordinatePair(feature, properties) : null;
  const addressLine1 =
    nonEmptyString(addressContext?.["name"]) ??
    nonEmptyString(properties?.["name_preferred"]) ??
    nonEmptyString(properties?.["name"]);
  const city = nonEmptyString(placeContext?.["name"]);
  const stateValue =
    nonEmptyString(regionContext?.["region_code"]) ??
    nonEmptyString(regionContext?.["region_code_full"]);
  const postalCode = nonEmptyString(postcodeContext?.["name"]);
  const suggestion =
    addressLine1 && city && stateValue && postalCode
      ? Object.freeze({
          addressLine1,
          addressLine2: input.addressLine2?.trim() || null,
          city,
          state: canonicalState(stateValue),
          postalCode,
        })
      : null;
  const matchCode = record(properties?.["match_code"]);
  const confidence = confidenceScore(matchCode?.["confidence"]);
  const changedFields: Array<"addressLine1" | "city" | "state" | "postalCode"> =
    [];
  if (suggestion) {
    if (
      comparableStreet(input.addressLine1) !==
      comparableStreet(suggestion.addressLine1)
    ) {
      changedFields.push("addressLine1");
    }
    if (comparableText(input.city ?? "") !== comparableText(suggestion.city)) {
      changedFields.push("city");
    }
    if (canonicalState(input.state ?? "") !== suggestion.state) {
      changedFields.push("state");
    }
    if (
      comparablePostal(input.postalCode ?? "") !==
      comparablePostal(suggestion.postalCode)
    ) {
      changedFields.push("postalCode");
    }
  }
  const featureId =
    nonEmptyString(properties?.["mapbox_id"]) ??
    nonEmptyString(feature?.["id"]);
  const usResult = !countryCode || countryCode.toUpperCase() === "US";
  const addressFeature = featureType === "address";
  if (
    coordinates &&
    suggestion &&
    addressFeature &&
    usResult &&
    confidence >= 90 &&
    changedFields.length === 0
  ) {
    return Object.freeze({
      status: "verified",
      provider: "mapbox",
      reasonCode: "verified",
      confidence,
      featureId,
      coordinates,
      suggestedAddress: suggestion,
      changedFields: Object.freeze(changedFields),
    });
  }
  if (
    coordinates &&
    suggestion &&
    addressFeature &&
    usResult &&
    confidence >= 60
  ) {
    return Object.freeze({
      status: "suggested_correction",
      provider: "mapbox",
      reasonCode: "suggested_correction",
      confidence,
      featureId,
      coordinates,
      suggestedAddress: suggestion,
      changedFields: Object.freeze(changedFields),
    });
  }
  return Object.freeze({
    status: "review_required",
    provider: feature ? "mapbox" : "none",
    reasonCode: feature ? "low_confidence" : "provider_unavailable",
    confidence: confidence || null,
    featureId,
    coordinates,
    suggestedAddress: suggestion,
    changedFields: Object.freeze(changedFields),
  });
}

export async function verifyAddress(
  input: GeocodeInput,
): Promise<AddressVerificationResult> {
  const apiKey = process.env["MAPBOX_ACCESS_TOKEN"]?.trim();
  if (!apiKey) return parseMapboxAddressVerification(input, null);
  const query = [
    input.addressLine1,
    input.addressLine2,
    input.city,
    input.state,
    input.postalCode,
  ]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(", ");
  if (!query) return parseMapboxAddressVerification(input, null);
  const parameters = new URLSearchParams({
    q: query,
    access_token: apiKey,
    limit: "1",
    country: "US",
    types: "address",
    autocomplete: "false",
  });
  try {
    const response = await fetch(
      `https://api.mapbox.com/search/geocode/v6/forward?${parameters.toString()}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return parseMapboxAddressVerification(input, null);
    return parseMapboxAddressVerification(input, await response.json());
  } catch {
    return parseMapboxAddressVerification(input, null);
  }
}

/** Compatibility geocoder for non-portal surfaces. Portal locations use the
 * richer `verifyAddress` boundary so confidence and corrections cannot be
 * mistaken for a verified service address. */
export async function forwardGeocode(
  input: GeocodeInput,
): Promise<GeocodeResult> {
  const apiKey = process.env["MAPBOX_ACCESS_TOKEN"];
  if (!apiKey) return null;

  const parts = [
    input.addressLine1,
    input.addressLine2,
    input.city,
    input.state,
    input.postalCode,
  ]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(", ");
  if (!parts.length) return null;

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(parts)}.json?access_token=${apiKey}&limit=1`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      features?: Array<{ center?: [number, number] }>;
    };
    const center = data.features?.[0]?.center;
    if (Array.isArray(center) && center.length === 2) {
      const [lng, lat] = center;
      if (typeof lat === "number" && typeof lng === "number") {
        return { lat, lng };
      }
    }
  } catch {
    // Provider failures route portal work to review; compatibility callers
    // retain the existing nullable behavior.
  }

  return null;
}
