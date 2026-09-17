export type QuoteState =
  | { status: "idle" | "loading" }
  | {
      status: "ready";
      quoteId: string | null;
      baseLow: number;
      baseHigh: number;
      discountPercent: number;
      discountAmount: number;
      low: number;
      high: number;
      tier: string;
      reason: string;
      needsInPersonEstimate: boolean;
      addOnTotal: number;
      isRoughEstimate?: boolean;
      estimateDisclaimer?: string;
      weightRisk?: "normal" | "low" | "medium" | "high";
      pricingFactors?: string[];
      mediaAnalysis?: {
        source?: string;
        visibleVolumeRange?: string;
        mergedVolumeRange?: string;
        visibleMattressCount?: number;
        visiblePaintCanCount?: number;
        confidence?: "low" | "medium" | "high";
        missingViews?: string[];
      };
    }
  | { status: "error"; message: string };

export type QuoteMediaAnalysis = Extract<
  QuoteState,
  { status: "ready" }
>["mediaAnalysis"];

export type AvailabilitySlot = {
  startAt: string;
  endAt: string;
  reason: string;
};
export type AvailabilityDay = { date: string; slots: AvailabilitySlot[] };
