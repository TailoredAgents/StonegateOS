import {
  professionalQuoteBundlePresets,
  professionalQuoteServicePresets,
  professionalQuoteZonePresets,
} from "@myst-os/pricing/src/quote-catalog";
import { assertQuoteV2CatalogPolicy } from "@/lib/quote-v2-catalog";

function document() {
  return {
    pricing: {
      lineItems: [{ catalogKey: "service:single-item" }, { catalogKey: null }],
      adjustments: [] as Array<{
        id: string;
        kind: string;
        calculation: string;
        basisPoints?: number | null;
        amountCents?: number | null;
      }>,
    },
    serviceZoneId: "zone-core",
    serviceZoneConfirmed: true,
  };
}

describe("Quote V2 catalog and service-zone policy", () => {
  it("exports unique reusable service, bundle, and zone presets", () => {
    expect(professionalQuoteServicePresets.length).toBeGreaterThan(5);
    expect(
      new Set(professionalQuoteServicePresets.map((item) => item.catalogKey))
        .size,
    ).toBe(professionalQuoteServicePresets.length);
    expect(professionalQuoteBundlePresets.length).toBeGreaterThan(0);
    expect(professionalQuoteZonePresets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["zone-core", "zone-extended"]),
    );
  });

  it("permits known presets plus custom lines and rejects unknown/duplicate catalog IDs", () => {
    expect(() =>
      assertQuoteV2CatalogPolicy(document(), { requireConfirmedZone: true }),
    ).not.toThrow();
    const unknown = document();
    unknown.pricing.lineItems[0] = { catalogKey: "service:invented" };
    expect(() =>
      assertQuoteV2CatalogPolicy(unknown, { requireConfirmedZone: true }),
    ).toThrow(/unknown service preset/iu);
    const duplicate = document();
    duplicate.pricing.lineItems.push({ catalogKey: "service:single-item" });
    expect(() =>
      assertQuoteV2CatalogPolicy(duplicate, { requireConfirmedZone: true }),
    ).toThrow(/cannot be added twice/iu);
  });

  it("requires explicit ambiguous-zone confirmation and exact visible travel", () => {
    const unconfirmed = document();
    unconfirmed.serviceZoneConfirmed = false;
    expect(() =>
      assertQuoteV2CatalogPolicy(unconfirmed, { requireConfirmedZone: true }),
    ).toThrow(/Confirm the service zone/iu);

    const extended = document();
    extended.serviceZoneId = "zone-extended";
    expect(() =>
      assertQuoteV2CatalogPolicy(extended, { requireConfirmedZone: true }),
    ).toThrow(/travel charge/iu);
    extended.pricing.adjustments.push({
      id: "service-zone-travel",
      kind: "travel",
      calculation: "fixed",
      amountCents: 2_500,
    });
    expect(() =>
      assertQuoteV2CatalogPolicy(extended, { requireConfirmedZone: true }),
    ).not.toThrow();
  });

  it("accepts only an eligible, exact reusable bundle discount", () => {
    const bundle = professionalQuoteBundlePresets[0]!;
    const proposal = document();
    proposal.pricing.adjustments.push({
      id: bundle.adjustmentId,
      kind: "discount",
      calculation: "percentage",
      basisPoints: bundle.basisPoints,
    });
    expect(() =>
      assertQuoteV2CatalogPolicy(proposal, { requireConfirmedZone: true }),
    ).toThrow(/bundle discount/iu);
    proposal.pricing.lineItems = bundle.requiredCatalogKeys.map(
      (catalogKey) => ({
        catalogKey,
      }),
    );
    expect(() =>
      assertQuoteV2CatalogPolicy(proposal, { requireConfirmedZone: true }),
    ).not.toThrow();
  });
});
