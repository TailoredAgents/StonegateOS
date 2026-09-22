import { randomUUID } from "node:crypto";
import { resolveApplicableServiceRates } from "@/lib/partner-multi-service-rates";
import { completeTestPartnerRateCard } from "./fixtures/partner-service-rates";
import {
  parsePartnerDraftMutation,
  validatePartnerBookingDraft,
} from "@/lib/partner-portal-v2-scheduling/domain";
import {
  combineMultiServiceApprovals,
  PartnerMultiServicePriceSchema,
  requiredServiceRateVariants,
  requiredVisitMinimum,
  sumExplicitLinePrices,
  multiServiceParentStatus,
  unscheduledMultiServiceLineIds,
} from "@/lib/partner-multi-service-domain";
import {
  groupPartnerBulkRows,
  type BulkValidationRow,
} from "@/lib/partner-repeat-work";

const line = (serviceKey = "painting") => ({
  id: randomUUID(),
  serviceKey,
  description: "Paint the lobby",
  scope: serviceKey === "painting" ? { workArea: "interior" } : {},
  selectedAddOns: [],
  proofRequirements: {},
});
describe("multi-service request boundaries", () => {
  it("keeps uncovered services visible and counts only active visits as scheduling coverage", () => {
    const lines = [
      { id: "paint", status: "pending" },
      { id: "wash", status: "pending" },
    ];
    const scheduled = [{ status: "scheduled", serviceLineIds: ["paint"] }];
    expect(multiServiceParentStatus(lines, scheduled)).toBe(
      "partially_scheduled",
    );
    expect(unscheduledMultiServiceLineIds(lines, scheduled)).toEqual(["wash"]);
    expect(
      multiServiceParentStatus(lines, [
        ...scheduled,
        { status: "scheduled", serviceLineIds: ["wash"] },
      ]),
    ).toBe("confirmed");
    const prior = [{ status: "completed", serviceLineIds: ["paint", "wash"] }];
    expect(multiServiceParentStatus(lines, prior)).toBe("in_progress");
    expect(unscheduledMultiServiceLineIds(lines, prior)).toEqual([
      "paint",
      "wash",
    ]);
    expect(
      unscheduledMultiServiceLineIds(
        [{ id: "paint", status: "completed" }, lines[1]!],
        prior,
      ),
    ).toEqual(["wash"]);
    expect(
      multiServiceParentStatus(lines, [
        { status: "canceled", serviceLineIds: ["paint", "wash"] },
      ]),
    ).toBe("under_review");
  });
  it("round-trips distinct service scopes without a singular service or calculated total", () => {
    const lines = [line(), line("pressure-washing")];
    const parsed = parsePartnerDraftMutation({
      modelVersion: 2,
      serviceLines: lines,
    });
    expect(parsed).toEqual({ modelVersion: 2, serviceLines: lines });
    expect(parsed).not.toHaveProperty("serviceKey");
    expect(() =>
      parsePartnerDraftMutation({
        modelVersion: 2,
        serviceLines: [{ ...lines[0], quotedAmountCents: 10 }],
      }),
    ).toThrow();
  });
  it("rejects duplicate service IDs and scopes that belong to another service", () => {
    const first = line();
    expect(() =>
      parsePartnerDraftMutation({
        modelVersion: 2,
        serviceLines: [first, first],
      }),
    ).toThrow();
    expect(() =>
      parsePartnerDraftMutation({
        modelVersion: 2,
        serviceLines: [{ ...first, scope: { volumeCubicYards: "10" } }],
      }),
    ).toThrow();
    expect(() =>
      parsePartnerDraftMutation({
        modelVersion: 2,
        serviceLines: [
          { ...first, selectedAddOns: [{ key: "mattress", quantity: 1 }] },
        ],
      }),
    ).toThrow();
  });
  it("bounds optional photo associations and rejects duplicate line references", () => {
    const mediaId = randomUUID(),
      lineId = randomUUID();
    expect(
      parsePartnerDraftMutation({
        scope: { photoServiceAssociations: { [mediaId]: [lineId] } },
      }).scope,
    ).toEqual({ photoServiceAssociations: { [mediaId]: [lineId] } });
    expect(() =>
      parsePartnerDraftMutation({
        scope: { photoServiceAssociations: { [mediaId]: [lineId, lineId] } },
      }),
    ).toThrow();
    expect(() =>
      parsePartnerDraftMutation({
        scope: { photoServiceAssociations: { arbitrary: [lineId] } },
      }),
    ).toThrow();
  });
  it("groups CSV services into one normalized request and rejects shared-field conflicts for the entire group", () => {
    const common = {
      locationId: randomUUID(),
      tierKey: null,
      crewInstructions: null,
      onSiteContact: { name: "Contact", email: "test@example.test" },
      scope: {},
      proofRequirements: { before: 0, after: 0 },
      commercial: {},
      preferredDate: "2035-06-04",
      preferredWindowStart: null,
      timezone: "America/New_York",
    };
    const rows: BulkValidationRow[] = ["painting", "pressure-washing"].map(
      (serviceKey, index) => ({
        rowNumber: index + 2,
        raw: { request_group: "same-project" },
        errors: [],
        normalized: {
          ...common,
          serviceKey,
          description: `Complete ${serviceKey}`,
        },
      }),
    );
    const grouped = groupPartnerBulkRows(rows, true);
    expect(grouped[0]?.normalized).toMatchObject({
      requestGroup: "same-project",
      modelVersion: 2,
      serviceKey: null,
    });
    expect(grouped[0]?.normalized?.serviceLines).toHaveLength(2);
    expect(grouped[0]?.normalized).toEqual(grouped[1]?.normalized);
    const conflicts = groupPartnerBulkRows(
      [
        rows[0]!,
        {
          ...rows[1]!,
          normalized: { ...rows[1]!.normalized!, preferredDate: "2035-06-05" },
        },
      ],
      true,
    );
    expect(
      conflicts.every(
        (row) =>
          row.normalized === null &&
          row.errors.some((error) => error.field === "request_group"),
      ),
    ).toBe(true);
    expect(
      groupPartnerBulkRows(rows, false).every((row) => row.normalized === null),
    ).toBe(true);
    expect(
      groupPartnerBulkRows(
        [
          {
            ...rows[0]!,
            normalized: { ...rows[0]!.normalized!, scope: { itemCount: 4 } },
          },
          rows[1]!,
        ],
        true,
      ).every(
        (row) =>
          row.normalized === null &&
          row.errors.some((error) =>
            error.message.includes("service-specific measurements"),
          ),
      ),
    ).toBe(true);
  });
  it("allows empty drafts to autosave but requires a service description before submission", () => {
    expect(
      parsePartnerDraftMutation({ modelVersion: 2, serviceLines: [] })
        .serviceLines,
    ).toEqual([]);
    const id = randomUUID();
    const base = {
      modelVersion: 2,
      serviceKey: null,
      description: null,
      locationId: id,
      location: {
        id,
        propertyId: randomUUID(),
        geocodeStatus: "verified",
        serviceAreaStatus: "eligible",
      },
      scope: {},
      onSiteContact: { name: "Staff", phone: "4045550100" },
      proofRequirements: { before: 0, after: 0 },
      commercial: {},
      catalog: null,
      profile: null,
    };
    expect(
      validatePartnerBookingDraft({ ...base, serviceLines: [] }).fieldErrors,
    ).toHaveProperty("serviceLines");
    const incomplete = parsePartnerDraftMutation({
      serviceLines: [{ ...line(), description: "" }],
    }).serviceLines!;
    expect(
      validatePartnerBookingDraft({ ...base, serviceLines: incomplete })
        .fieldErrors["serviceLines.0.description"],
    ).toBeDefined();
    expect(
      validatePartnerBookingDraft({
        ...base,
        serviceLines: parsePartnerDraftMutation({ serviceLines: [line()] })
          .serviceLines,
      }).valid,
    ).toBe(true);
  });
  it("requires rates for all requested variants including unknown or both", () => {
    expect(
      requiredServiceRateVariants("soft-washing", { washArea: "roof" }),
    ).toEqual(["roof"]);
    expect(
      requiredServiceRateVariants("soft-washing", { washArea: "both" }),
    ).toEqual(["building", "roof"]);
    expect(requiredServiceRateVariants("painting", {})).toEqual([
      "interior",
      "exterior",
    ]);
    expect(
      requiredServiceRateVariants("drywall-repair-paint", {
        paintCoverage: "repaired_area",
      }),
    ).toEqual(["repaired_area"]);
  });
  it("counts explicit work once even if it is split across visits", () => {
    const id = randomUUID();
    expect(
      sumExplicitLinePrices(
        [{ id }],
        [{ serviceLineId: id, amountCents: 20000 }],
      ),
    ).toBe(20000);
    expect(
      requiredVisitMinimum([
        { status: "completed", minimumAmountCents: 7500 },
        { status: "scheduled", minimumAmountCents: 7500 },
        { status: "canceled", minimumAmountCents: 7500 },
      ]),
    ).toBe(15000);
    expect(() =>
      sumExplicitLinePrices(
        [{ id }],
        [
          { serviceLineId: id, amountCents: 1 },
          { serviceLineId: id, amountCents: 1 },
        ],
      ),
    ).toThrow();
    expect(() =>
      sumExplicitLinePrices(
        [{ id }],
        [{ serviceLineId: randomUUID(), amountCents: 1 }],
      ),
    ).toThrow();
  });
  it("keeps staff price reasoning and quantity validation explicit", () => {
    const base = {
      accountId: randomUUID(),
      reason: "Reviewed exact job scope with the partner.",
      linePrices: [
        {
          serviceLineId: randomUUID(),
          amountCents: 10000,
          description: "Confirmed interior lobby painting",
        },
      ],
    };
    expect(PartnerMultiServicePriceSchema.safeParse(base).success).toBe(true);
    expect(
      PartnerMultiServicePriceSchema.safeParse({ ...base, reason: "ok" })
        .success,
    ).toBe(false);
    expect(
      PartnerMultiServicePriceSchema.safeParse({
        ...base,
        linePrices: [
          {
            ...base.linePrices[0],
            charges: [{ rateKey: "interior", quantity: "1e3" }],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("unions service-specific approval rules without multiplying a shared decision threshold", () => {
    const context = {
      partnerAccountId: randomUUID(),
      requestedByMembershipId: randomUUID(),
      requesterRoleKey: "operations",
      serviceKey: "painting",
      locationId: randomUUID(),
      amountMinor: null,
      currency: "USD",
      poNumber: null,
      costCenter: null,
    };
    const a = {
      id: randomUUID(),
      name: "Manager",
      version: 1,
      requiredApproverCapabilities: ["approvals.decide"],
      requiredApproverRoleKeys: [],
      requiredDecisionCount: 1,
    };
    const b = {
      ...a,
      id: randomUUID(),
      name: "Second approval",
      requiredDecisionCount: 2,
    };
    expect(
      combineMultiServiceApprovals([
        {
          context,
          required: true,
          requiredDecisionCount: 1,
          matchedRules: [a],
        },
        {
          context: { ...context, serviceKey: "soft-washing" },
          required: true,
          requiredDecisionCount: 2,
          matchedRules: [a, b],
        },
      ]),
    ).toMatchObject({
      required: true,
      requiredDecisionCount: 2,
      matchedRules: [a, b],
    });
  });
});

describe("saved multi-service rate authority", () => {
  const snapshot = (amount: string, minimum = "75.00") => ({
    ...completeTestPartnerRateCard(),
    rateCardVersionId: randomUUID(),
    version: 1,
    source: "structured",
    portalVisible: true,
    visitMinimum: minimum,
    rates: completeTestPartnerRateCard()
      .rates.filter((rate) => rate.serviceKey === "painting")
      .map((rate) => ({ ...rate, unitAmount: amount })),
  });
  const evidence = (
    rateSnapshot: Record<string, unknown> | null,
    pricingSnapshot: Record<string, unknown> | null = null,
  ) => ({
    serviceKey: "painting",
    scope: { workArea: "both" },
    rateSnapshot,
    pricingSnapshot,
  });
  it("keeps a submitted quote-required choice without reading later permanent prices", async () => {
    const quoted = {
      ...snapshot("100.00"),
      rates: [],
      quoteRequiredServiceKeys: ["painting"],
    };
    const result = await resolveApplicableServiceRates(evidence(quoted), () => {
      throw Error("Unexpected later rates");
    });
    expect(result).toMatchObject({
      rates: [],
      quoteRequiredServiceKeys: ["painting"],
      rateSources: [],
      visitMinimum: "75.00",
    });
    expect(
      await resolveApplicableServiceRates(evidence(quoted, result), () => {
        throw Error("Unexpected later rates");
      }),
    ).toEqual(result);
  });
  it("allows staff to explicitly configure a previously unpriced request for individual quoting", async () => {
    const current = {
      ...snapshot("100.00"),
      rates: [],
      quoteRequiredServiceKeys: ["painting"],
    };
    expect(
      await resolveApplicableServiceRates(evidence(null), () =>
        Promise.resolve(current),
      ),
    ).toMatchObject({ rates: [], quoteRequiredServiceKeys: ["painting"] });
    const saved = snapshot("100.00");
    saved.rates = saved.rates.filter((rate) => rate.variantKey === "interior");
    expect(
      await resolveApplicableServiceRates(evidence(saved), () =>
        Promise.resolve(current),
      ),
    ).toBeNull();
  });
  it("uses complete pricing evidence before submitted rates and never reads a later card", async () => {
    const priced = snapshot("100.00");
    const resolved = await resolveApplicableServiceRates(
      evidence(snapshot("200.00"), priced),
      () => {
        throw Error("Unexpected current-card read");
      },
    );
    expect(resolved).toMatchObject({
      rateCardVersionId: priced.rateCardVersionId,
      visitMinimum: "75.00",
    });
    expect(resolved!.rates.every((rate) => rate.unitAmount === "100.00")).toBe(
      true,
    );
  });
  it("fills only missing variants and preserves each source plus the submitted minimum", async () => {
    const saved = snapshot("100.00");
    saved.rates = saved.rates.filter((rate) => rate.variantKey === "interior");
    const current = snapshot("200.00", "150.00");
    const result = await resolveApplicableServiceRates(evidence(saved), () =>
      Promise.resolve(current),
    );
    expect(
      result!.rates.map((rate) => [rate.variantKey, rate.unitAmount]),
    ).toEqual([
      ["interior", "100.00"],
      ["exterior", "200.00"],
    ]);
    expect(
      result!.rateSources.map((source) => source.rateCardVersionId),
    ).toEqual([saved.rateCardVersionId, current.rateCardVersionId]);
    expect(result!.minimumRateCardVersionId).toBe(saved.rateCardVersionId);
    expect(result!.visitMinimum).toBe("75.00");
    const replay = await resolveApplicableServiceRates(
      evidence(saved, result),
      () => {
        throw Error("Unexpected current-card read");
      },
    );
    expect(replay).toEqual(result);
  });
  it("retains a submitted minimum even when that service had no rates", async () => {
    const saved = { ...snapshot("100.00"), portalVisible: false, rates: [] };
    const current = snapshot("200.00", "150.00");
    const result = await resolveApplicableServiceRates(evidence(saved), () =>
      Promise.resolve(current),
    );
    expect(result).toMatchObject({
      visitMinimum: "75.00",
      minimumRateCardVersionId: saved.rateCardVersionId,
      portalVisible: false,
    });
    expect(
      result!.rateSources.every(
        (source) => source.rateCardVersionId === current.rateCardVersionId,
      ),
    ).toBe(true);
  });
  it("returns missing for incomplete coverage without discarding submitted evidence", async () => {
    const saved = snapshot("100.00");
    saved.rates = saved.rates.filter((rate) => rate.variantKey === "interior");
    expect(
      await resolveApplicableServiceRates(evidence(saved), () =>
        Promise.resolve(saved),
      ),
    ).toBeNull();
    expect(saved.rates).toHaveLength(1);
  });
  it("uses newly published rates when no submitted card existed", async () => {
    const current = snapshot("200.00", "150.00");
    expect(
      await resolveApplicableServiceRates(evidence(null), () =>
        Promise.resolve(current),
      ),
    ).toMatchObject({
      rateCardVersionId: current.rateCardVersionId,
      visitMinimum: "150.00",
    });
  });
  it("rejects malformed and wrong-service saved evidence", async () => {
    await expect(
      resolveApplicableServiceRates(
        evidence({ ...snapshot("100.00"), visitMinimum: "invalid" }),
        () => Promise.resolve(null),
      ),
    ).rejects.toThrow("partner_service_rate_snapshot_invalid");
    const wrong = {
      ...snapshot("100.00"),
      rates: completeTestPartnerRateCard().rates.filter(
        (rate) => rate.serviceKey === "pressure-washing",
      ),
    };
    await expect(
      resolveApplicableServiceRates(evidence(wrong), () =>
        Promise.resolve(null),
      ),
    ).rejects.toThrow("partner_service_rate_snapshot_invalid");
  });
});
