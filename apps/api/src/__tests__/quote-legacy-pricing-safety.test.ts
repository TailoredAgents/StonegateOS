import { calculateQuoteBreakdown } from "@myst-os/pricing/src/engine/calculate";

describe("legacy quote pricing safety during V2 rollout", () => {
  it("rejects unknown and duplicate pricing identifiers", () => {
    expect(() =>
      calculateQuoteBreakdown({
        zoneId: "unknown-zone",
        selectedServices: ["furniture"],
      }),
    ).toThrow();
    expect(() =>
      calculateQuoteBreakdown({
        zoneId: "zone-core",
        selectedServices: ["driveway"],
        serviceOverrides: { driveway: 250 },
        concreteSurfaces: [{ kind: "driveway", squareFeet: 800 }],
      }),
    ).toThrow();
    expect(() =>
      calculateQuoteBreakdown({
        zoneId: "zone-core",
        selectedServices: ["furniture", "furniture"],
      }),
    ).toThrow();
    expect(() =>
      calculateQuoteBreakdown({
        zoneId: "zone-core",
        selectedServices: ["furniture"],
        selectedAddOns: ["unknown-add-on"],
      }),
    ).toThrow();
    expect(() =>
      calculateQuoteBreakdown({
        zoneId: "zone-core",
        selectedServices: ["furniture"],
        serviceOverrides: { roof: 400 },
      }),
    ).toThrow();
  });

  it("requires a positive reviewed price for variable custom presets", () => {
    expect(() =>
      calculateQuoteBreakdown({
        zoneId: "zone-core",
        selectedServices: ["other"],
      }),
    ).toThrow("positive staff-reviewed price");

    const priced = calculateQuoteBreakdown({
      zoneId: "zone-core",
      selectedServices: ["other"],
      serviceOverrides: { other: 275 },
    });
    expect(priced.total).toBe(275);
  });

  it("uses minimum area as a floor and returns the actual pre-discount subtotal", () => {
    const minimumArea = calculateQuoteBreakdown({
      zoneId: "zone-extended",
      selectedServices: ["driveway"],
      surfaceArea: 100,
      selectedAddOns: ["addon-window-rinse"],
    });
    expect(minimumArea.lineItems[0]).toMatchObject({ amount: 233 });
    expect(minimumArea.subtotal).toBe(333);
    expect(minimumArea.total).toBe(333);
  });

  it("selects one best bundle instead of stacking every eligible discount", () => {
    const quote = calculateQuoteBreakdown({
      zoneId: "zone-core",
      selectedServices: ["house-wash", "driveway", "roof", "gutter"],
      applyBundles: true,
    });
    // Total Protect (15%) is the best eligible bundle and is not stacked with
    // Exterior Refresh (10%).
    expect(quote.discounts).toBeCloseTo(174.45, 2);
    expect(
      quote.lineItems.filter((line) => line.category === "discount"),
    ).toHaveLength(1);
  });
});
