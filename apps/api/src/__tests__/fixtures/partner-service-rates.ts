import {
  PARTNER_SERVICE_DEFINITIONS,
  type PartnerServiceRateCardInput,
} from "@myst-os/pricing";
/** Deliberately synthetic prices for disposable database tests, never production defaults. */
export function completeTestPartnerRateCard(): PartnerServiceRateCardInput {
  return {
    currency: "USD",
    visitMinimum: "75.00",
    effectiveFrom: "2020-01-01T00:00:00.000Z",
    effectiveTo: null,
    rates: PARTNER_SERVICE_DEFINITIONS.flatMap((service) =>
      service.variants.map((variant) => ({
        key: `${service.key}_${variant.key}`,
        serviceKey: service.key,
        variantKey: variant.key,
        label: `${service.label}: ${variant.label}`,
        unit: "job" as const,
        unitAmount: "100.00",
        measurement: "One defined synthetic test project",
        inclusions: ["The work explicitly described in this test"],
        exclusions: [],
        materials:
          service.key === "painting" || service.key === "drywall-repair-paint"
            ? ("stonegate" as const)
            : null,
        coats:
          service.key === "painting" || service.key === "drywall-repair-paint"
            ? 2
            : null,
        fullLoadCubicYards: null,
      })),
    ),
  };
}
