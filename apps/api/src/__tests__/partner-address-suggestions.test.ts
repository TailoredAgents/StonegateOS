import {
  normalizePartnerAddressSuggestionQuery,
  parseMapboxAddressSuggestions,
  PartnerAddressSuggestionsUnavailableError,
  suggestPartnerAddresses,
} from "@/lib/partner-address-suggestions";
import { verifyAddress } from "@/lib/geocode";

const jest = import.meta.jest;
function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input !== "string")
    throw new Error("Expected a provider URL string.");
  return new URL(input);
}
function feature() {
  return {
    type: "Feature",
    properties: {
      mapbox_id: "test-mapbox-address",
      feature_type: "address",
      name: "225 Baker St NW",
      coordinates: { longitude: -84.388, latitude: 33.749 },
      context: {
        address: { name: "225 Baker St NW" },
        place: { name: "Atlanta" },
        region: { region_code: "GA", region_code_full: "US-GA" },
        postcode: { name: "30313" },
        country: { country_code: "US" },
      },
    },
  };
}
const collection = (features: unknown[] = [feature()]) => ({
  type: "FeatureCollection",
  features,
});

describe("partner address suggestions", () => {
  const originalToken = process.env["MAPBOX_ACCESS_TOKEN"];
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalToken === undefined) delete process.env["MAPBOX_ACCESS_TOKEN"];
    else process.env["MAPBOX_ACCESS_TOKEN"] = originalToken;
  });

  it("normalizes input and rejects out-of-bounds or provider-invalid queries", () => {
    expect(
      normalizePartnerAddressSuggestionQuery("  225   Baker St NW  "),
    ).toBe("225 Baker St NW");
    for (const invalid of [
      null,
      "",
      "12",
      "x".repeat(201),
      "a; b",
      "123\u0000 Main St",
      "123\u200b Main St",
      Array.from({ length: 21 }, () => "a").join("-"),
      "---",
    ])
      expect(normalizePartnerAddressSuggestionQuery(invalid)).toBeNull();
  });

  it("returns only complete form fields with bounded stable IDs, including real-world long provider IDs", () => {
    const value = feature();
    value.properties.mapbox_id = "a".repeat(431);
    const first = parseMapboxAddressSuggestions(collection([value]));
    expect(first).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
        label: "225 Baker St NW, Atlanta, GA 30313",
        address: {
          line1: "225 Baker St NW",
          city: "Atlanta",
          state: "GA",
          postalCode: "30313",
        },
      },
    ]);
    expect(parseMapboxAddressSuggestions(collection([value]))).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("coordinates");
    expect(JSON.stringify(first)).not.toContain("mapbox_id");
  });

  it("accepts valid empty results and does not restrict complete US results to Georgia", () => {
    expect(parseMapboxAddressSuggestions(collection([]))).toEqual([]);
    const value = feature();
    value.properties.context.region = {
      region_code: "US-CA",
      region_code_full: "US-CA",
    };
    expect(
      parseMapboxAddressSuggestions(collection([value]))[0]!.address.state,
    ).toBe("CA");
  });

  it("distinguishes malformed, incomplete, duplicate and foreign results from a valid empty list", () => {
    const foreign = feature();
    foreign.properties.context.country.country_code = "CA";
    const badPostal = feature();
    badPostal.properties.context.postcode.name = "unknown";
    const invalids: unknown[] = [
      null,
      {},
      { features: [] },
      collection([{}]),
      collection([foreign]),
      collection([badPostal]),
      collection([feature(), feature()]),
      collection(Array.from({ length: 6 }, feature)),
    ];
    for (const value of invalids)
      expect(() => parseMapboxAddressSuggestions(value)).toThrow(
        PartnerAddressSuggestionsUnavailableError,
      );
  });

  it("keeps the token on the server and requests bounded permanent US autocomplete with a fixed area bias", async () => {
    process.env["MAPBOX_ACCESS_TOKEN"] = "server-test-token";
    const fetcher = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(collection()));
    const result = await suggestPartnerAddresses(" 225 Baker St NW ");
    const [input, options] = fetcher.mock.calls[0]!;
    const url = requestUrl(input);
    expect(url.origin + url.pathname).toBe(
      "https://api.mapbox.com/search/geocode/v6/forward",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "225 Baker St NW",
      access_token: "server-test-token",
      country: "us",
      types: "address",
      autocomplete: "true",
      permanent: "true",
      limit: "5",
      language: "en",
      proximity: "-84.388,33.749",
    });
    expect(options).toMatchObject({
      cache: "no-store",
      redirect: "error",
      signal: expect.any(AbortSignal) as unknown,
    });
    expect(JSON.stringify(result)).not.toContain("server-test-token");
  });

  it("does not call the provider when the key or query is unavailable", async () => {
    const fetcher = jest.spyOn(globalThis, "fetch");
    delete process.env["MAPBOX_ACCESS_TOKEN"];
    await expect(suggestPartnerAddresses("225 Baker")).rejects.toMatchObject({
      reason: "missing_configuration",
    });
    await expect(suggestPartnerAddresses("12")).rejects.toThrow(TypeError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 429, 503])(
    "handles provider HTTP %s without exposing its response",
    async (status) => {
      process.env["MAPBOX_ACCESS_TOKEN"] = "server-test-token";
      jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response("private provider response", { status }),
        );
      await expect(suggestPartnerAddresses("225 Baker")).rejects.toMatchObject({
        message: "Address suggestions are unavailable.",
        reason: "http_error",
        providerStatus: status,
      });
    },
  );

  it("bounds provider bodies and hides malformed JSON and transport error details", async () => {
    process.env["MAPBOX_ACCESS_TOKEN"] = "server-test-token";
    const fetcher = jest.spyOn(globalThis, "fetch");
    for (const [response, reason] of [
      [new Response("x".repeat(65537)), "response_too_large"],
      [new Response("{not_json"), "malformed_response"],
      [Response.json({ features: [] }), "malformed_response"],
    ] as const) {
      fetcher.mockResolvedValueOnce(response);
      await expect(suggestPartnerAddresses("225 Baker")).rejects.toMatchObject({
        message: "Address suggestions are unavailable.",
        reason,
      });
    }
    fetcher.mockRejectedValueOnce(
      new Error("URL with submitted address and private token"),
    );
    await expect(suggestPartnerAddresses("225 Baker")).rejects.toMatchObject({
      message: "Address suggestions are unavailable.",
      reason: "transport_error",
    });
  });

  it("propagates caller cancellation through the bounded provider signal", async () => {
    process.env["MAPBOX_ACCESS_TOKEN"] = "server-test-token";
    const controller = new AbortController();
    controller.abort();
    const fetcher = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, options) => {
        expect(options?.signal?.aborted).toBe(true);
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      });
    await expect(
      suggestPartnerAddresses("225 Baker", controller.signal),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses a five-second deadline and classifies a provider timeout safely", async () => {
    process.env["MAPBOX_ACCESS_TOKEN"] = "server-test-token";
    const controller = new AbortController();
    controller.abort();
    const deadline = jest
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new DOMException("private provider URL", "TimeoutError"),
      );
    await expect(suggestPartnerAddresses("225 Baker")).rejects.toMatchObject({
      message: "Address suggestions are unavailable.",
      reason: "timeout",
    });
    expect(deadline).toHaveBeenCalledWith(5_000);
  });

  it("uses permanent geocoding for the address verification that saves provider evidence", async () => {
    process.env["MAPBOX_ACCESS_TOKEN"] = "server-test-token";
    const fetcher = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(collection([])));
    await verifyAddress({
      addressLine1: "225 Baker St NW",
      city: "Atlanta",
      state: "GA",
      postalCode: "30313",
    });
    const url = requestUrl(fetcher.mock.calls[0]![0]);
    expect(url.searchParams.get("permanent")).toBe("true");
    expect(url.searchParams.get("autocomplete")).toBe("false");
  });
});
