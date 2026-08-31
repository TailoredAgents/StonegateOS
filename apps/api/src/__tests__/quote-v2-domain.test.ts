import {
  assertQuoteAggregateTransition,
  assertQuoteReadyForIssue,
  assertSalesOpportunityTransition,
  assertQuoteVersionTransition,
  calculateQuoteV2Totals,
  canonicalQuoteJson,
  hashQuoteContent,
  QuoteDomainError,
  deriveContactOpportunityRollup,
  resolveQuoteAllowedActions,
} from "@/lib/quote-v2-domain";

const basePricing = {
  documentType: "fixed_quote" as const,
  currency: "USD" as const,
  lineItems: [
    {
      id: "base-hauling",
      name: "Hauling service",
      quantity: 2.5,
      unit: "hour",
      unitPriceMinCents: 20_000,
      displayOrder: 0,
      selectedByDefault: false,
    },
    {
      id: "appliance",
      name: "Appliance removal",
      quantity: 1,
      unit: "item",
      unitPriceMinCents: 7_500,
      optionGroupId: "add-ons",
      selectedByDefault: false,
      displayOrder: 1,
    },
  ],
  optionGroups: [
    {
      id: "add-ons",
      label: "Optional additions",
      mode: "multiple" as const,
      minimumSelections: 0,
      maximumSelections: 1,
    },
  ],
  adjustments: [
    {
      id: "discount",
      kind: "discount" as const,
      label: "Commercial discount",
      calculation: "percentage" as const,
      basisPoints: 1_000,
      displayOrder: 0,
    },
    {
      id: "travel",
      kind: "travel" as const,
      label: "Travel",
      calculation: "fixed" as const,
      amountCents: 2_500,
      displayOrder: 1,
    },
  ],
  deposit: { mode: "percentage" as const, basisPoints: 2_500 },
};

describe("quote V2 domain", () => {
  it("calculates authoritative cents, options, adjustments, and deposit", () => {
    const totals = calculateQuoteV2Totals(basePricing, ["appliance"]);

    expect(totals.subtotalMinCents).toBe(57_500);
    expect(totals.discountMinCents).toBe(5_750);
    expect(totals.feeMinCents).toBe(2_500);
    expect(totals.totalMinCents).toBe(54_250);
    expect(totals.totalMaxCents).toBe(54_250);
    expect(totals.depositCents).toBe(13_563);
    expect(totals.balanceMinCents).toBe(40_687);
    expect(totals.selectedOptionIds).toEqual(["appliance"]);
  });

  it("requires a real low-high range and a fixed range deposit", () => {
    const range = {
      ...basePricing,
      documentType: "range" as const,
      lineItems: [
        {
          ...basePricing.lineItems[0],
          unitPriceMaxCents: 24_000,
        },
      ],
      optionGroups: [],
      adjustments: [],
      deposit: { mode: "fixed" as const, amountCents: 10_000 },
    };
    const totals = calculateQuoteV2Totals(range);
    expect(totals.totalMinCents).toBe(50_000);
    expect(totals.totalMaxCents).toBe(60_000);
    expect(totals.depositCents).toBe(10_000);

    expect(() =>
      calculateQuoteV2Totals({
        ...range,
        deposit: { mode: "percentage", basisPoints: 2_500 },
      }),
    ).toThrow("Range documents require a fixed deposit");
  });

  it("rejects duplicates, unknown options, and over-discounting", () => {
    expect(() =>
      calculateQuoteV2Totals({
        ...basePricing,
        lineItems: [basePricing.lineItems[0], basePricing.lineItems[0]],
        optionGroups: [],
      }),
    ).toThrow("Quote identifiers must be unique");

    expect(() => calculateQuoteV2Totals(basePricing, ["unknown"])).toThrow(
      "unavailable quote option",
    );

    expect(() =>
      calculateQuoteV2Totals(basePricing, ["appliance", "appliance"]),
    ).toThrow("cannot be selected more than once");

    expect(() =>
      calculateQuoteV2Totals({
        ...basePricing,
        optionGroups: [],
        lineItems: [basePricing.lineItems[0]],
        adjustments: [
          {
            id: "too-large",
            kind: "discount",
            label: "Too large",
            calculation: "fixed",
            amountCents: 99_999,
            displayOrder: 0,
          },
        ],
      }),
    ).toThrow("Discounts cannot exceed");
  });

  it("applies adjustments only to their explicit calculation basis", () => {
    const totals = calculateQuoteV2Totals(
      {
        ...basePricing,
        adjustments: [
          {
            id: "base-only-discount",
            kind: "discount",
            label: "Base service discount",
            calculation: "percentage",
            basis: "line_items",
            eligibleLineItemIds: ["base-hauling"],
            basisPoints: 1_000,
            displayOrder: 0,
          },
        ],
        deposit: { mode: "none" },
      },
      ["appliance"],
    );

    expect(totals.subtotalMinCents).toBe(57_500);
    expect(totals.discountMinCents).toBe(5_000);
    expect(totals.totalMinCents).toBe(52_500);

    expect(() =>
      calculateQuoteV2Totals({
        ...basePricing,
        adjustments: [
          {
            id: "unknown-line",
            kind: "discount",
            label: "Invalid discount",
            calculation: "fixed",
            basis: "line_items",
            eligibleLineItemIds: ["missing"],
            amountCents: 100,
            displayOrder: 0,
          },
        ],
      }),
    ).toThrow("unknown quote line");
  });

  it("enforces the issue readiness checklist", () => {
    expect(() =>
      assertQuoteReadyForIssue({
        pricing: basePricing,
        parties: {},
        scope: "",
        terms: "",
        validityDays: 0,
      }),
    ).toThrow(QuoteDomainError);

    const ready = assertQuoteReadyForIssue({
      pricing: basePricing,
      parties: {
        customerName: "Alex Client",
        companyName: "Example Commercial",
        serviceAddress: "123 Main St, Atlanta, GA 30301",
        preparerName: "Stonegate Sales",
      },
      scope: "Remove the listed material from the service site.",
      terms: "Work outside the stated scope requires a written change order.",
      validityDays: 30,
    });
    expect(ready.totals.totalMinCents).toBeGreaterThan(0);
  });

  it("keeps terminal quote states monotonic", () => {
    expect(() =>
      assertQuoteAggregateTransition("open", "accepted"),
    ).not.toThrow();
    expect(() => assertQuoteAggregateTransition("accepted", "open")).toThrow(
      "cannot change",
    );
    expect(() =>
      assertQuoteVersionTransition("issued", "accepted"),
    ).not.toThrow();
    expect(() => assertQuoteVersionTransition("accepted", "issued")).toThrow(
      "cannot change",
    );
  });

  it("moves opportunities from approval to fulfillment without regressions", () => {
    expect(() =>
      assertSalesOpportunityTransition("open", "approved"),
    ).not.toThrow();
    expect(() =>
      assertSalesOpportunityTransition("approved", "won"),
    ).not.toThrow();
    expect(() => assertSalesOpportunityTransition("won", "open")).toThrow(
      "cannot change",
    );
    expect(deriveContactOpportunityRollup(["won", "open"])).toBe("open");
    expect(deriveContactOpportunityRollup(["won", "lost"])).toBe("won");
    expect(deriveContactOpportunityRollup(["lost", "archived"])).toBe("lost");
  });

  it("derives allowed actions from capability, version, changes, and payment", () => {
    const common = {
      aggregateState: "open" as const,
      versionState: "issued" as const,
      capabilityActions: [
        "view",
        "pdf",
        "change",
        "accept",
        "decline",
        "availability",
        "hold",
        "checkout",
        "book",
      ] as const,
      actionExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      readExpiresAt: new Date("2031-01-01T00:00:00.000Z"),
      revokedAt: null,
      hasOpenChangeRequest: false,
      requiresDeposit: true,
      depositCaptured: false,
      schedulingMode: "self_schedule" as const,
      now: new Date("2029-01-01T00:00:00.000Z"),
    };
    expect(resolveQuoteAllowedActions(common)).toEqual([
      "view",
      "pdf",
      "change",
      "accept",
      "decline",
      "availability",
      "hold",
    ]);
    expect(
      resolveQuoteAllowedActions({ ...common, hasOpenChangeRequest: true }),
    ).toEqual(["view", "pdf"]);
    expect(
      resolveQuoteAllowedActions({
        ...common,
        aggregateState: "accepted",
        versionState: "accepted",
      }),
    ).toEqual(["view", "pdf", "availability", "hold", "checkout"]);
    expect(
      resolveQuoteAllowedActions({
        ...common,
        aggregateState: "accepted",
        versionState: "accepted",
        requiresDeposit: false,
        depositCaptured: false,
      }),
    ).toContain("book");
  });

  it("produces stable content hashes regardless of object key order", () => {
    expect(canonicalQuoteJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(hashQuoteContent({ a: 1, b: 2 })).toBe(
      hashQuoteContent({ b: 2, a: 1 }),
    );
  });
});
