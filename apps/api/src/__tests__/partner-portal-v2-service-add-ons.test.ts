import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parsePartnerDraftMutation,
  validatePartnerBookingDraft,
} from "@/lib/partner-portal-v2-scheduling/domain";
import {
  projectPartnerAddOnSnapshots,
  resolvePartnerBookingPrice,
} from "@/lib/partner-portal-v2-service-add-ons";
import { partnerDraftMutationInvalidatesHold } from "@/lib/partner-portal-v2-scheduling/service";

const configured = [
  {
    key: "mattress_disposal",
    label: "Mattress disposal",
    unitLabel: "mattress",
    minimumQuantity: 1,
    maximumQuantity: 20,
    instantConfirmationMaxQuantity: 10,
    requiresReview: false,
    unitAmountMinor: 3_000,
    currency: "USD",
  },
  {
    key: "paint_can_disposal",
    label: "Paint can disposal",
    unitLabel: "can",
    minimumQuantity: 1,
    maximumQuantity: 100,
    instantConfirmationMaxQuantity: 10,
    requiresReview: false,
    unitAmountMinor: 1_000,
    currency: "USD",
  },
] as const;

describe("partner V2 base service and quantity add-ons", () => {
  it("canonicalizes strict, bounded, non-duplicate draft selections", () => {
    expect(
      parsePartnerDraftMutation({
        tierKey: "half",
        selectedAddOns: [
          { key: "paint_can_disposal", quantity: 3 },
          { key: "mattress_disposal", quantity: 2 },
        ],
      }),
    ).toMatchObject({
      tierKey: "half",
      selectedAddOns: [
        { key: "mattress_disposal", quantity: 2 },
        { key: "paint_can_disposal", quantity: 3 },
      ],
    });
    expect(() =>
      parsePartnerDraftMutation({
        selectedAddOns: [
          { key: "mattress_disposal", quantity: 1 },
          { key: "mattress_disposal", quantity: 2 },
        ],
      }),
    ).toThrow();
    expect(() =>
      parsePartnerDraftMutation({
        selectedAddOns: [{ key: "mattress_disposal", quantity: 101 }],
      }),
    ).toThrow();
  });

  it("validates and canonicalizes the structured operational scope", () => {
    expect(
      parsePartnerDraftMutation({
        scope: {
          hazardCategories: ["paint", "chemicals"],
          equipmentNeeds: ["stairs", "lift_gate"],
          restrictedItems: true,
          nonStandard: true,
          requiredCompletion: {
            localDate: "2026-09-18",
            localTime: "14:30",
          },
          multiStop: true,
          multiStopDetails: "  Building A, then building B.  ",
          alternateContact: {
            name: "  Site supervisor  ",
            email: "BACKUP@EXAMPLE.COM",
          },
        },
      }),
    ).toMatchObject({
      scope: {
        hazardCategories: ["chemicals", "paint"],
        equipmentNeeds: ["lift_gate", "stairs"],
        restrictedItems: true,
        nonStandard: true,
        requiredCompletion: {
          localDate: "2026-09-18",
          localTime: "14:30",
        },
        multiStop: true,
        multiStopDetails: "Building A, then building B.",
        alternateContact: {
          name: "Site supervisor",
          email: "backup@example.com",
        },
      },
    });

    for (const scope of [
      { hazardCategories: ["forged"] },
      { equipmentNeeds: ["stairs", "stairs"] },
      { requiredCompletion: { localDate: "2026-02-30" } },
      { multiStop: true },
      { alternateContact: { name: "Backup" } },
    ]) {
      expect(() => parsePartnerDraftMutation({ scope })).toThrow();
    }
  });

  it("calculates base plus quantity lines without trusting client prices", () => {
    const pricing = resolvePartnerBookingPrice({
      baseAmountMinor: 25_000,
      baseCurrency: "USD",
      selectedAddOns: [
        { key: "mattress_disposal", quantity: 2 },
        { key: "paint_can_disposal", quantity: 3 },
      ],
      configuredAddOns: configured,
    });
    expect(pricing).toMatchObject({
      status: "contracted",
      baseAmountMinor: 25_000,
      addOnTotalMinor: 9_000,
      totalAmountMinor: 34_000,
      currency: "USD",
      allAddOnsPriced: true,
      addOnReviewRequired: false,
    });
    expect(pricing.addOns).toEqual([
      expect.objectContaining({
        key: "mattress_disposal",
        quantity: 2,
        unitAmountMinor: 3_000,
        lineTotalMinor: 6_000,
      }),
      expect.objectContaining({
        key: "paint_can_disposal",
        quantity: 3,
        unitAmountMinor: 1_000,
        lineTotalMinor: 3_000,
      }),
    ]);
  });

  it("fails safely to review for an unpriced or over-threshold add-on", () => {
    const unpriced = resolvePartnerBookingPrice({
      baseAmountMinor: 25_000,
      baseCurrency: "USD",
      selectedAddOns: [{ key: "mattress_disposal", quantity: 1 }],
      configuredAddOns: [
        { ...configured[0], unitAmountMinor: null, currency: null },
      ],
    });
    expect(unpriced).toMatchObject({
      status: "review_required",
      addOnTotalMinor: null,
      totalAmountMinor: null,
      allAddOnsPriced: false,
    });

    const highQuantity = resolvePartnerBookingPrice({
      baseAmountMinor: 25_000,
      baseCurrency: "USD",
      selectedAddOns: [{ key: "mattress_disposal", quantity: 11 }],
      configuredAddOns: configured,
    });
    expect(highQuantity.totalAmountMinor).toBe(58_000);
    expect(highQuantity.addOnReviewRequired).toBe(true);
    expect(highQuantity.addOns[0]?.requiresReview).toBe(true);
  });

  it("routes hazards, equipment, deadlines, and multi-stop scope to review, not rejection", () => {
    const result = validatePartnerBookingDraft({
      locationId: "11111111-1111-4111-8111-111111111111",
      serviceKey: "junk-removal",
      scope: {
        restrictedItems: true,
        hazardCategories: ["paint"],
        nonStandard: true,
        equipmentNeeds: ["heavy_lift"],
        multiStop: true,
        requiredCompletion: {
          localDate: "2026-09-18",
          localTime: "14:30",
        },
      },
      description: "Remove unusually heavy containers with unknown material",
      onSiteContact: { name: "Site lead", phone: "+14045550100" },
      proofRequirements: { before: 1, after: 1 },
      commercial: {},
      location: {
        id: "11111111-1111-4111-8111-111111111111",
        propertyId: "22222222-2222-4222-8222-222222222222",
        geocodeStatus: "verified",
        serviceAreaStatus: "eligible",
      },
      catalog: {
        active: true,
        instantBookable: false,
        requiredScopeFields: [],
        automaticReviewRules: {},
      },
      profile: {
        requiredScopeFields: ["description", "location", "onSiteContact"],
        automaticReviewRules: {},
      },
    });

    expect(result.valid).toBe(true);
    expect(result.fieldErrors).toEqual({});
    expect(result.reviewReasons).toEqual([
      "non_standard_job",
      "restricted_item",
      "manual_review_required",
    ]);
  });

  it("releases a stale hold when base, add-on quantity, or review scope changes", () => {
    const current = {
      currentLocationId: "location-1",
      currentServiceKey: "junk-removal",
      currentTierKey: "half",
      currentSelectedAddOns: [{ key: "mattress_disposal", quantity: 1 }],
      currentScope: { restrictedItems: false },
    } as const;
    expect(
      partnerDraftMutationInvalidatesHold({
        ...current,
        mutation: {
          tierKey: "half",
          selectedAddOns: [{ key: "mattress_disposal", quantity: 1 }],
          scope: { restrictedItems: false },
        },
      }),
    ).toBe(false);
    expect(
      partnerDraftMutationInvalidatesHold({
        ...current,
        mutation: { tierKey: "full" },
      }),
    ).toBe(true);
    expect(
      partnerDraftMutationInvalidatesHold({
        ...current,
        mutation: {
          selectedAddOns: [{ key: "mattress_disposal", quantity: 2 }],
        },
      }),
    ).toBe(true);
    expect(
      partnerDraftMutationInvalidatesHold({
        ...current,
        mutation: { scope: { restrictedItems: true } },
      }),
    ).toBe(true);
  });

  it("projects only valid immutable public snapshot fields", () => {
    expect(
      projectPartnerAddOnSnapshots([
        {
          key: "mattress_disposal",
          label: "Mattress disposal",
          unitLabel: "mattress",
          quantity: 2,
          unitAmountMinor: 3_000,
          lineTotalMinor: 6_000,
          currency: "USD",
          requiresReview: false,
          providerPriceId: "must-not-leak",
        },
        { key: "bad", label: "", quantity: -1 },
      ]),
    ).toEqual([
      {
        key: "mattress_disposal",
        label: "Mattress disposal",
        unitLabel: "mattress",
        quantity: 2,
        unitAmountMinor: 3_000,
        lineTotalMinor: 6_000,
        currency: "USD",
        requiresReview: false,
      },
    ]);
  });

  it("seeds/backfills established fees and keeps the staff rate editor dual-writing", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "src/db/migrations/0127_partner_service_add_ons.sql",
      ),
      "utf8",
    );
    const staffRoute = readFileSync(
      resolve(process.cwd(), "app/api/admin/partners/rates/route.ts"),
      "utf8",
    );
    const schedulingService = readFileSync(
      resolve(process.cwd(), "src/lib/partner-portal-v2-scheduling/service.ts"),
      "utf8",
    );
    const staffEditor = readFileSync(
      resolve(
        process.cwd(),
        "../site/src/app/team/components/PartnerRatesEditor.tsx",
      ),
      "utf8",
    );
    for (const value of [
      "mattress_fee",
      "paint_fee",
      "tire_fee",
      "mattress_disposal",
      "paint_can_disposal",
      "tire_disposal",
    ]) {
      expect(migration).toContain(value);
    }
    expect(migration).toContain('INSERT INTO "partner_rate_add_on_items"');
    expect(migration).toContain('INSERT INTO "partner_scheduling_profiles"');
    expect(migration).toContain(
      "SELECT 'junk-removal', configured.\"add_on_key\", 1, 100, 10, false, true",
    );
    expect(staffRoute).toContain("getPartnerAddOnKeyForLegacyTier");
    expect(staffRoute).toContain("partnerRateAddOnItems");
    expect(staffRoute).toContain("partnerAccountId:");
    expect(staffEditor).toContain('tierKey: "mattress_fee"');
    expect(staffEditor).toContain('tierKey: "paint_fee"');
    expect(staffEditor).toContain('tierKey: "tire_fee"');
    expect(staffEditor).toContain('amount: "30.00"');
    expect(staffEditor).toContain('amount: "10.00"');
    expect(schedulingService).toContain("tierKey: draft.tierKey");
    expect(schedulingService).toContain("addOnsSnapshot: pricing.addOns.map");
  });
});
