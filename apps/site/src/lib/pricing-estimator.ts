export type LoadTierId = "quarter" | "half" | "threeQuarter" | "full";

export type LoadTier = Readonly<{
  id: LoadTierId;
  label: string;
  sliderValue: number;
  min: number;
  max: number;
}>;

export const LOAD_TIERS: readonly LoadTier[] = [
  { id: "quarter", label: "¼ load", sliderValue: 25, min: 175, max: 250 },
  { id: "half", label: "½ load", sliderValue: 50, min: 350, max: 500 },
  { id: "threeQuarter", label: "¾ load", sliderValue: 75, min: 525, max: 700 },
  { id: "full", label: "Full load", sliderValue: 100, min: 700, max: 900 }
];

export type AddonId = "mattress" | "paint" | "tire";

export type Addon = Readonly<{
  id: AddonId;
  label: string;
  unitPrice: number;
}>;

export const ADDONS: readonly Addon[] = [
  { id: "mattress", label: "Mattresses", unitPrice: 30 },
  { id: "paint", label: "Paint cans", unitPrice: 10 },
  { id: "tire", label: "Tires", unitPrice: 10 }
];

export const PRICING_ESTIMATOR_QUERY_KEYS = {
  load: "pe_load",
  mattress: "pe_mattress",
  paint: "pe_paint",
  tire: "pe_tire"
} as const;

export function getTierBySliderValue(value: number): LoadTier {
  const match = LOAD_TIERS.find((tier) => tier.sliderValue === value);
  return match ?? LOAD_TIERS[0]!;
}

export function getTierById(id: LoadTierId): LoadTier {
  const match = LOAD_TIERS.find((tier) => tier.id === id);
  return match ?? LOAD_TIERS[0]!;
}

export function normalizeTierId(value: string | null): LoadTierId | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "quarter" || trimmed === "half" || trimmed === "threeQuarter" || trimmed === "full") {
    return trimmed;
  }
  return null;
}

export function computeAddonTotal(addons: Record<AddonId, number>): number {
  return ADDONS.reduce((total, addon) => total + addon.unitPrice * (addons[addon.id] ?? 0), 0);
}
