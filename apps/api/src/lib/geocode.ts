type GeocodeInput = {
  addressLine1: string;
  city?: string;
  state?: string;
  postalCode?: string;
};

export type GeocodeResult = {
  lat: number;
  lng: number;
} | null;

export async function forwardGeocode(input: GeocodeInput): Promise<GeocodeResult> {
  const apiKey = process.env["GOOGLE_MAPS_API_KEY"] ?? process.env["GOOGLE_GEOCODING_API_KEY"];
  if (!apiKey) return null;

  const parts = [input.addressLine1, input.city, input.state, input.postalCode]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(", ");
  if (!parts.length) return null;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(parts)}&key=${apiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
      status?: string;
    };
    const loc = data.results?.[0]?.geometry?.location;
    if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch {
    // ignore errors; return null
  }

  return null;
}
