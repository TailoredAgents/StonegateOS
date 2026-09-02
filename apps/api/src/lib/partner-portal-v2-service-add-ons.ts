export const MAX_PARTNER_SERVICE_ADD_ONS = 20;
export const MAX_PARTNER_ADD_ON_QUANTITY = 100;

export type PartnerSelectedAddOn = Readonly<{
  key: string;
  quantity: number;
}>;

export type PartnerConfiguredAddOn = Readonly<{
  key: string;
  label: string;
  unitLabel: string;
  minimumQuantity: number;
  maximumQuantity: number;
  instantConfirmationMaxQuantity: number | null;
  requiresReview: boolean;
  unitAmountMinor: number | null;
  currency: string | null;
}>;

export type PartnerAddOnSnapshot = Readonly<{
  key: string;
  label: string;
  unitLabel: string;
  quantity: number;
  unitAmountMinor: number | null;
  lineTotalMinor: number | null;
  currency: string | null;
  requiresReview: boolean;
}>;

export type PartnerBookingPriceResolution = Readonly<{
  status:
    | "contracted"
    | "estimate"
    | "quote_required"
    | "standard_rate"
    | "review_required";
  baseAmountMinor: number | null;
  addOnTotalMinor: number | null;
  totalAmountMinor: number | null;
  currency: string;
  addOns: readonly PartnerAddOnSnapshot[];
  allAddOnsPriced: boolean;
  addOnReviewRequired: boolean;
}>;

function safeMoney(value: number | null): value is number {
  return (
    value !== null &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function normalizedCurrency(value: string | null): string | null {
  const currency = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{3}$/u.test(currency) ? currency : null;
}

/**
 * Resolves a partner-visible, immutable pricing snapshot from server-loaded
 * account rates. Callers never pass client supplied labels or prices here.
 */
export function resolvePartnerBookingPrice(input: {
  baseAmountMinor: number | null;
  baseCurrency: string | null;
  priceState?:
    | "contracted"
    | "estimate"
    | "quote_required"
    | "standard_rate";
  selectedAddOns: readonly PartnerSelectedAddOn[];
  configuredAddOns: readonly PartnerConfiguredAddOn[];
}): PartnerBookingPriceResolution {
  const baseCurrency = normalizedCurrency(input.baseCurrency) ?? "USD";
  const baseAmountMinor = safeMoney(input.baseAmountMinor)
    ? input.baseAmountMinor
    : null;
  const options = new Map(
    input.configuredAddOns.map((option) => [option.key, option] as const),
  );
  const seen = new Set<string>();
  let addOnTotalMinor = 0;
  let allAddOnsPriced = true;
  let addOnReviewRequired = false;
  const addOns: PartnerAddOnSnapshot[] = [];

  for (const selection of [...input.selectedAddOns].sort((left, right) =>
    left.key.localeCompare(right.key),
  )) {
    const option = options.get(selection.key);
    if (
      !option ||
      seen.has(selection.key) ||
      !Number.isSafeInteger(selection.quantity) ||
      selection.quantity < option.minimumQuantity ||
      selection.quantity > option.maximumQuantity
    ) {
      throw new TypeError("Invalid configured partner add-on selection.");
    }
    seen.add(selection.key);
    const currency = normalizedCurrency(option.currency);
    const unitAmountMinor = safeMoney(option.unitAmountMinor)
      ? option.unitAmountMinor
      : null;
    const rawLineTotal =
      unitAmountMinor === null ? null : unitAmountMinor * selection.quantity;
    const lineTotalMinor = safeMoney(rawLineTotal) ? rawLineTotal : null;
    const priced =
      unitAmountMinor !== null &&
      lineTotalMinor !== null &&
      currency === baseCurrency;
    if (!priced) allAddOnsPriced = false;
    if (priced) {
      const nextTotal = addOnTotalMinor + lineTotalMinor;
      if (!Number.isSafeInteger(nextTotal)) {
        allAddOnsPriced = false;
      } else {
        addOnTotalMinor = nextTotal;
      }
    }
    const requiresReview =
      option.requiresReview ||
      (option.instantConfirmationMaxQuantity !== null &&
        selection.quantity > option.instantConfirmationMaxQuantity);
    if (requiresReview) addOnReviewRequired = true;
    addOns.push(
      Object.freeze({
        key: option.key,
        label: option.label,
        unitLabel: option.unitLabel,
        quantity: selection.quantity,
        unitAmountMinor: priced ? unitAmountMinor : null,
        lineTotalMinor: priced ? lineTotalMinor : null,
        currency: priced ? currency : null,
        requiresReview,
      }),
    );
  }

  const rawTotal =
    baseAmountMinor === null || !allAddOnsPriced
      ? null
      : baseAmountMinor + addOnTotalMinor;
  const totalAmountMinor = safeMoney(rawTotal) ? rawTotal : null;
  const configuredPrice = totalAmountMinor !== null;
  const requestedState = input.priceState ?? "contracted";
  return Object.freeze({
    status:
      requestedState === "quote_required"
        ? "quote_required"
        : configuredPrice
          ? requestedState
          : "review_required",
    baseAmountMinor,
    addOnTotalMinor: allAddOnsPriced ? addOnTotalMinor : null,
    totalAmountMinor,
    currency: baseCurrency,
    addOns: Object.freeze(addOns),
    allAddOnsPriced,
    addOnReviewRequired,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail closed when projecting historical JSON into a partner response. */
export function projectPartnerAddOnSnapshots(
  value: unknown,
): readonly PartnerAddOnSnapshot[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const result: PartnerAddOnSnapshot[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, MAX_PARTNER_SERVICE_ADD_ONS)) {
    if (!isRecord(candidate)) continue;
    const key = typeof candidate["key"] === "string" ? candidate["key"] : "";
    const label =
      typeof candidate["label"] === "string" ? candidate["label"].trim() : "";
    const unitLabel =
      typeof candidate["unitLabel"] === "string"
        ? candidate["unitLabel"].trim()
        : "";
    const quantity = candidate["quantity"];
    if (
      !/^[a-z][a-z0-9_-]{1,79}$/u.test(key) ||
      !label ||
      !unitLabel ||
      seen.has(key) ||
      !Number.isSafeInteger(quantity) ||
      Number(quantity) < 1 ||
      Number(quantity) > MAX_PARTNER_ADD_ON_QUANTITY
    ) {
      continue;
    }
    seen.add(key);
    const currency =
      typeof candidate["currency"] === "string"
        ? normalizedCurrency(candidate["currency"])
        : null;
    const unitAmount = candidate["unitAmountMinor"];
    const lineTotal = candidate["lineTotalMinor"];
    const unitAmountMinor =
      typeof unitAmount === "number" && safeMoney(unitAmount)
        ? unitAmount
        : null;
    const lineTotalMinor =
      typeof lineTotal === "number" && safeMoney(lineTotal) ? lineTotal : null;
    const priced =
      currency !== null &&
      unitAmountMinor !== null &&
      lineTotalMinor === unitAmountMinor * Number(quantity);
    result.push(
      Object.freeze({
        key,
        label: label.slice(0, 200),
        unitLabel: unitLabel.slice(0, 80),
        quantity: Number(quantity),
        unitAmountMinor: priced ? unitAmountMinor : null,
        lineTotalMinor: priced ? lineTotalMinor : null,
        currency: priced ? currency : null,
        requiresReview: candidate["requiresReview"] === true,
      }),
    );
  }
  return Object.freeze(result);
}
