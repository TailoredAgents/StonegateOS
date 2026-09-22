import { randomUUID } from "node:crypto";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { PARTNER_SERVICE_DEFINITIONS } from "@myst-os/pricing";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  name: string,
  factory: () => Record<string, unknown>,
) => void;
const accountId = randomUUID();
const cardId = randomUUID();
const agreement = {
  agreementLabel: "Saved legacy agreement",
  currency: "USD",
  effectiveFrom: new Date("2020-01-01T00:00:00Z"),
  effectiveTo: null,
  services: ["junk-removal", "land-clearing"].map((serviceKey) => ({
    serviceKey,
    pricingState: "contracted",
    inclusions: [],
    exclusions: [],
    quoteRule: null,
  })),
};
let responses: unknown[][] = [];
let conditions: SQL[] = [];
const db = {
  select: () => {
    const response = responses.shift();
    if (!response) throw Error("Unexpected catalog query");
    const query = {
      from: () => query,
      leftJoin: () => query,
      innerJoin: () => query,
      where: (condition: SQL) => {
        conditions.push(condition);
        return query;
      },
      limit: () => query,
      orderBy: () => query,
      then: (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(response).then(resolve),
    };
    return query;
  },
};
mockModule("@/db", () => ({ ...schema, getDb: () => db }));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerMultiServiceRequestsEnabled: () => true,
}));
mockModule("@/lib/partner-account-service-agreement-service", () => ({
  projectPartnerAccountServiceAgreement: () => agreement,
  PartnerServiceAgreementConfigurationError: class extends Error {},
}));
const { listPartnerServiceCatalog } = await import(
  "@/lib/partner-portal-v2-service-catalog"
);

function setupLegacy(revealPrices: boolean, disabled: string[] = []) {
  const keys = ["junk-removal", "land-clearing"].filter(
    (key) => !disabled.includes(key),
  );
  responses = [
    [{}],
    [{ config: { disabledServiceKeys: disabled } }],
    keys.map((key) => ({
      key,
      label: key,
      description: "Legacy service",
      requiredScopeFields: [],
      defaultProofRequirements: {},
      profileVersion: 1,
    })),
    [
      {
        serviceKey: "junk-removal",
        key: "mattress_disposal",
        label: "Mattress disposal",
        description: "One mattress",
        unitLabel: "mattress",
        minimumQuantity: 1,
        maximumQuantity: 20,
        instantConfirmationMaxQuantity: 10,
        requiresReview: false,
        sortOrder: 1,
      },
    ],
    [
      {
        id: cardId,
        currency: "USD",
        version: 1,
        effectiveFrom: new Date("2020-01-01T00:00:00Z"),
      },
    ],
    keys.map((serviceKey) => ({
      serviceKey,
      amountMinor: 25000,
      currency: "USD",
      rateCardId: cardId,
      tierKey: serviceKey === "junk-removal" ? "half" : "small_patch",
      label: "Agreed scope",
      sortOrder: 1,
    })),
    ...(revealPrices
      ? [
          [
            {
              rateCardId: cardId,
              serviceKey: "junk-removal",
              addOnKey: "mattress_disposal",
              unitAmountMinor: 3000,
            },
          ],
        ]
      : []),
  ];
}

describe("legacy catalog representation with multi-service requests enabled", () => {
  beforeEach(() => {
    responses = [];
    conditions = [];
  });
  it("keeps the default eight-service representation", async () => {
    responses = [[{}], [{ config: {} }]];
    const result = await listPartnerServiceCatalog({
      accountId,
      revealPrices: true,
    });
    expect(result.map((service) => service.key)).toEqual(
      PARTNER_SERVICE_DEFINITIONS.map((service) => service.key),
    );
    expect(result.every((service) => service.baseOptions.length === 0)).toBe(
      true,
    );
    expect(responses).toHaveLength(0);
  });
  it.each([true, false])(
    "preserves legacy keys, base choices and add-ons with price permission %s",
    async (revealPrices) => {
      setupLegacy(revealPrices);
      const result = await listPartnerServiceCatalog({
        accountId,
        revealPrices,
        requestModelVersion: 1,
      });
      expect(result.map((service) => service.key)).toEqual([
        "junk-removal",
        "land-clearing",
      ]);
      expect(result[0]!.baseOptions).toMatchObject([
        {
          tierKey: "half",
          price: revealPrices ? { amountMinor: 25000 } : null,
        },
      ]);
      expect(result[0]!.addOns).toMatchObject([
        {
          key: "mattress_disposal",
          unitPrice: revealPrices ? { amountMinor: 3000 } : null,
        },
      ]);
      expect(result[1]!.baseOptions).toMatchObject([
        { tierKey: "small_patch" },
      ]);
      if (!revealPrices) {
        expect(
          result.every(
            (service) =>
              service.pricingStatus === "hidden" && service.basePrice === null,
          ),
        ).toBe(true);
        expect(JSON.stringify(result)).not.toContain("25000");
        expect(JSON.stringify(result)).not.toContain("3000");
      }
      const dialect = new PgDialect();
      // Agreement, account, selected card and optional add-on prices stay tenant-bound.
      for (const index of revealPrices ? [0, 1, 4, 6] : [0, 1, 4])
        expect(dialect.sqlToQuery(conditions[index]!).params).toContain(
          accountId,
        );
      expect(responses).toHaveLength(0);
    },
  );
  it("keeps explicit company restrictions in the legacy query", async () => {
    setupLegacy(true, ["land-clearing"]);
    const result = await listPartnerServiceCatalog({
      accountId,
      revealPrices: true,
      requestModelVersion: 1,
    });
    const serviceParameters = new PgDialect().sqlToQuery(conditions[2]!).params;
    expect(serviceParameters).toContain("junk-removal");
    expect(serviceParameters).not.toContain("land-clearing");
    expect(result.map((service) => service.key)).toEqual(["junk-removal"]);
  });
});
