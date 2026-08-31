export type PartnerBookingAddOnSelection = Readonly<{
  key: string;
  quantity: number;
}>;

const PARTNER_ADD_ON_KEY = /^[a-z][a-z0-9_-]{1,79}$/u;
const MAX_PARTNER_ADD_ON_QUANTITY = 100;
const MAX_PARTNER_ADD_ON_SELECTIONS = 20;

/**
 * Converts transient checkbox state into the bounded, canonical draft shape.
 * Prices and labels are deliberately absent because the API resolves them from
 * the selected account's effective rate card.
 */
export function serializePartnerAddOnQuantities(
  quantities: Readonly<Record<string, number>>,
): readonly PartnerBookingAddOnSelection[] {
  return Object.freeze(
    Object.entries(quantities)
      .filter(
        ([key, quantity]) =>
          PARTNER_ADD_ON_KEY.test(key) &&
          Number.isSafeInteger(quantity) &&
          quantity >= 1 &&
          quantity <= MAX_PARTNER_ADD_ON_QUANTITY,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_PARTNER_ADD_ON_SELECTIONS)
      .map(([key, quantity]) => Object.freeze({ key, quantity })),
  );
}

export function clampPartnerAddOnQuantity(input: {
  value: number | undefined;
  minimum: number;
  maximum: number;
}): number {
  const minimum = Number.isSafeInteger(input.minimum)
    ? Math.max(1, Math.min(MAX_PARTNER_ADD_ON_QUANTITY, input.minimum))
    : 1;
  const maximum = Number.isSafeInteger(input.maximum)
    ? Math.max(minimum, Math.min(MAX_PARTNER_ADD_ON_QUANTITY, input.maximum))
    : minimum;
  const value = Number.isSafeInteger(input.value) ? input.value : minimum;
  return Math.min(maximum, Math.max(minimum, value ?? minimum));
}

function nonNegativeNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Keeps the two explicit review disclosures in the same scope payload used by validation. */
export function buildPartnerBookingScope(input: {
  itemCount: string;
  volumeCubicYards: string;
  restrictedItems: boolean;
  nonStandard: boolean;
}): Readonly<Record<string, unknown>> {
  const itemCount = nonNegativeNumber(input.itemCount);
  const volumeCubicYards = nonNegativeNumber(input.volumeCubicYards);
  return Object.freeze({
    ...(itemCount !== undefined ? { itemCount } : {}),
    ...(volumeCubicYards !== undefined ? { volumeCubicYards } : {}),
    ...(input.restrictedItems ? { restrictedItems: true } : {}),
    ...(input.nonStandard ? { nonStandard: true } : {}),
  });
}
