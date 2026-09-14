import { createHash } from "node:crypto";
import { z } from "zod";

export const PARTNER_ADDRESS_SUGGESTION_ATTRIBUTION = "© Mapbox";
export const PARTNER_ADDRESS_SUGGESTION_LIMIT = 5;
const MAXIMUM_PROVIDER_BYTES = 64 * 1024;
const PROVIDER_TIMEOUT_MS = 5_000;

export type PartnerAddressSuggestion = Readonly<{
  id: string;
  label: string;
  address: Readonly<{
    line1: string;
    city: string;
    state: string;
    postalCode: string;
  }>;
}>;

export class PartnerAddressSuggestionsUnavailableError extends Error {
  constructor(
    readonly reason:
      | "missing_configuration"
      | "http_error"
      | "malformed_response"
      | "response_too_large"
      | "timeout"
      | "cancelled"
      | "transport_error",
    readonly providerStatus?: number,
  ) {
    super("Address suggestions are unavailable.");
    this.name = "PartnerAddressSuggestionsUnavailableError";
  }
}

export function normalizePartnerAddressSuggestionQuery(
  value: unknown,
): string | null {
  if (typeof value !== "string" || value.length > 400) return null;
  const query = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (query.length < 3 || query.length > 200 || /[;\p{Cc}\p{Cf}]/u.test(query))
    return null;
  // Mapbox accepts at most twenty words/numbers separated by punctuation.
  const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length > 0 && words.length <= 20 ? query : null;
}

const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const FeatureCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z
    .array(
      z.object({
        type: z.literal("Feature"),
        properties: z.object({
          // Interpolated v6 addresses can have long opaque IDs (observed >400).
          mapbox_id: text(2_048),
          feature_type: z.literal("address"),
          name: text(200).optional(),
          name_preferred: text(200).optional(),
          context: z.object({
            address: z.object({ name: text(200) }).optional(),
            place: z.object({ name: text(100) }),
            region: z.object({
              region_code: text(5).optional(),
              region_code_full: text(5).optional(),
            }),
            postcode: z.object({
              name: z.string().regex(/^\d{5}(?:-\d{4})?$/u),
            }),
            country: z.object({
              country_code: z
                .string()
                .transform((value) => value.toUpperCase())
                .pipe(z.literal("US")),
            }),
          }),
        }),
      }),
    )
    .max(PARTNER_ADDRESS_SUGGESTION_LIMIT),
});

/** Allowlisted display/form fields only. Provider payloads are never stored. */
export function parseMapboxAddressSuggestions(
  payload: unknown,
): PartnerAddressSuggestion[] {
  const parsed = FeatureCollectionSchema.safeParse(payload);
  if (!parsed.success)
    throw new PartnerAddressSuggestionsUnavailableError("malformed_response");
  const ids = new Set<string>();
  return parsed.data.features.map(({ properties }) => {
    const line1 =
      properties.context.address?.name ??
      properties.name_preferred ??
      properties.name;
    const region = properties.context.region;
    const state = (region.region_code ?? region.region_code_full)
      ?.toUpperCase()
      .replace(/^US-/u, "");
    if (
      !line1 ||
      !state ||
      !/^[A-Z]{2}$/u.test(state) ||
      ids.has(properties.mapbox_id)
    )
      throw new PartnerAddressSuggestionsUnavailableError("malformed_response");
    ids.add(properties.mapbox_id);
    const address = {
      line1,
      city: properties.context.place.name,
      state,
      postalCode: properties.context.postcode.name,
    };
    return {
      id: createHash("sha256")
        .update(properties.mapbox_id, "utf8")
        .digest("hex"),
      label: `${address.line1}, ${address.city}, ${address.state} ${address.postalCode}`,
      address,
    };
  });
}

async function readProviderJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAXIMUM_PROVIDER_BYTES
  ) {
    await response.body?.cancel();
    throw new PartnerAddressSuggestionsUnavailableError("response_too_large");
  }
  if (!response.body)
    throw new PartnerAddressSuggestionsUnavailableError("malformed_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAXIMUM_PROVIDER_BYTES)
        throw new PartnerAddressSuggestionsUnavailableError(
          "response_too_large",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new PartnerAddressSuggestionsUnavailableError("malformed_response");
  }
}

/**
 * Permanent Geocoding v6 permits the selected address to be saved by the
 * existing location flow. Autocomplete data itself is neither cached nor saved.
 * https://docs.mapbox.com/api/search/geocoding/#storing-geocoding-results
 */
export async function suggestPartnerAddresses(
  query: string,
  signal?: AbortSignal,
): Promise<PartnerAddressSuggestion[]> {
  const normalized = normalizePartnerAddressSuggestionQuery(query);
  if (!normalized) throw new TypeError("Invalid address suggestion query.");
  const token = process.env["MAPBOX_ACCESS_TOKEN"]?.trim();
  if (!token)
    throw new PartnerAddressSuggestionsUnavailableError(
      "missing_configuration",
    );
  const parameters = new URLSearchParams({
    q: normalized,
    access_token: token,
    country: "us",
    types: "address",
    autocomplete: "true",
    permanent: "true",
    limit: String(PARTNER_ADDRESS_SUGGESTION_LIMIT),
    language: "en",
    // Bias toward the service area without hiding other US addresses.
    proximity: "-84.388,33.749",
  });
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://api.mapbox.com/search/geocode/v6/forward?${parameters.toString()}`,
      {
        cache: "no-store",
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new PartnerAddressSuggestionsUnavailableError(
        "http_error",
        response.status,
      );
    }
    return parseMapboxAddressSuggestions(await readProviderJson(response));
  } catch (error) {
    // Fetch errors can contain the full URL, token, or query. Never retain or log them.
    if (error instanceof PartnerAddressSuggestionsUnavailableError) throw error;
    throw new PartnerAddressSuggestionsUnavailableError(
      signal?.aborted
        ? "cancelled"
        : timeout.aborted
          ? "timeout"
          : "transport_error",
    );
  }
}
