import type { ItemPoliciesPolicy, StandardJobPolicy } from "@/lib/policy";

type StandardJobInput = {
  jobTypes: string[];
  perceivedSize?: string | null;
  notes?: string | null;
  aiResult?: unknown;
  itemCount?: number | null;
};

type MatchedFee = { item: string; fee: number };

export type StandardJobEvaluation = {
  isStandard: boolean;
  reasons: string[];
  declinedItems: string[];
  extraFees: MatchedFee[];
  estimatedVolumeCubicYards: number | null;
  needsInPersonEstimate: boolean;
};

const WILDCARD_SERVICES = new Set([
  "junk_removal_primary",
  "junk_removal",
  "general_junk",
  "general-junk",
  "single_item",
  "single-item",
  "rubbish",
  "trash",
  "garbage",
  "household_waste",
  "household-waste"
]);

const SERVICE_ALIAS: Record<string, string[]> = {
  furniture: ["furniture"],
  appliances: ["appliances"],
  general_junk: [
    "general_junk",
    "general-junk",
    "junk_removal",
    "junk_removal_primary",
    "single_item",
    "single-item",
    "rubbish",
    "trash",
    "garbage",
    "household_waste",
    "household-waste"
  ],
  single_item: [
    "general_junk",
    "general-junk",
    "junk_removal",
    "junk_removal_primary",
    "single_item",
    "single-item",
    "rubbish",
    "trash",
    "garbage",
    "household_waste",
    "household-waste"
  ],
  rubbish: [
    "general_junk",
    "general-junk",
    "junk_removal",
    "junk_removal_primary",
    "single_item",
    "single-item",
    "rubbish",
    "trash",
    "garbage",
    "household_waste",
    "household-waste"
  ],
  trash: [
    "general_junk",
    "general-junk",
    "junk_removal",
    "junk_removal_primary",
    "single_item",
    "single-item",
    "rubbish",
    "trash",
    "garbage",
    "household_waste",
    "household-waste"
  ],
  garbage: [
    "general_junk",
    "general-junk",
    "junk_removal",
    "junk_removal_primary",
    "single_item",
    "single-item",
    "rubbish",
    "trash",
    "garbage",
    "household_waste",
    "household-waste"
  ],
  household_waste: [
    "general_junk",
    "general-junk",
    "junk_removal",
    "junk_removal_primary",
    "single_item",
    "single-item",
    "rubbish",
    "trash",
    "garbage",
    "household_waste",
    "household-waste"
  ],
  yard_waste: ["yard_waste", "yard-waste"],
  construction_debris: ["construction_debris", "construction-debris"],
  hot_tub_playset: ["hot_tub", "hot-tub", "hot_tub_playset"],
  business_commercial: ["business_commercial", "commercial", "business"]
};

const LOAD_TO_CUBIC_YARDS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeJobTypes(input: string[]): string[] {
  return input.map(normalizeKey).filter((entry) => entry.length > 0);
}

function estimateLoadFraction(perceivedSize: string | null | undefined): number | null {
  switch ((perceivedSize ?? "").toLowerCase()) {
    case "few_items":
      return 0.25;
    case "small_area":
      return 0.5;
    case "one_room_or_half_garage":
      return 0.75;
    case "big_cleanout":
      return 1.5;
    case "not_sure":
      return null;
    default:
      return null;
  }
}

function resolveLoadFraction(aiResult: unknown, perceivedSize: string | null | undefined): number | null {
  if (isRecord(aiResult)) {
    const load = aiResult["loadFractionEstimate"];
    if (typeof load === "number" && Number.isFinite(load) && load > 0) {
      return load;
    }
  }
  return estimateLoadFraction(perceivedSize ?? null);
}

function resolveNeedsInPersonEstimate(aiResult: unknown): boolean {
  if (!isRecord(aiResult)) return false;
  return aiResult["needsInPersonEstimate"] === true;
}

function buildSearchText(jobTypes: string[], notes?: string | null, aiResult?: unknown): string {
  const parts: string[] = [];
  for (const type of jobTypes) {
    parts.push(type.replace(/_/g, " "));
  }
  if (typeof notes === "string") {
    parts.push(notes);
  }
  if (isRecord(aiResult)) {
    if (typeof aiResult["reasonSummary"] === "string") parts.push(aiResult["reasonSummary"]);
    if (typeof aiResult["displayTierLabel"] === "string") parts.push(aiResult["displayTierLabel"]);
  }
  return parts.join(" ").toLowerCase();
}

function matchItemPolicies(text: string, policy: ItemPoliciesPolicy): {
  declined: string[];
  extraFees: MatchedFee[];
} {
  const declined: string[] = [];
  const extraFees: MatchedFee[] = [];
  const normalizedText = text.toLowerCase();

  for (const item of policy.declined) {
    const normalized = item.toLowerCase().trim();
    if (normalized.length > 0 && normalizedText.includes(normalized)) {
      declined.push(item);
    }
  }

  for (const fee of policy.extraFees) {
    const normalized = fee.item.toLowerCase().trim();
    if (normalized.length > 0 && normalizedText.includes(normalized)) {
      extraFees.push(fee);
    }
  }

  return { declined, extraFees };
}

function isServiceAllowed(jobTypes: string[], policy: StandardJobPolicy): boolean {
  const allowedRaw = policy.allowedServices ?? [];
  if (!allowedRaw.length) return true;
  const allowed = new Set(allowedRaw.map(normalizeKey));
  const hasWildcard = [...allowed].some((entry) => WILDCARD_SERVICES.has(entry));
  if (hasWildcard) return true;

  const normalizedTypes = normalizeJobTypes(jobTypes);
  for (const type of normalizedTypes) {
    const aliases = SERVICE_ALIAS[type] ?? [type];
    const matches = aliases.some((alias) => allowed.has(normalizeKey(alias)));
    if (!matches) {
      return false;
    }
  }
  return true;
}

export function evaluateStandardJob(
  input: StandardJobInput,
  standardPolicy: StandardJobPolicy,
  itemPolicy: ItemPoliciesPolicy
): StandardJobEvaluation {
  const reasons: string[] = [];
  const normalizedTypes = normalizeJobTypes(input.jobTypes);
  const needsInPersonEstimate = resolveNeedsInPersonEstimate(input.aiResult ?? null);

  if (!isServiceAllowed(normalizedTypes, standardPolicy)) {
    reasons.push("service_not_allowed");
  }

  const loadFraction = resolveLoadFraction(input.aiResult ?? null, input.perceivedSize ?? null);
  const estimatedVolumeCubicYards =
    typeof loadFraction === "number" ? Math.round(loadFraction * LOAD_TO_CUBIC_YARDS * 10) / 10 : null;
  if (
    typeof estimatedVolumeCubicYards === "number" &&
    Number.isFinite(estimatedVolumeCubicYards) &&
    standardPolicy.maxVolumeCubicYards > 0 &&
    estimatedVolumeCubicYards > standardPolicy.maxVolumeCubicYards
  ) {
    reasons.push("volume_exceeds_limit");
  }

  if (
    typeof input.itemCount === "number" &&
    Number.isFinite(input.itemCount) &&
    standardPolicy.maxItemCount > 0 &&
    input.itemCount > standardPolicy.maxItemCount
  ) {
    reasons.push("item_count_exceeds_limit");
  }

  if (needsInPersonEstimate) {
    reasons.push("needs_in_person_estimate");
  }

  const searchText = buildSearchText(normalizedTypes, input.notes ?? null, input.aiResult ?? null);
  const { declined, extraFees } = matchItemPolicies(searchText, itemPolicy);
  if (declined.length) {
    reasons.push("declined_items");
  }

  return {
    isStandard: reasons.length === 0,
    reasons,
    declinedItems: declined,
    extraFees,
    estimatedVolumeCubicYards,
    needsInPersonEstimate
  };
}

export function buildStandardJobMessage(evaluation: StandardJobEvaluation): string {
  if (evaluation.declinedItems.length > 0) {
    const list = evaluation.declinedItems.join(", ");
    return `We may not be able to take: ${list}. We'll confirm options by text.`;
  }
  if (evaluation.reasons.includes("volume_exceeds_limit") || evaluation.reasons.includes("item_count_exceeds_limit")) {
    return "This job looks larger than average. We'll confirm details by text.";
  }
  if (evaluation.reasons.includes("service_not_allowed")) {
    return "This request needs a quick review. We'll confirm details by text.";
  }
  if (evaluation.reasons.includes("needs_in_person_estimate")) {
    return "We may need a quick review before booking. We'll confirm details by text.";
  }
  return "This request needs a quick review. We'll confirm details by text.";
}
