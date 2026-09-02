export type PartnerBookingAddOnSelection = Readonly<{
  key: string;
  quantity: number;
}>;

export const PARTNER_HAZARD_OPTIONS = [
  { key: "chemicals", label: "Chemicals or solvents" },
  { key: "paint", label: "Paint or coatings" },
  { key: "fuel_oil", label: "Fuel, oil, or automotive fluids" },
  { key: "batteries", label: "Batteries or powered equipment" },
  { key: "pressurized", label: "Pressurized containers" },
  { key: "biohazard", label: "Medical, biological, or contaminated material" },
  { key: "asbestos_lead", label: "Possible asbestos or lead material" },
  { key: "unknown", label: "Unknown or unlabelled material" },
] as const;

export const PARTNER_EQUIPMENT_OPTIONS = [
  { key: "stairs", label: "Stair carry" },
  { key: "elevator", label: "Elevator coordination" },
  { key: "loading_dock", label: "Loading dock" },
  { key: "lift_gate", label: "Lift gate or loading equipment" },
  { key: "heavy_lift", label: "Multiple-person or heavy lift" },
  { key: "disassembly", label: "Disassembly" },
  { key: "demolition", label: "Light demolition" },
] as const;

const HAZARD_KEYS = new Set<string>(
  PARTNER_HAZARD_OPTIONS.map((option) => option.key),
);
const EQUIPMENT_KEYS = new Set<string>(
  PARTNER_EQUIPMENT_OPTIONS.map((option) => option.key),
);

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
  hazardCategories?: readonly string[];
  equipmentNeeds?: readonly string[];
  requiredCompletionDate?: string;
  requiredCompletionTime?: string;
  multiStop?: boolean;
  multiStopDetails?: string;
  alternateContactName?: string;
  alternateContactPhone?: string;
  alternateContactEmail?: string;
}): Readonly<Record<string, unknown>> {
  const itemCount = nonNegativeNumber(input.itemCount);
  const volumeCubicYards = nonNegativeNumber(input.volumeCubicYards);
  const hazardCategories = [...new Set(input.hazardCategories ?? [])]
    .filter((key) => HAZARD_KEYS.has(key))
    .sort();
  const equipmentNeeds = [...new Set(input.equipmentNeeds ?? [])]
    .filter((key) => EQUIPMENT_KEYS.has(key))
    .sort();
  const requiredCompletionDate = /^\d{4}-\d{2}-\d{2}$/u.test(
    input.requiredCompletionDate?.trim() ?? "",
  )
    ? input.requiredCompletionDate?.trim()
    : undefined;
  const requiredCompletionTime = /^([01]\d|2[0-3]):[0-5]\d$/u.test(
    input.requiredCompletionTime?.trim() ?? "",
  )
    ? input.requiredCompletionTime?.trim()
    : undefined;
  const multiStopDetails = input.multiStopDetails?.trim().slice(0, 1_000);
  const alternateContact = {
    name: input.alternateContactName?.trim().slice(0, 200) ?? "",
    phone: input.alternateContactPhone?.trim().slice(0, 50) ?? "",
    email: input.alternateContactEmail?.trim().slice(0, 320) ?? "",
  };
  const hasAlternateContact = Boolean(
    alternateContact.name || alternateContact.phone || alternateContact.email,
  );
  return Object.freeze({
    ...(itemCount !== undefined ? { itemCount } : {}),
    ...(volumeCubicYards !== undefined ? { volumeCubicYards } : {}),
    ...(input.restrictedItems || hazardCategories.length > 0
      ? { restrictedItems: true }
      : {}),
    ...(hazardCategories.length > 0 ? { hazardCategories } : {}),
    ...(input.nonStandard || equipmentNeeds.length > 0 || input.multiStop
      ? { nonStandard: true }
      : {}),
    ...(equipmentNeeds.length > 0 ? { equipmentNeeds } : {}),
    ...(requiredCompletionDate
      ? {
          requiredCompletion: {
            localDate: requiredCompletionDate,
            ...(requiredCompletionTime
              ? { localTime: requiredCompletionTime }
              : {}),
          },
        }
      : {}),
    ...(input.multiStop
      ? {
          multiStop: true,
          ...(multiStopDetails ? { multiStopDetails } : {}),
        }
      : {}),
    ...(hasAlternateContact ? { alternateContact } : {}),
  });
}
