import { randomUUID } from "node:crypto";
import {
  PartnerServiceRateDraftSchema,
  PartnerServiceRateCardInputSchema,
  formatPartnerServiceRate,
  getPartnerRateCompleteness,
} from "@myst-os/pricing";
import {
  loadPartnerPublishedServiceRateCard,
  loadPartnerServiceRateSnapshot,
} from "@/lib/partner-structured-rates";
import { completeTestPartnerRateCard } from "./fixtures/partner-service-rates";

function reader(responses: unknown[][]) {
  return {
    select: () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected read");
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (value: unknown[]) => unknown) =>
          Promise.resolve(response).then(resolve),
      };
      return query;
    },
  } as unknown as Parameters<typeof loadPartnerPublishedServiceRateCard>[0];
}
const accountId = randomUUID();
const version = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  version: 3,
  pricingModelVersion: 2,
  active: true,
  currency: "USD",
  effectiveFrom: new Date("2020-01-01Z"),
  effectiveTo: null,
  visitMinimumAmount: "75.00",
  portalVisible: true,
  ...overrides,
});
const row = (rate = completeTestPartnerRateCard().rates[0]!) => ({
  id: randomUUID(),
  serviceKey: rate.serviceKey,
  tierKey: rate.key,
  pricingRules: { modelVersion: 2, rate },
  amountCents: 0,
  label: rate.label,
});

describe("structured partner rate authority", () => {
  it("keeps fractional-cent unit prices exact without reading the compatibility cents", async () => {
    const rate = {
      ...completeTestPartnerRateCard().rates[1]!,
      unit: "sq_ft" as const,
      unitAmount: "0.1255",
    };
    const result = await loadPartnerServiceRateSnapshot(
      reader([[version()], [row(rate)]]),
      { accountId, serviceKey: rate.serviceKey },
    );
    expect(result?.rates[0]?.unitAmount).toBe("0.1255");
    expect(formatPartnerServiceRate(rate, "USD")).toBe("$0.1255 / square foot");
    expect(result?.visitMinimum).toBe("75.00");
  });
  it("never resurrects an older or legacy card after the latest effective publication expires", async () => {
    expect(
      await loadPartnerPublishedServiceRateCard(
        reader([[version({ effectiveTo: new Date("2021-01-01Z") })]]),
        { accountId },
      ),
    ).toBeNull();
  });
  it("retains the exact legacy tiers without inventing service variants or unit prices", async () => {
    const legacy = {
      id: randomUUID(),
      serviceKey: "land-clearing",
      tierKey: "small_patch",
      label: "Agreed small patch",
      amountCents: 12345,
    };
    const result = await loadPartnerPublishedServiceRateCard(
      reader([[], [version({ pricingModelVersion: 1 })], [legacy]]),
      { accountId },
    );
    expect(result).toMatchObject({
      source: "legacy",
      rates: [],
      complete: false,
      legacyItems: [legacy],
    });
  });
  it("uses the current flat card instead of its old migration snapshot", async () => {
    const current = {
      id: randomUUID(),
      serviceKey: "junk-removal",
      tierKey: "full",
      label: "Full load",
      amountCents: 98765,
    };
    const result = await loadPartnerPublishedServiceRateCard(
      reader([
        [version({ pricingModelVersion: 1 })],
        [version({ version: 5, pricingModelVersion: 1 })],
        [current],
      ]),
      { accountId },
    );
    expect(result?.legacyItems).toEqual([current]);
  });
  it("does not resurrect an active migration snapshot after the actual legacy card is disabled", async () => {
    expect(
      await loadPartnerPublishedServiceRateCard(
        reader([
          [version({ pricingModelVersion: 1 })],
          [version({ pricingModelVersion: 1, active: false })],
        ]),
        { accountId },
      ),
    ).toBeNull();
  });
  it("does not mistake malformed published data for missing rates", async () => {
    await expect(
      loadPartnerPublishedServiceRateCard(
        reader([
          [version()],
          [{ ...row(), pricingRules: { modelVersion: 2, rate: {} } }],
        ]),
        { accountId },
      ),
    ).rejects.toThrow("snapshot_invalid");
    await expect(
      loadPartnerPublishedServiceRateCard(
        reader([[version()], [{ ...row(), serviceKey: "painting" }]]),
        { accountId },
      ),
    ).rejects.toThrow("snapshot_invalid");
  });
  it("supports incomplete drafts, while publication validates measurements and paint coverage", () => {
    const draft = completeTestPartnerRateCard();
    draft.rates[0]!.unitAmount = "";
    expect(PartnerServiceRateDraftSchema.safeParse(draft).success).toBe(true);
    expect(PartnerServiceRateCardInputSchema.safeParse(draft).success).toBe(
      false,
    );
    const card = completeTestPartnerRateCard();
    card.rates.find((rate) => rate.serviceKey === "painting")!.coats = null;
    expect(PartnerServiceRateCardInputSchema.safeParse(card).success).toBe(
      false,
    );
  });
  it("counts explicit quote-required services as configured without treating blanks as quotes", () => {
    const card = completeTestPartnerRateCard();
    card.rates = card.rates.filter(
      (rate) => !["painting", "drywall-repair-paint"].includes(rate.serviceKey),
    );
    expect(getPartnerRateCompleteness(card.rates).complete).toBe(false);
    card.quoteRequiredServiceKeys = ["painting", "drywall-repair-paint"];
    expect(
      PartnerServiceRateDraftSchema.parse(card).quoteRequiredServiceKeys,
    ).toEqual(card.quoteRequiredServiceKeys);
    expect(PartnerServiceRateCardInputSchema.safeParse(card).success).toBe(
      true,
    );
    expect(
      getPartnerRateCompleteness(card.rates, card.quoteRequiredServiceKeys),
    ).toEqual({ complete: true, missing: [] });
    for (const keys of [["painting", "painting"], ["unknown-service"]]) {
      expect(
        PartnerServiceRateCardInputSchema.safeParse({
          ...card,
          quoteRequiredServiceKeys: keys,
        }).success,
      ).toBe(false);
    }
    expect(
      PartnerServiceRateCardInputSchema.safeParse({
        ...completeTestPartnerRateCard(),
        quoteRequiredServiceKeys: ["painting"],
      }).success,
    ).toBe(false);
  });
  it("loads published quote choices and narrows them to each service without prices", async () => {
    const card = completeTestPartnerRateCard();
    const quoteRequiredServiceKeys = ["painting", "drywall-repair-paint"];
    const rows = card.rates
      .filter((rate) => !quoteRequiredServiceKeys.includes(rate.serviceKey))
      .map((rate) => row(rate));
    const stored = version({ quoteRequiredServiceKeys });
    const published = await loadPartnerPublishedServiceRateCard(
      reader([[stored], rows]),
      { accountId },
    );
    expect(published).toMatchObject({
      complete: true,
      quoteRequiredServiceKeys,
    });
    const service = await loadPartnerServiceRateSnapshot(
      reader([[stored], rows]),
      { accountId, serviceKey: "painting" },
    );
    expect(service).toMatchObject({
      rates: [],
      quoteRequiredServiceKeys: ["painting"],
    });
    await expect(
      loadPartnerPublishedServiceRateCard(
        reader([
          [stored],
          [row(card.rates.find((rate) => rate.serviceKey === "painting"))],
        ]),
        { accountId },
      ),
    ).rejects.toThrow("conflicting_pricing");
  });
  it("requires every variant for activation but permits an existing partner's partial card", () => {
    const card = completeTestPartnerRateCard();
    expect(getPartnerRateCompleteness(card.rates).complete).toBe(true);
    const partial = {
      ...card,
      rates: card.rates.filter((rate) => rate.variantKey !== "roof"),
    };
    expect(PartnerServiceRateCardInputSchema.safeParse(partial).success).toBe(
      true,
    );
    expect(getPartnerRateCompleteness(partial.rates)).toMatchObject({
      complete: false,
      missing: [{ serviceKey: "soft-washing", variantKey: "roof" }],
    });
  });
});
