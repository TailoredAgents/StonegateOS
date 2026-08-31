export type PartnerServiceRateItem = Readonly<{
  id: string;
  serviceKey: string;
  serviceLabel: string;
  tierKey: string;
  label: string | null;
  amountCents: number;
  sortOrder: number;
}>;

export type PartnerServiceRateCardState =
  | {
      status: "ready";
      currency: string;
      items: PartnerServiceRateItem[];
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

  if (items.length === 0 && hiddenPricing) return { status: "forbidden" };
  if (currencies.size > 1) return { status: "error" };
  return {
    status: "ready",
    currency: [...currencies][0] ?? "USD",
    items: items.sort(
      (left, right) =>
        left.serviceLabel.localeCompare(right.serviceLabel) ||
        left.sortOrder - right.sortOrder,
    ),
  };
}
