import { serviceRates } from "@myst-os/pricing/src/config/defaults";
import type { ServiceCategory } from "@myst-os/pricing";

type QuotePresetService = Exclude<ServiceCategory, "other">;

const QUOTE_SERVICE_PATTERNS = {
  "house-wash": [
    /house[ -]?wash/i,
    /home[ -]?wash/i,
    /soft[ -]?wash/i,
    /siding/i,
    /brick.*wash/i,
  ],
  "junk-removal": [
    /junk[ -]?removal/i,
    /trailer[ -]?(?:load|volume|tier)/i,
    /(?:quarter|half|three[ -]?quarter|full)[ -]?(?:trailer|load)/i,
  ],
  "single-item": [
    /rubbish/i,
    /trash/i,
    /garbage/i,
    /household/i,
    /single[ -]?item/i,
    /tv/i,
    /mattress/i,
  ],
  furniture: [/furniture/i, /sofa/i, /couch/i, /dresser/i, /bed/i],
  appliances: [
    /appliance/i,
    /fridge/i,
    /refrigerator/i,
    /washer/i,
    /dryer/i,
    /stove/i,
    /oven/i,
  ],
  "yard-waste": [
    /yard[ -]?waste/i,
    /brush/i,
    /branches?/i,
    /bagged leaves/i,
    /landscap(?:e|ing)/i,
  ],
  "construction-debris": [
    /construction/i,
    /debris/i,
    /demolition/i,
    /renovation/i,
    /remodel(?:ing)?/i,
  ],
  "hot-tub": [/hot[ -]?tub/i, /spa removal/i, /jacuzzi/i],
  driveway: [/driveway/i, /concrete.*(?:wash|clean|degreas)/i],
  roof: [/roof.*(?:wash|clean|treat)/i, /algae.*shingle/i],
  deck: [/deck/i, /patio.*(?:wash|clean|restore)/i, /porch.*(?:wash|clean)/i],
  gutter: [/gutter/i, /downspout/i],
  commercial: [
    /commercial exterior/i,
    /storefront.*(?:wash|clean)/i,
    /multi[ -]?unit.*exterior/i,
  ],
} as const satisfies Record<QuotePresetService, readonly RegExp[]>;

export const QUOTE_SERVICE_KEYWORDS = Object.entries(
  QUOTE_SERVICE_PATTERNS,
).map(([id, patterns]) => ({
  id: id as QuotePresetService,
  patterns,
}));

const ACTIONABLE_SERVICE_IDS = new Set(
  serviceRates
    .filter(
      (service) =>
        service.service !== "other" &&
        Number(service.flatRate ?? service.basePrice) > 0,
    )
    .map((service) => service.service),
);

const SPECIFIC_JUNK_SERVICES = new Set<QuotePresetService>([
  "single-item",
  "furniture",
  "appliances",
  "yard-waste",
  "construction-debris",
  "hot-tub",
]);

function addMatchingServices(text: string, services: string[]): void {
  const normalized = text.trim();
  if (!normalized) return;

  for (const entry of QUOTE_SERVICE_KEYWORDS) {
    const isExactId = normalized.toLowerCase() === entry.id;
    const isKnownAlias = entry.patterns.some((pattern) =>
      pattern.test(normalized),
    );
    if ((isExactId || isKnownAlias) && !services.includes(entry.id)) {
      services.push(entry.id);
    }
  }
}

/**
 * Converts untrusted classifier hints and free text into catalog-backed service
 * identifiers. Unknown hints are discarded so an AI suggestion can never carry
 * an arbitrary pricing identifier into the quote mutation.
 */
export function deriveCanonicalQuoteServices(
  message: string,
  hints?: readonly string[] | null,
): string[] {
  const services: string[] = [];

  for (const hint of hints ?? []) {
    if (typeof hint === "string") {
      addMatchingServices(hint, services);
    }
  }
  addMatchingServices(message, services);

  if (
    services.includes("junk-removal") &&
    services.some((service) =>
      SPECIFIC_JUNK_SERVICES.has(service as QuotePresetService),
    )
  ) {
    services.splice(services.indexOf("junk-removal"), 1);
  }

  return services.slice(0, 3);
}

/** Generic trailer-volume pricing needs a tier before the adapter can price it. */
export function areCanonicalQuoteServicesActionable(
  services: readonly string[],
): boolean {
  return (
    services.length > 0 &&
    services.every((service) =>
      ACTIONABLE_SERVICE_IDS.has(service as ServiceCategory),
    )
  );
}
