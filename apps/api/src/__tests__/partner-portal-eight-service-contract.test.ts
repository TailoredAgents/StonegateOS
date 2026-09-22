import {
  PARTNER_SERVICE_DEFINITIONS,
  PartnerServiceLineInputSchema,
  PartnerServiceLinesInputSchema,
  PartnerServiceRateSchema,
  getPartnerRateCompleteness,
  multiplyPartnerRateToCents,
} from "@myst-os/pricing";

const line = {
  id: "de89b434-e117-42c3-bcf7-18c1a144cb11",
  serviceKey: "painting",
  description: "Repaint the office",
  scope: { workArea: "interior", surfaces: "Office walls", finish: "repaint" },
};
const rate = {
  key: "office",
  serviceKey: "painting",
  variantKey: "interior",
  label: "Interior walls",
  unit: "sq_ft",
  unitAmount: "0.1255",
  measurement: "Actual painted wall area, excluding openings",
  inclusions: ["Surface preparation", "Two coats"],
  exclusions: ["Rotten substrate replacement"],
  materials: "stonegate",
  coats: 2,
  fullLoadCubicYards: null,
};

describe("eight-service request contract", () => {
  it.each(PARTNER_SERVICE_DEFINITIONS)(
    "roundtrips $label answers without silent loss",
    (service) => {
      const scope = Object.fromEntries(
        service.scopeFields.map((field) => [
          field.key,
          field.type === "choice"
            ? field.options![0]!.value
            : "Client supplied detail",
        ]),
      );
      const parsed = PartnerServiceLineInputSchema.parse({
        ...line,
        serviceKey: service.key,
        scope,
      });
      expect(parsed.scope).toEqual(scope);
      expect(parsed.description).toBe(line.description);
    },
  );
  it("rejects unrelated service answers and removal extras", () => {
    expect(
      PartnerServiceLineInputSchema.safeParse({
        ...line,
        scope: { ...line.scope, approximateAmount: "A sofa" },
      }).success,
    ).toBe(false);
    expect(
      PartnerServiceLineInputSchema.safeParse({
        ...line,
        selectedAddOns: [{ key: "mattress_disposal", quantity: 1 }],
      }).success,
    ).toBe(false);
  });
  it("accepts uncertainty without technical measurements", () => {
    expect(
      PartnerServiceLineInputSchema.parse({
        ...line,
        serviceKey: "pressure-washing",
        scope: { surfaces: "Driveway", approximateArea: "Not sure" },
      }).scope.approximateArea,
    ).toBe("Not sure");
  });
  it("prevents duplicate service lines and legacy identifier reinterpretation", () => {
    expect(
      PartnerServiceLinesInputSchema.safeParse([
        line,
        { ...line, id: "68c3cc55-51a5-4a6c-b753-6275f5b15375" },
      ]).success,
    ).toBe(false);
    for (const serviceKey of ["land-clearing", "demolition", "service_request"])
      expect(
        PartnerServiceLineInputSchema.safeParse({ ...line, serviceKey })
          .success,
      ).toBe(false);
  });
});

describe("precise negotiated rates", () => {
  it("keeps decimal unit rates and rounds only extended currency cents", () => {
    expect(PartnerServiceRateSchema.parse(rate).unitAmount).toBe("0.1255");
    expect(multiplyPartnerRateToCents("0.1255", "1000")).toBe(12550);
    expect(multiplyPartnerRateToCents("0.005", "1")).toBe(1);
    expect(multiplyPartnerRateToCents("1.005", "1")).toBe(101);
    expect(multiplyPartnerRateToCents("0.0001", "10000")).toBe(100);
    expect(() => multiplyPartnerRateToCents("-1", "1")).toThrow();
    expect(() => multiplyPartnerRateToCents("99999999", "99999999")).toThrow();
  });
  it("requires defined measurement, inclusions and painting materials/coats", () => {
    for (const patch of [
      { unitAmount: "" },
      { measurement: "" },
      { inclusions: [] },
      { materials: null },
      { coats: null },
      { unit: "load", fullLoadCubicYards: null },
    ])
      expect(
        PartnerServiceRateSchema.safeParse({ ...rate, ...patch }).success,
      ).toBe(false);
  });
  it("requires both room floor-area and ceiling-height limits before publishing a room package", () => {
    expect(
      PartnerServiceRateSchema.safeParse({ ...rate, unit: "room" }).success,
    ).toBe(false);
    expect(
      PartnerServiceRateSchema.safeParse({
        ...rate,
        unit: "room",
        roomMaxSquareFeet: "200",
      }).success,
    ).toBe(false);
    expect(
      PartnerServiceRateSchema.safeParse({
        ...rate,
        unit: "room",
        roomMaxSquareFeet: "200",
        roomMaxHeightFeet: "9",
      }).success,
    ).toBe(true);
    expect(
      PartnerServiceRateSchema.safeParse({
        ...rate,
        unit: "room",
        roomMaxSquareFeet: "0",
        roomMaxHeightFeet: "9",
      }).success,
    ).toBe(false);
  });
  it("requires every offered variant for new activation without making up rates", () => {
    const partial = getPartnerRateCompleteness([
      PartnerServiceRateSchema.parse(rate),
    ]);
    expect(partial.complete).toBe(false);
    expect(partial.missing).toContainEqual({
      serviceKey: "painting",
      variantKey: "exterior",
      label: "Painting: Exterior",
    });
    const complete = PARTNER_SERVICE_DEFINITIONS.flatMap((service) =>
      service.variants.map((variant) =>
        PartnerServiceRateSchema.parse({
          ...rate,
          key: `${service.key}_${variant.key}`,
          serviceKey: service.key,
          variantKey: variant.key,
        }),
      ),
    );
    expect(getPartnerRateCompleteness(complete)).toEqual({
      complete: true,
      missing: [],
    });
  });
});
