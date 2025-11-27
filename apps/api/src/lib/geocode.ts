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
  const apiKey = process.env["MAPBOX_ACCESS_TOKEN"];
  if (!apiKey) return null;

  const parts = [input.addressLine1, input.city, input.state, input.postalCode]
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
    // ignore errors; return null
  }

  return null;
}
