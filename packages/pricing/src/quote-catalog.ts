import { bundles, serviceRates, zones } from "./config/defaults";

export const professionalQuoteServicePresets = serviceRates.map((service) => ({
  id: service.service,
  catalogKey: `service:${service.service}`,
  name: service.label,
  description: service.description ?? "",
  unit: "project",
  suggestedUnitPriceCents: Math.round(
    Number(service.flatRate ?? service.basePrice ?? 0) * 100,
  ),
}));

export const professionalQuoteZonePresets = zones.map((zone) => ({
  id: zone.id,
  name: zone.name,
  travelFeeCents: Math.round(zone.travelFee * 100),
  postalCodes: [...zone.zipCodes],
}));

export const professionalQuoteBundlePresets = bundles.map((bundle) => ({
  id: bundle.id,
  adjustmentId: `bundle:${bundle.id}`,
  name: bundle.name,
  requiredCatalogKeys: bundle.services.map((service) => `service:${service}`),
  basisPoints: Math.round(bundle.discountPercentage * 100),
}));

export const professionalQuoteServiceCatalogKeys = new Set(
  professionalQuoteServicePresets.map((preset) => preset.catalogKey),
);

export const professionalQuoteZoneIds = new Set(
  professionalQuoteZonePresets.map((preset) => preset.id),
);
