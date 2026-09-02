export type PartnerServiceRateItem = Readonly<{
  id: string;
  serviceKey: string;
  serviceLabel: string;
  tierKey: string;
  label: string | null;
  amountCents: number;
  sortOrder: number;
}>;

type PartnerAgreementPricingState =
  | "contracted"
  | "estimate"
  | "quote_required"
  | "standard_rate";

const PARTNER_AGREEMENT_PRICING_STATES = new Set<string>([
  "contracted",
  "estimate",
  "quote_required",
  "standard_rate",
]);

function isPartnerAgreementPricingState(
  value: unknown,
): value is PartnerAgreementPricingState {
  return (
    typeof value === "string" && PARTNER_AGREEMENT_PRICING_STATES.has(value)
  );
}

export type PartnerServiceAgreementPresentation = Readonly<{
  label: string;
  currency: string;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  inclusions: string[];
  exclusions: string[];
  quoteRules: string | null;
  services: Array<
    Readonly<{
      serviceKey: string;
      pricingState: PartnerAgreementPricingState;
      inclusions: string[];
      exclusions: string[];
      quoteRule: string | null;
    }>
  >;
  document: Readonly<{ id: string; filename: string }> | null;
}>;

export type PartnerServiceRateCardState =
  | {
      status: "ready";
      currency: string;
      items: PartnerServiceRateItem[];
      agreement?: PartnerServiceAgreementPresentation;
    }
  | { status: "forbidden" | "unavailable" | "error" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogMoney(value: unknown): {
  amountMinor: number;
  currency: string;
} | null {
  if (!isRecord(value)) return null;
  const amountMinor = value["amountMinor"];
  const currency = value["currency"];
  if (
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/u.test(currency) ||
    value["minorUnit"] !== 2
  ) {
    return null;
  }
  return { amountMinor, currency };
}

function boundedTextList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 40) return null;
  const items = value.filter(
    (item): item is string =>
      typeof item === "string" &&
      item.length >= 1 &&
      item.length <= 500 &&
      item === item.trim(),
  );
  return items.length === value.length ? items : null;
}

function parseAgreement(
  value: unknown,
): PartnerServiceAgreementPresentation | null {
  if (!isRecord(value) || !Array.isArray(value["services"])) return null;
  const label = value["label"];
  const currency = value["currency"];
  const active = value["active"];
  const effectiveFrom = value["effectiveFrom"];
  const effectiveTo = value["effectiveTo"];
  const inclusions = boundedTextList(value["inclusions"]);
  const exclusions = boundedTextList(value["exclusions"]);
  const quoteRules = value["quoteRules"];
  const rawDocument = value["document"];
  if (
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 160 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/u.test(currency) ||
    active !== true ||
    typeof effectiveFrom !== "string" ||
    Number.isNaN(new Date(effectiveFrom).getTime()) ||
    (effectiveTo !== null &&
      (typeof effectiveTo !== "string" ||
        Number.isNaN(new Date(effectiveTo).getTime()))) ||
    !inclusions ||
    !exclusions ||
    (quoteRules !== null &&
      (typeof quoteRules !== "string" || quoteRules.length > 2_000)) ||
    (rawDocument !== null && !isRecord(rawDocument))
  ) {
    return null;
  }
  const services = value["services"].map((raw) => {
    if (!isRecord(raw)) return null;
    const serviceKey = raw["serviceKey"];
    const pricingState = raw["pricingState"];
    const serviceInclusions = boundedTextList(raw["inclusions"]);
    const serviceExclusions = boundedTextList(raw["exclusions"]);
    const quoteRule = raw["quoteRule"];
    if (
      typeof serviceKey !== "string" ||
      !/^[a-z][a-z0-9_-]{1,79}$/u.test(serviceKey) ||
      !isPartnerAgreementPricingState(pricingState) ||
      !serviceInclusions ||
      !serviceExclusions ||
      (quoteRule !== null &&
        (typeof quoteRule !== "string" || quoteRule.length > 1_000))
    ) {
      return null;
    }
    return {
      serviceKey,
      pricingState,
      inclusions: serviceInclusions,
      exclusions: serviceExclusions,
      quoteRule,
    };
  });
  if (services.some((service) => service === null)) return null;
  const document = isRecord(rawDocument)
    ? typeof rawDocument["id"] === "string" &&
      typeof rawDocument["filename"] === "string" &&
      rawDocument["filename"].trim().length > 0
      ? { id: rawDocument["id"], filename: rawDocument["filename"].trim() }
      : null
    : null;
  if (rawDocument !== null && !document) return null;
  return {
    label: label.trim(),
    currency,
    active,
    effectiveFrom,
    effectiveTo,
    inclusions,
    exclusions,
    quoteRules,
    services: services.filter(
      (service): service is NonNullable<(typeof services)[number]> =>
        service !== null,
    ),
    document,
  };
}

/**
 * Flattens the sanitized V2 service catalog into a display-only rate card.
 * IDs are deterministic public keys; provider, rate-card, and rate-item IDs
 * never enter the Site model. A catalog with hidden pricing is fail-closed.
 */
export function parsePartnerServiceRateCard(
  payload: unknown,
): PartnerServiceRateCardState {
  if (!isRecord(payload) || !Array.isArray(payload["services"])) {
    return { status: "error" };
  }
  const items: PartnerServiceRateItem[] = [];
  const currencies = new Set<string>();
  let hiddenPricing = false;

  for (const [serviceIndex, rawService] of payload["services"].entries()) {
    if (!isRecord(rawService)) return { status: "error" };
    const serviceKey = rawService["key"];
    const serviceLabel = rawService["label"];
    if (
      typeof serviceKey !== "string" ||
      !/^[a-z][a-z0-9_-]{1,79}$/u.test(serviceKey) ||
      typeof serviceLabel !== "string" ||
      !serviceLabel.trim()
    ) {
      return { status: "error" };
    }
    hiddenPricing ||= rawService["pricingStatus"] === "hidden";
    const baseOptions = rawService["baseOptions"];
    const addOns = rawService["addOns"];
    if (!Array.isArray(baseOptions) || !Array.isArray(addOns)) {
      return { status: "error" };
    }

    for (const [optionIndex, rawOption] of baseOptions.entries()) {
      if (!isRecord(rawOption)) return { status: "error" };
      hiddenPricing ||= rawOption["pricingStatus"] === "hidden";
      const price = catalogMoney(rawOption["price"]);
      if (rawOption["price"] !== null && !price) return { status: "error" };
      if (!price) continue;
      const tierKey = rawOption["tierKey"];
      const label = rawOption["label"];
      if (
        typeof tierKey !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(tierKey) ||
        typeof label !== "string" ||
        !label.trim()
      ) {
        return { status: "error" };
      }
      currencies.add(price.currency);
      items.push({
        id: `${serviceKey}:base:${tierKey}`,
        serviceKey,
        serviceLabel: serviceLabel.trim(),
        tierKey,
        label: label.trim(),
        amountCents: price.amountMinor,
        sortOrder: serviceIndex * 1_000 + optionIndex,
      });
    }

    for (const [addOnIndex, rawAddOn] of addOns.entries()) {
      if (!isRecord(rawAddOn)) return { status: "error" };
      hiddenPricing ||= rawAddOn["pricingStatus"] === "hidden";
      const price = catalogMoney(rawAddOn["unitPrice"]);
      if (rawAddOn["unitPrice"] !== null && !price) {
        return { status: "error" };
      }
      if (!price) continue;
      const addOnKey = rawAddOn["key"];
      const label = rawAddOn["label"];
      const unitLabel = rawAddOn["unitLabel"];
      if (
        typeof addOnKey !== "string" ||
        !/^[a-z][a-z0-9_-]{1,79}$/u.test(addOnKey) ||
        typeof label !== "string" ||
        !label.trim() ||
        typeof unitLabel !== "string" ||
        !unitLabel.trim()
      ) {
        return { status: "error" };
      }
      currencies.add(price.currency);
      items.push({
        id: `${serviceKey}:add-on:${addOnKey}`,
        serviceKey,
        serviceLabel: serviceLabel.trim(),
        tierKey: addOnKey,
        label: `${label.trim()} (per ${unitLabel.trim()})`,
        amountCents: price.amountMinor,
        sortOrder: serviceIndex * 1_000 + 500 + addOnIndex,
      });
    }
  }

  const agreement = parseAgreement(payload["agreement"]);
  if (payload["agreement"] !== undefined && !agreement) {
    return { status: "error" };
  }
  if (items.length === 0 && hiddenPricing) return { status: "forbidden" };
  if (
    currencies.size > 1 ||
    (agreement && currencies.size === 1 && !currencies.has(agreement.currency))
  ) {
    return { status: "error" };
  }
  return {
    status: "ready",
    currency: agreement?.currency ?? [...currencies][0] ?? "USD",
    items: items.sort(
      (left, right) =>
        left.serviceLabel.localeCompare(right.serviceLabel) ||
        left.sortOrder - right.sortOrder,
    ),
    ...(agreement ? { agreement } : {}),
  };
}
