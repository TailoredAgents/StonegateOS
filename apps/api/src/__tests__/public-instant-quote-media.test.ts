import {
  buildPublicInstantQuoteMediaReferenceUrl,
  parsePublicInstantQuoteMediaReference,
  parseUniquePublicInstantQuoteMediaReferences,
} from "@/lib/public-instant-quote-media";

describe("public instant quote media references", () => {
  const assetId = "2e5bf2a0-09b7-4b71-81d1-3d6b80727b71";

  it("builds and parses an object-storage upload reference", () => {
    const url = buildPublicInstantQuoteMediaReferenceUrl({
      baseUrl: "https://api.example.com",
      assetId,
      token: "opaque-token",
    });

    expect(url).toBe(
      `https://api.example.com/api/public/junk-quote/uploads/${assetId}?token=opaque-token`,
    );
    expect(parsePublicInstantQuoteMediaReference(url)).toEqual({
      kind: "object_storage",
      id: assetId,
      token: "opaque-token",
    });
  });

  it("recognizes legacy database references for in-flight forms", () => {
    expect(
      parsePublicInstantQuoteMediaReference(
        `https://api.example.com/api/public/inbox/uploads/${assetId}?token=legacy-token`,
      ),
    ).toEqual({
      kind: "legacy_database",
      id: assetId,
      token: "legacy-token",
    });
  });

  it("rejects arbitrary remote photo URLs and missing tokens", () => {
    expect(
      parsePublicInstantQuoteMediaReference(
        "https://attacker.example/customer-photo.jpg",
      ),
    ).toBeNull();
    expect(
      parsePublicInstantQuoteMediaReference(
        `https://api.example.com/api/public/junk-quote/uploads/${assetId}`,
      ),
    ).toBeNull();
  });

  it("rejects the same uploaded asset more than once before claim or import", () => {
    const url = buildPublicInstantQuoteMediaReferenceUrl({
      baseUrl: "https://api.example.com",
      assetId,
      token: "opaque-token",
    });

    expect(() =>
      parseUniquePublicInstantQuoteMediaReferences([url, url]),
    ).toThrow("duplicate_photo_reference");
  });
});
